update public.app_settings set value='false',updated_at=now() where key='retention_enabled';

create or replace function public.analysis_owner_active(p_analysis_id bigint)
returns boolean language sql volatile
set search_path = pg_catalog, public
as $$
    select exists(select 1 from public.post_analyses_v2 pa where id=p_analysis_id and status='processing'
        and public.pipeline_lease_valid('analysis',worker_token,worker_fence));
$$;
revoke all on function public.analysis_owner_active(bigint) from public,anon,authenticated;

create or replace function public.preview_sentiment_retention()
returns table(table_name text,rows_to_delete bigint) language sql security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
    with expired as (
        select uri from public.bluesky_posts bp where published_at<now()-interval '720 hours'
        and not exists(select 1 from public.post_analyses_v2 pa where pa.post_uri=bp.uri and public.analysis_owner_active(pa.id))
    )
    select 'bluesky_posts',count(*) from expired
    union all select 'post_analyses_v2',count(*) from public.post_analyses_v2 where post_uri in(select uri from expired)
    union all select 'post_analyses',count(*) from public.post_analyses pa where post_uri in(select uri from expired)
        or (created_at<now()-interval '720 hours' and not exists(select 1 from public.bluesky_posts where uri=pa.post_uri))
    union all select 'analysis_content_cache',count(*) from public.analysis_content_cache
        where created_at<now()-interval '720 hours' and not public.analysis_owner_active(owner_analysis_id)
    union all select 'analyse_posts_invocation_log',0::bigint
    union all select 'dashboard_v2_cache_refresh_log',0::bigint
    union all select 'retention_cleanup_log',0::bigint;
$$;

create or replace function public.cleanup_sentiment_history(p_batch_size integer default 1000)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
    retention_cutoff timestamptz := now()-interval '720 hours';
    removed jsonb := '{}'::jsonb;
    affected integer;
    expired_uris text[];
begin
    if p_batch_size is null or p_batch_size<1 or p_batch_size>10000 then raise exception 'Invalid retention batch size'; end if;
    if not exists(select 1 from public.app_settings where key='retention_enabled' and value='true') then
        return jsonb_build_object('status','disabled');
    end if;
    if current_setting('statement_timeout')::interval <= interval '0 seconds'
       or current_setting('statement_timeout')::interval > interval '60 seconds'
       or current_setting('lock_timeout')::interval <= interval '0 seconds'
       or current_setting('lock_timeout')::interval > interval '2 seconds' then
        raise exception 'Set caller statement_timeout (<=60s) and lock_timeout (<=2s) before cleanup';
    end if;
    if not pg_try_advisory_xact_lock(78123901) then return jsonb_build_object('status','already_running'); end if;
    if exists(select 1 from pg_constraint where contype='f' and confrelid in (
        'public.bluesky_posts'::regclass,'public.post_analyses'::regclass,'public.post_analyses_v2'::regclass,'public.analysis_content_cache'::regclass
    ) and conrelid not in (
        'public.bluesky_posts'::regclass,'public.post_analyses'::regclass,'public.post_analyses_v2'::regclass,'public.analysis_content_cache'::regclass
    )) then raise exception 'Unreviewed incoming foreign key; retention refused'; end if;
    if exists(select 1 from pg_trigger where not tgisinternal and (tgtype & 8)<>0 and tgrelid in (
        'public.bluesky_posts'::regclass,'public.post_analyses'::regclass,'public.post_analyses_v2'::regclass,'public.analysis_content_cache'::regclass
    )) then raise exception 'Unreviewed deletion trigger; retention refused'; end if;

    select array_agg(uri) into expired_uris from (
        select uri from public.bluesky_posts bp where published_at<retention_cutoff
          and not exists(select 1 from public.post_analyses_v2 pa where pa.post_uri=bp.uri and public.analysis_owner_active(pa.id))
        order by published_at,uri limit p_batch_size for update skip locked
    ) expired;
    delete from public.post_analyses_v2 where id in (
        select id from public.post_analyses_v2 where post_uri=any(expired_uris)
        order by id limit p_batch_size for update skip locked
    );
    get diagnostics affected=row_count;
    removed:=removed||jsonb_build_object('post_analyses_v2',affected);
    delete from public.post_analyses where id in (
        select id from public.post_analyses where post_uri=any(expired_uris)
        order by id limit p_batch_size for update skip locked
    );
    get diagnostics affected=row_count;
    removed:=removed||jsonb_build_object('post_analyses',affected);
    delete from public.bluesky_posts bp where uri=any(expired_uris)
      and not exists(select 1 from public.post_analyses_v2 where post_uri=bp.uri)
      and not exists(select 1 from public.post_analyses where post_uri=bp.uri);
    get diagnostics affected=row_count;
    removed:=removed||jsonb_build_object('bluesky_posts',affected);
    delete from public.post_analyses where id in (
        select id from public.post_analyses pa where created_at<retention_cutoff
        and not exists(select 1 from public.bluesky_posts where uri=pa.post_uri)
        order by created_at limit p_batch_size for update skip locked
    );
    get diagnostics affected=row_count;
    removed:=jsonb_set(removed,'{post_analyses}',to_jsonb((removed->>'post_analyses')::integer+affected));
    delete from public.analysis_content_cache where cache_key in (
        select cache_key from public.analysis_content_cache where created_at<retention_cutoff
        and not public.analysis_owner_active(owner_analysis_id)
        order by created_at limit p_batch_size for update skip locked
    );
    get diagnostics affected=row_count;
    removed:=removed||jsonb_build_object('analysis_content_cache',affected,'analyse_posts_invocation_log',0,
        'dashboard_v2_cache_refresh_log',0,'retention_cleanup_log',0);
    insert into public.retention_cleanup_log(cutoff,removed) values(retention_cutoff,removed);
    return removed;
end;
$$;
revoke all on function public.cleanup_sentiment_history(integer),public.preview_sentiment_retention() from public,anon,authenticated;
grant execute on function public.cleanup_sentiment_history(integer),public.preview_sentiment_retention() to service_role;