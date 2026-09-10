-- ============================================================================
-- Dashboard aggregates: exclude promotional/spam posts by default
--
-- Context: post_analyses_v2 now carries a content_type classification
-- (organic/promotional/spam, see 20260910120000_post_analyses_content_type.sql).
-- Dashboard analytics should only reflect organic content; promotional/spam
-- rows remain fully stored and visible in Data Review, just excluded here.
--
-- This migration replaces get_dashboard_v2() and get_dashboard_v2_trend()
-- with the complete, latest bodies from 20260906140000_dashboard_v2_include_
-- all_prompt_versions.sql (statement_timeout restored explicitly, matching
-- 20260906141500_dashboard_v2_fix_statement_timeout.sql), changing ONLY the
-- `scoped` CTE's WHERE clause: adding
-- `and coalesce(v2.content_type, 'organic') = 'organic'` alongside the
-- existing `where v2.status = 'complete'`. No other logic, column, or clause
-- is altered.
--
-- Historical rows analysed before content_type existed have content_type
-- IS NULL and are treated as organic by the coalesce, so totals only change
-- for rows that have actually received a 'promotional' or 'spam'
-- classification going forward -- no historical data is hidden.
-- ============================================================================

create or replace function public.get_dashboard_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set statement_timeout = '20s'
as $$
declare
    v_prompt_version text := public.get_active_prompt_version();
    v_recent_limit constant integer := 200;
    v_min_bucket_posts constant integer := 3;
    v_result jsonb;
begin
    with scoped as (
        select
            v2.post_uri,
            v2.sentiment,
            v2.sentiment_score,
            round((v2.sentiment_score + 1) * 50)::int as display_score,
            v2.confidence,
            v2.emotions,
            v2.topics,
            v2.ai_tooling_stance,
            v2.rationale,
            v2.provider,
            v2.deployment,
            v2.model,
            v2.prompt_version,
            v2.processed_at,
            bp.post_text,
            bp.author_handle,
            bp.original_language,
            bp.published_at,
            bp.source_url
        from public.post_analyses_v2 v2
        join public.bluesky_posts bp on v2.post_uri = bp.uri
        where v2.status = 'complete'
          and coalesce(v2.content_type, 'organic') = 'organic'
    ),
    stance_counts as (
        select ai_tooling_stance as stance, count(*) as cnt
        from scoped
        group by ai_tooling_stance
    ),
    stance_pick as (
        select stance, cnt
        from stance_counts
        order by
            (stance is not null and stance <> 'not_applicable') desc,
            cnt desc
        limit 1
    ),
    totals as (
        select
            count(*) as total_count,
            round(avg(display_score))::int as avg_score,
            round(avg(confidence) * 100)::int as avg_confidence
        from scoped
    ),
    topic_expanded as (
        select
            post_uri,
            display_score,
            case jsonb_typeof(topic_elem)
                when 'string' then trim(both '"' from topic_elem::text)
                else topic_elem ->> 'name'
            end as topic_name
        from scoped, jsonb_array_elements(coalesce(topics, '[]'::jsonb)) as topic_elem
    ),
    topic_agg as (
        select
            topic_name,
            count(*) as volume,
            round(avg(display_score))::int as avg_score
        from topic_expanded
        where topic_name is not null and topic_name <> ''
        group by topic_name
    ),
    emotion_expanded as (
        select
            case jsonb_typeof(emotion_elem)
                when 'string' then trim(both '"' from emotion_elem::text)
                else emotion_elem ->> 'name'
            end as emotion_name
        from scoped, jsonb_array_elements(coalesce(emotions, '[]'::jsonb)) as emotion_elem
    ),
    emotion_agg as (
        select emotion_name, count(*) as cnt
        from emotion_expanded
        where emotion_name is not null and emotion_name <> ''
        group by emotion_name
    ),
    trend_rows as (
        select
            date_trunc('hour', published_at) as bucket_start,
            display_score
        from scoped
        where published_at is not null
    ),
    trend_agg as (
        select
            bucket_start,
            count(*) as bucket_count,
            avg(display_score) as bucket_avg
        from trend_rows
        group by bucket_start
    ),
    recent as (
        select *
        from scoped
        order by processed_at desc nulls last
        limit v_recent_limit
    )
    select jsonb_build_object(
        'prompt_version', v_prompt_version,
        'generated_at', now(),
        'totals', jsonb_build_object(
            'count', coalesce((select total_count from totals), 0),
            'avg_score', (select avg_score from totals),
            'avg_confidence', (select avg_confidence from totals),
            'stance', (select stance from stance_pick),
            'stance_count', coalesce((select cnt from stance_pick), 0)
        ),
        'topics', coalesce((
            select jsonb_agg(jsonb_build_object(
                'name', topic_name,
                'volume', volume,
                'avg_score', avg_score,
                'impact', round((avg_score - (select avg_score from totals))::numeric, 1),
                'low_sample', volume < 3
            ) order by volume desc)
            from topic_agg
        ), '[]'::jsonb),
        'emotions', coalesce((
            select jsonb_agg(jsonb_build_object('name', emotion_name, 'count', cnt) order by cnt desc)
            from emotion_agg
        ), '[]'::jsonb),
        'trend', coalesce((
            select jsonb_agg(jsonb_build_object(
                'bucket_start', bucket_start,
                'count', bucket_count,
                'score', case when bucket_count >= v_min_bucket_posts then round(bucket_avg) else null end,
                'raw_avg', bucket_avg
            ) order by bucket_start asc)
            from trend_agg
        ), '[]'::jsonb),
        'recent', coalesce((
            select jsonb_agg(jsonb_build_object(
                'post_uri', post_uri,
                'sentiment', sentiment,
                'sentiment_score', sentiment_score,
                'display_score', display_score,
                'confidence', confidence,
                'emotions', emotions,
                'topics', topics,
                'ai_tooling_stance', ai_tooling_stance,
                'rationale', rationale,
                'provider', provider,
                'deployment', deployment,
                'model', model,
                'prompt_version', prompt_version,
                'processed_at', processed_at,
                'post_text', post_text,
                'author_handle', author_handle,
                'original_language', original_language,
                'published_at', published_at,
                'source_url', source_url
            ) order by processed_at desc nulls last)
            from recent
        ), '[]'::jsonb)
    )
    into v_result;

    return v_result;
end;
$$;

create or replace function public.get_dashboard_v2_trend(p_topic text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set statement_timeout = '20s'
as $$
declare
    v_prompt_version text := public.get_active_prompt_version();
    v_min_bucket_posts constant integer := 3;
    v_result jsonb;
begin
    with scoped as (
        select
            v2.post_uri,
            round((v2.sentiment_score + 1) * 50)::int as display_score,
            v2.topics,
            bp.published_at
        from public.post_analyses_v2 v2
        join public.bluesky_posts bp on v2.post_uri = bp.uri
        where v2.status = 'complete'
          and coalesce(v2.content_type, 'organic') = 'organic'
          and bp.published_at is not null
    ),
    topic_filtered as (
        select distinct s.post_uri, s.display_score, s.published_at
        from scoped s
        left join lateral jsonb_array_elements(coalesce(s.topics, '[]'::jsonb)) as topic_elem on true
        where p_topic is null
           or (case jsonb_typeof(topic_elem) when 'string' then trim(both '"' from topic_elem::text) else topic_elem ->> 'name' end) = p_topic
    ),
    trend_rows as (
        select date_trunc('hour', published_at) as bucket_start, display_score
        from topic_filtered
    ),
    trend_agg as (
        select bucket_start, count(*) as bucket_count, avg(display_score) as bucket_avg
        from trend_rows
        group by bucket_start
    )
    select jsonb_build_object(
        'prompt_version', v_prompt_version,
        'topic', p_topic,
        'trend', coalesce((
            select jsonb_agg(jsonb_build_object(
                'bucket_start', bucket_start,
                'count', bucket_count,
                'score', case when bucket_count >= v_min_bucket_posts then round(bucket_avg) else null end,
                'raw_avg', bucket_avg
            ) order by bucket_start asc)
            from trend_agg
        ), '[]'::jsonb)
    )
    into v_result;

    return v_result;
end;
$$;

-- Grants unchanged; re-stated defensively (CREATE OR REPLACE FUNCTION
-- preserves existing grants, this guards against relying on that silently).
revoke all on function public.get_dashboard_v2() from public;
grant execute on function public.get_dashboard_v2() to anon;
grant execute on function public.get_dashboard_v2() to authenticated;
grant execute on function public.get_dashboard_v2() to service_role;

revoke all on function public.get_dashboard_v2_trend(text) from public;
grant execute on function public.get_dashboard_v2_trend(text) to anon;
grant execute on function public.get_dashboard_v2_trend(text) to authenticated;
grant execute on function public.get_dashboard_v2_trend(text) to service_role;

-- Verify (totals.count should only drop relative to pre-migration by the
-- number of rows with content_type in ('promotional', 'spam')):
--   select public.get_dashboard_v2();
--   select public.get_dashboard_v2_trend('Reliability');
