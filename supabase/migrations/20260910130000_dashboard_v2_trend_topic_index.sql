-- ============================================================================
-- Fix slow topic-filtered trend queries in get_dashboard_v2_trend()
--
-- Root cause (found via EXPLAIN ANALYZE on the dropdown-triggered query):
-- the function joined post_analyses_v2 to bluesky_posts and expanded every
-- row's topics array via jsonb_array_elements BEFORE filtering by the
-- requested topic. With ~81K rows, that means a full parallel seq scan plus
-- a per-row nested-loop join to bluesky_posts (the dominant cost: ~324K of
-- ~333K buffer hits), only to discard ~97% of the expanded rows afterward.
-- This was already true before the content_type change; it is unrelated to
-- and not fixed by that migration.
--
-- Fix: add a GIN index on post_analyses_v2.topics, and pre-filter `scoped`
-- using jsonb containment (@>) BEFORE the join/expansion, so Postgres can
-- narrow to matching rows via an index scan instead of scanning everything.
-- Two containment checks are used because topics has historically been
-- stored either as an array of {name, relevance} objects (current format)
-- or as a plain array of topic-name strings (older rows); this is a
-- superset-safe pre-filter only -- the existing exact-match CASE logic in
-- topic_filtered is kept unchanged as the authoritative filter, so no row
-- that the old logic would have matched can be dropped by this change.
--
-- get_dashboard_v2() (the no-topic-filter aggregate) is unaffected: it does
-- not take a p_topic argument and already expands topics for every row by
-- design, so there is nothing to pre-filter there.
-- ============================================================================

create index if not exists post_analyses_v2_topics_gin_idx
    on public.post_analyses_v2
    using gin (topics jsonb_path_ops);

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
          and (
              p_topic is null
              or v2.topics @> jsonb_build_array(jsonb_build_object('name', p_topic))
              or v2.topics @> jsonb_build_array(to_jsonb(p_topic))
          )
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

-- Verify (should be far faster than before -- compare via \timing or the
-- app's network tab):
--   select public.get_dashboard_v2_trend('Reliability');
--   explain (analyze, buffers) select public.get_dashboard_v2_trend('Reliability');
