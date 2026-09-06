-- ============================================================================
-- Dashboard aggregate RPC: public.get_dashboard_v2()
--
-- Replaces the browser's full-archive pagination through
-- completed_post_analyses_v2 with one compact, server-aggregated response
-- scoped to the active V2 prompt version (public.get_active_prompt_version(),
-- see 20260904090000_active_prompt_version_contract.sql).
--
-- Sections returned (as a single jsonb object):
--   totals            -- full-history: count, avg display score (0-100),
--                         avg confidence (0-100), dominant stance + count
--   topics            -- per-topic: volume, avg display score, avg impact
--   emotions          -- per-emotion: count
--   trend             -- hourly buckets (published_at-keyed), sparse-safe
--   recent            -- bounded recent-post feed (RECENT_FEED_LIMIT rows)
--
-- Filtering: every aggregate and the recent feed are scoped to
-- prompt_version = get_active_prompt_version() and status = 'complete',
-- matching the existing completed_post_analyses_v2 view's WHERE clause.
--
-- Metric semantics preserved from SentimentMap/app.js (archiveDashboardData /
-- trendSeries), only the computation location moves server-side:
--   - display score conversion: round((sentiment_score + 1) * 50), i.e.
--     [-1, 1] -> [0, 100];
--   - stance: most common *meaningful* (non not_applicable) stance, falling
--     back to not_applicable only if no meaningful stance exists at all;
--   - trend buckets: keyed on published_at (never processed_at/created_at),
--     rows without a valid published_at excluded, hourly buckets, buckets
--     with fewer than MIN_BUCKET_POSTS (3) reported with a null score (no
--     interpolation) rather than being dropped or merged.
--
-- This migration is additive: it does not alter post_analyses_v2,
-- completed_post_analyses_v2, or any legacy object.
-- ============================================================================

create index if not exists post_analyses_v2_prompt_status_processed_idx
    on public.post_analyses_v2 (prompt_version, status, processed_at desc);

create or replace function public.get_dashboard_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
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
          and v2.prompt_version = v_prompt_version
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
                -- impact: topic's own average score minus the full-history
                -- average score, matching app.js's archiveDashboardData.
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
                -- No interpolation across sparse buckets: a bucket below the
                -- minimum sample size reports a null score so the chart
                -- breaks the line instead of drawing a swing from one or two
                -- posts as though it were a trend. raw_avg is always present
                -- (even when score is null) so the client can still compute
                -- an accurate windowed headline average.
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

-- Minimum grants needed by the dashboard: anon (public browser) and
-- authenticated, matching completed_post_analyses_v2's existing grant
-- pattern. SECURITY DEFINER is safe here because the function only ever
-- returns aggregated/complete-status rows already exposed via
-- completed_post_analyses_v2; it grants no broader table access.
revoke all on function public.get_dashboard_v2() from public;
grant execute on function public.get_dashboard_v2() to anon;
grant execute on function public.get_dashboard_v2() to authenticated;
grant execute on function public.get_dashboard_v2() to service_role;

-- ============================================================================
-- public.get_dashboard_v2_trend(p_topic text)
--
-- On-demand, topic-scoped hourly trend series, used only when the dashboard's
-- topic dropdown selects a specific topic (the initial get_dashboard_v2()
-- payload already includes the unfiltered/"all topics" trend). Same bucketing
-- semantics as get_dashboard_v2()'s trend section: published_at-keyed hourly
-- buckets, sparse buckets (below MIN_BUCKET_POSTS) reported with a null score
-- rather than interpolated.
-- ============================================================================

create or replace function public.get_dashboard_v2_trend(p_topic text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
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
          and v2.prompt_version = v_prompt_version
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

revoke all on function public.get_dashboard_v2_trend(text) from public;
grant execute on function public.get_dashboard_v2_trend(text) to anon;
grant execute on function public.get_dashboard_v2_trend(text) to authenticated;
grant execute on function public.get_dashboard_v2_trend(text) to service_role;

-- Verify (compare against independent SQL over completed_post_analyses_v2):
--   select public.get_dashboard_v2();
--   select public.get_dashboard_v2_trend('Reliability');
