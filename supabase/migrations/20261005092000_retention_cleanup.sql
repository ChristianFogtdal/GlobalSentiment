create table if not exists public.retention_cleanup_log (
    id bigint generated always as identity primary key,
    started_at timestamptz not null default now(),
    cutoff timestamptz not null,
    removed jsonb not null
);
create index if not exists retention_cleanup_log_started_at_idx on public.retention_cleanup_log (started_at);
alter table public.retention_cleanup_log enable row level security;
revoke all on public.retention_cleanup_log from public, anon, authenticated;
grant select on public.retention_cleanup_log to service_role;

insert into public.app_settings (key, value) values ('retention_enabled', 'false') on conflict (key) do nothing;

create or replace function public.preview_sentiment_retention()
returns table (table_name text, rows_to_delete bigint)
language sql stable security definer
set search_path = pg_catalog, public
as $$
    with expired as (
        select uri from public.bluesky_posts
        where published_at < now() - interval '30 days'
    )
    select 'bluesky_posts', count(*) from expired
    union all select 'post_analyses_v2', count(*) from public.post_analyses_v2
        where post_uri in (select uri from expired)
    union all select 'post_analyses', count(*) from public.post_analyses pa
        where post_uri in (select uri from expired)
           or (created_at < now() - interval '30 days' and not exists (select 1 from public.bluesky_posts bp where bp.uri = pa.post_uri))
    union all select 'analysis_content_cache', count(*) from public.analysis_content_cache
        where created_at < now() - interval '30 days'
    union all select 'analyse_posts_invocation_log', 0::bigint
    union all select 'dashboard_v2_cache_refresh_log', 0::bigint
    union all select 'retention_cleanup_log', 0::bigint;
$$;

create or replace function public.cleanup_sentiment_history(p_batch_size integer default 1000)
returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public
set lock_timeout = '2s'
set statement_timeout = '60s'
as $$
declare
    retention_cutoff timestamptz := now() - interval '30 days';
    removed jsonb := '{}'::jsonb;
    affected integer;
    expired_uris text[];
begin
    if p_batch_size is null or p_batch_size < 1 or p_batch_size > 10000 then
        raise exception 'Batch size must be between 1 and 10000';
    end if;
    if not exists (select 1 from public.app_settings where key = 'retention_enabled' and value = 'true') then
        return jsonb_build_object('status', 'disabled');
    end if;
    if not pg_try_advisory_xact_lock(hashtext('sentiment_retention')) then
        return jsonb_build_object('status', 'already_running');
    end if;

    select array_agg(uri) into expired_uris from (
        select uri from public.bluesky_posts
        where published_at < retention_cutoff
        order by published_at, uri
        limit p_batch_size for update skip locked
    ) expired;

    delete from public.post_analyses_v2 where id in (
        select id from public.post_analyses_v2 where post_uri = any(expired_uris)
        order by id limit p_batch_size for update skip locked
    );
    get diagnostics affected = row_count;
    removed := removed || jsonb_build_object('post_analyses_v2', affected);

    delete from public.post_analyses where id in (
        select id from public.post_analyses pa
        where post_uri = any(expired_uris)
        order by id limit p_batch_size for update skip locked
    );
    get diagnostics affected = row_count;
    removed := removed || jsonb_build_object('post_analyses', affected);

    delete from public.bluesky_posts bp
    where uri = any(expired_uris)
      and not exists (select 1 from public.post_analyses_v2 where post_uri = bp.uri)
      and not exists (select 1 from public.post_analyses where post_uri = bp.uri);
    get diagnostics affected = row_count;
    removed := removed || jsonb_build_object('bluesky_posts', affected);

    delete from public.post_analyses where id in (
        select id from public.post_analyses pa where created_at < retention_cutoff
          and not exists (select 1 from public.bluesky_posts bp where bp.uri = pa.post_uri)
        order by created_at limit p_batch_size for update skip locked
    );
    get diagnostics affected = row_count;
    removed := jsonb_set(removed, '{post_analyses}', to_jsonb((removed->>'post_analyses')::integer + affected));

    delete from public.analysis_content_cache where cache_key in (
        select cache_key from public.analysis_content_cache where created_at < retention_cutoff
        order by created_at limit p_batch_size for update skip locked
    );
    get diagnostics affected = row_count;
    removed := removed || jsonb_build_object('analysis_content_cache', affected);

    removed := removed || jsonb_build_object('analyse_posts_invocation_log', 0,
        'dashboard_v2_cache_refresh_log', 0, 'retention_cleanup_log', 0);
    insert into public.retention_cleanup_log (cutoff, removed) values (retention_cutoff, removed);
    raise log 'Sentiment retention cutoff %, removed %', retention_cutoff, removed;
    return removed;
end;
$$;

revoke all on function public.preview_sentiment_retention() from public, anon, authenticated;
revoke all on function public.cleanup_sentiment_history(integer) from public, anon, authenticated;
grant execute on function public.preview_sentiment_retention() to service_role;
grant execute on function public.cleanup_sentiment_history(integer) to service_role;