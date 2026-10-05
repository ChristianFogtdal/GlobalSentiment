create or replace view public.recent_sentiment_reporting as
select v2.post_uri, v2.sentiment, v2.sentiment_score,
    round((v2.sentiment_score + 1) * 50)::integer as display_score,
    v2.confidence, v2.emotions, v2.topics, v2.ai_tooling_stance,
    v2.rationale, v2.provider, v2.deployment, v2.model, v2.prompt_version,
    v2.processed_at, bp.post_text, bp.author_handle, bp.original_language,
    bp.published_at, bp.source_url
from public.post_analyses_v2 v2 join public.bluesky_posts bp on bp.uri = v2.post_uri
where v2.status = 'complete' and coalesce(v2.content_type, 'organic') = 'organic'
    and bp.published_at >= now() - interval '30 days'
    and bp.published_at <= now();

revoke all on public.recent_sentiment_reporting from public, anon, authenticated;
grant select on public.recent_sentiment_reporting to service_role;

create or replace function public.compute_dashboard_v2_aggregate()
returns jsonb language sql stable security definer
set search_path = pg_catalog, public
set statement_timeout = '20s'
as $$
    with scoped as materialized (select * from public.recent_sentiment_reporting),
    totals as (
        select count(*) as count, round(avg(display_score))::integer as avg_score,
            round(avg(confidence) * 100)::integer as avg_confidence from scoped
    ),
    stances as (
        select ai_tooling_stance as stance, count(*) as count from scoped
        group by ai_tooling_stance
        order by (ai_tooling_stance is not null and ai_tooling_stance <> 'not_applicable') desc, count(*) desc
        limit 1
    ),
    topics as (
        select case jsonb_typeof(entry) when 'string' then entry #>> '{}' else entry->>'name' end as name,
            count(*) as volume, round(avg(display_score))::integer as avg_score
        from scoped, jsonb_array_elements(topics) entry group by 1
    ),
    emotions as (
        select case jsonb_typeof(entry) when 'string' then entry #>> '{}' else entry->>'name' end as name,
            count(*) as count from scoped, jsonb_array_elements(emotions) entry group by 1
    ),
    trend as (
        select date_trunc('hour', published_at) as bucket_start, count(*) as count,
            case when count(*) >= 3 then round(avg(display_score)) else null end as score,
            avg(display_score) as raw_avg
        from scoped group by 1
    ),
    recent as (select * from scoped order by processed_at desc nulls last limit 200)
    select jsonb_build_object(
        'prompt_version', public.get_active_prompt_version(), 'generated_at', now(),
        'window_start', now() - interval '30 days',
        'totals', (select to_jsonb(totals) from totals) || jsonb_build_object(
            'stance', (select stance from stances), 'stance_count', coalesce((select count from stances),0)),
        'topics', coalesce((select jsonb_agg(to_jsonb(topics) || jsonb_build_object(
            'impact', round((avg_score - (select avg_score from totals))::numeric,1),
            'low_sample', volume < 3) order by volume desc) from topics where name is not null and name <> ''), '[]'::jsonb),
        'emotions', coalesce((select jsonb_agg(to_jsonb(emotions) order by count desc) from emotions where name is not null and name <> ''), '[]'::jsonb),
        'trend', coalesce((select jsonb_agg(to_jsonb(trend) order by bucket_start) from trend), '[]'::jsonb),
        'recent', coalesce((select jsonb_agg(to_jsonb(recent) order by processed_at desc nulls last) from recent), '[]'::jsonb)
    );
$$;

create or replace function public.compute_top_topic_trends()
returns jsonb language sql stable security definer
set search_path = pg_catalog, public
set statement_timeout = '20s'
as $$
    with expanded as (
        select distinct post_uri, display_score, published_at,
            case jsonb_typeof(entry) when 'string' then entry #>> '{}' else entry->>'name' end as name
        from public.recent_sentiment_reporting, jsonb_array_elements(topics) entry
    ),
    top_topics as (
        select name from expanded where name is not null and name <> '' and lower(name) <> 'other'
        group by name having count(*) >= 5 order by count(*) desc, name limit 20
    ),
    buckets as (
        select name, date_trunc('hour', published_at) as bucket_start, count(*) as count,
            case when count(*) >= 3 then round(avg(display_score)) else null end as score,
            avg(display_score) as raw_avg
        from expanded where name in (select name from top_topics) group by name, date_trunc('hour', published_at)
    ),
    trends as (
        select name, jsonb_agg(to_jsonb(buckets) - 'name' order by bucket_start) as trend
        from buckets group by name
    )
    select coalesce(jsonb_object_agg(name, trend), '{}'::jsonb) from trends;
$$;

create or replace function public.get_dashboard_v2_trend(p_topic text default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
set statement_timeout = '20s'
as $$
declare
    cached jsonb;
    trend jsonb;
begin
    select trend_by_topic -> p_topic into cached from public.dashboard_v2_cache
    order by generation desc limit 1;
    if cached is not null then
        return jsonb_build_object('prompt_version',public.get_active_prompt_version(),'topic',p_topic,'trend',cached);
    end if;
    with buckets as (
        select date_trunc('hour', published_at) as bucket_start, count(*) as count,
            case when count(*) >= 3 then round(avg(display_score)) else null end as score,
            avg(display_score) as raw_avg
        from public.recent_sentiment_reporting
        where p_topic is null
           or topics @> jsonb_build_array(jsonb_build_object('name',p_topic))
           or topics @> jsonb_build_array(to_jsonb(p_topic))
        group by 1
    )
    select coalesce(jsonb_agg(to_jsonb(buckets) order by bucket_start),'[]'::jsonb) into trend from buckets;
    return jsonb_build_object('prompt_version',public.get_active_prompt_version(),'topic',p_topic,'trend',trend);
end;
$$;

revoke all on function public.compute_dashboard_v2_aggregate() from public, anon, authenticated;
revoke all on function public.compute_top_topic_trends() from public, anon, authenticated;
revoke all on function public.get_dashboard_v2_trend(text) from public;
grant execute on function public.compute_dashboard_v2_aggregate() to service_role;
grant execute on function public.compute_top_topic_trends() to service_role;
grant execute on function public.get_dashboard_v2_trend(text) to anon, authenticated, service_role;

create or replace function public.refresh_dashboard_v2_cache()
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
set statement_timeout = '240s'
as $$
declare
    started timestamptz := clock_timestamp();
    payload jsonb;
    trends jsonb;
    generation_id bigint;
    source_count bigint;
    source_processed_at timestamptz;
    failure text;
begin
    if not pg_try_advisory_xact_lock(hashtext('dashboard_v2_cache_refresh')) then
        return jsonb_build_object('status','skipped','reason','refresh already running');
    end if;
    begin
        payload := public.compute_dashboard_v2_aggregate();
        trends := public.compute_top_topic_trends();
        source_count := (payload->'totals'->>'count')::bigint;
        select max((entry->>'processed_at')::timestamptz) into source_processed_at
        from jsonb_array_elements(payload->'recent') entry;
        insert into public.dashboard_v2_cache (payload, trend_by_topic)
        values (payload, trends) returning generation into generation_id;
        delete from public.dashboard_v2_cache where generation not in (
            select generation from public.dashboard_v2_cache order by generation desc limit 3
        );
    exception when query_canceled or others then
        failure := sqlerrm;
    end;
    insert into public.dashboard_v2_cache_refresh_log (
        started_at, finished_at, duration_ms, success, error_message,
        source_row_count, source_max_processed_at, payload_bytes
    ) values (
        started, clock_timestamp(), round(extract(epoch from (clock_timestamp()-started))*1000)::bigint,
        failure is null, failure, source_count, source_processed_at, octet_length(payload::text)
    );
    if failure is not null then
        raise warning 'Dashboard cache refresh failed: %', failure;
        return jsonb_build_object('status','failed','error_message',failure);
    end if;
    return jsonb_build_object('status','refreshed','generation',generation_id);
end;
$$;

revoke all on function public.refresh_dashboard_v2_cache() from public, anon, authenticated;
grant execute on function public.refresh_dashboard_v2_cache() to service_role;