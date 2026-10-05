create table if not exists public.pipeline_run_state (
    pipeline text primary key check (pipeline in ('bluesky_ingestion', 'analysis')),
    started_at timestamptz not null
);

create table if not exists public.analysis_content_cache (
    cache_key text primary key check (cache_key ~ '^[0-9a-f]{64}$'),
    status text not null check (status in ('processing', 'complete', 'failed')),
    result jsonb,
    error_message text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (status <> 'complete' or result is not null)
);

alter table public.pipeline_run_state enable row level security;
alter table public.analysis_content_cache enable row level security;
revoke all on public.pipeline_run_state, public.analysis_content_cache from public, anon, authenticated;
grant select, insert, update, delete on public.pipeline_run_state, public.analysis_content_cache to service_role;

alter table public.post_analyses_v2 add column if not exists analysis_cache_key text;

create or replace function public.begin_pipeline_run(p_pipeline text, p_interval_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    admitted integer;
    minimum_interval integer;
begin
    minimum_interval := case p_pipeline when 'bluesky_ingestion' then 3600 when 'analysis' then 600 end;
    if minimum_interval is null or p_interval_seconds is null or p_interval_seconds < minimum_interval then
        raise exception 'Invalid pipeline interval';
    end if;
    insert into public.pipeline_run_state (pipeline, started_at)
    values (p_pipeline, clock_timestamp())
    on conflict (pipeline) do update set started_at = excluded.started_at
        where pipeline_run_state.started_at < date_bin(make_interval(secs => p_interval_seconds), excluded.started_at, '2000-01-01'::timestamptz)
            and pipeline_run_state.started_at <= excluded.started_at - interval '3 minutes';
    get diagnostics admitted = row_count;
    return admitted = 1;
end;
$$;

create or replace function public.claim_post_analysis(
    p_post_uri text, p_prompt_version text, p_cache_key text, p_skip_reason text default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    source public.bluesky_posts%rowtype;
    cached public.analysis_content_cache%rowtype;
    inserted integer;
    cached_result public.post_analyses_v2%rowtype;
begin
    if p_prompt_version is distinct from public.get_active_prompt_version() then
        raise exception 'Active prompt version changed';
    end if;
    select * into source from public.bluesky_posts where uri = p_post_uri for update;
    if not found then return 'skipped'; end if;
     if source.published_at < now() - interval '30 days'
         or source.published_at > now()
       or source.has_v2_analysis
       or exists (select 1 from public.post_analyses_v2 where post_uri = p_post_uri) then
        return 'skipped';
    end if;
    if p_skip_reason is not null then
        insert into public.post_analyses_v2 (post_uri, prompt_version, status, error_message)
        values (p_post_uri, p_prompt_version, 'failed', left(p_skip_reason, 500));
        return 'filtered';
    end if;

    insert into public.analysis_content_cache (cache_key, status)
    values (p_cache_key, 'processing') on conflict (cache_key) do nothing;
    get diagnostics inserted = row_count;
    if inserted = 1 then
        insert into public.post_analyses_v2 (post_uri, prompt_version, status, analysis_cache_key)
        values (p_post_uri, p_prompt_version, 'processing', p_cache_key);
        return 'claimed';
    end if;

    select * into cached from public.analysis_content_cache where cache_key = p_cache_key;
    if cached.status = 'processing' then return 'skipped'; end if;
    if cached.status = 'failed' or cached.created_at < now() - interval '30 days' then
        insert into public.post_analyses_v2 (post_uri, prompt_version, status, error_message)
        values (p_post_uri, p_prompt_version, 'failed', 'Cached attempt failed; automatic retry disabled');
        return 'filtered';
    end if;
    select * into cached_result from jsonb_populate_record(null::public.post_analyses_v2, cached.result);
    insert into public.post_analyses_v2 (
        post_uri, prompt_version, status, provider, deployment, model, sentiment,
        sentiment_score, emotions, topics, tools_mentioned, ai_tooling_stance,
        confidence, rationale, content_type, content_type_reason, processed_at
    ) values (
        p_post_uri, p_prompt_version, 'complete', cached_result.provider,
        cached_result.deployment, cached_result.model, cached_result.sentiment,
        cached_result.sentiment_score, cached_result.emotions, cached_result.topics,
        cached_result.tools_mentioned, cached_result.ai_tooling_stance,
        cached_result.confidence, cached_result.rationale, cached_result.content_type,
        cached_result.content_type_reason, now()
    );
    return 'cached';
end;
$$;

create or replace function public.persist_analysis_cache()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
    update public.analysis_content_cache
    set status = new.status, updated_at = now(), error_message = new.error_message,
        result = case when new.status = 'complete' then jsonb_build_object(
            'provider', new.provider, 'deployment', new.deployment, 'model', new.model,
            'sentiment', new.sentiment, 'sentiment_score', new.sentiment_score,
            'emotions', new.emotions, 'topics', new.topics, 'tools_mentioned', new.tools_mentioned,
            'ai_tooling_stance', new.ai_tooling_stance, 'confidence', new.confidence,
            'rationale', new.rationale, 'content_type', new.content_type,
            'content_type_reason', new.content_type_reason
        ) else null end
    where cache_key = new.analysis_cache_key and status = 'processing';
    return new;
end;
$$;

drop trigger if exists post_analyses_v2_persist_cache on public.post_analyses_v2;
create trigger post_analyses_v2_persist_cache
after update of status on public.post_analyses_v2
for each row when (new.analysis_cache_key is not null and old.status = 'processing' and new.status in ('complete', 'failed'))
execute function public.persist_analysis_cache();

create or replace function public.select_unanalysed_posts(p_prompt_version text, p_limit integer)
returns table (uri text, post_text text, original_language text)
language sql stable
as $$
    select bp.uri, bp.post_text, bp.original_language
    from public.bluesky_posts bp
    where bp.has_v2_analysis = false
            and bp.published_at >= now() - interval '30 days'
            and bp.published_at <= now()
        order by bp.published_at desc, bp.uri
    limit least(greatest(p_limit, 0), 20)
$$;

create or replace function public.reclaim_stuck_processing_analyses(p_stuck_after interval default interval '10 minutes')
returns integer
language plpgsql
as $$
declare
    affected integer;
begin
    if p_stuck_after is null or p_stuck_after < interval '10 minutes' then
        raise exception 'Stale threshold must be at least ten minutes';
    end if;
    update public.post_analyses_v2 set status = 'failed',
        error_message = 'Attempt abandoned; automatic retry disabled', updated_at = now()
    where id in (
        select id from public.post_analyses_v2
        where status = 'processing' and updated_at < now() - p_stuck_after
        order by updated_at limit 1000 for update skip locked
    );
    get diagnostics affected = row_count;
    return affected;
end;
$$;

revoke all on function public.begin_pipeline_run(text, integer) from public, anon, authenticated;
revoke all on function public.claim_post_analysis(text, text, text, text) from public, anon, authenticated;
revoke all on function public.persist_analysis_cache() from public, anon, authenticated;
revoke all on function public.select_unanalysed_posts(text, integer) from public, anon, authenticated;
revoke all on function public.reclaim_stuck_processing_analyses(interval) from public, anon, authenticated;
grant execute on function public.begin_pipeline_run(text, integer) to service_role;
grant execute on function public.claim_post_analysis(text, text, text, text) to service_role;
grant execute on function public.select_unanalysed_posts(text, integer) to service_role;
grant execute on function public.reclaim_stuck_processing_analyses(interval) to service_role;