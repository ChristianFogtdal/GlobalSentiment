-- Additive cache computation, refresh, status, and topic-trend functions.
-- get_dashboard_v2() remains unchanged until the separate cutover migration.

create or replace function public.compute_dashboard_v2_aggregate()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set statement_timeout = '20s'
set work_mem = '256MB'
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

create or replace function public.compute_top_topic_trends()
returns jsonb
language sql
stable
security definer
set search_path = public
set statement_timeout = '20s'
set work_mem = '256MB'
as $$
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
    ),
    topic_expanded as (
        select
            post_uri,
            display_score,
            published_at,
            case jsonb_typeof(topic_elem)
                when 'string' then trim(both '"' from topic_elem::text)
                else topic_elem ->> 'name'
            end as topic_name
        from scoped, jsonb_array_elements(coalesce(topics, '[]'::jsonb)) as topic_elem
    ),
    top_topics as (
        select topic_name
        from topic_expanded
        where topic_name is not null
          and topic_name <> ''
          and lower(topic_name) <> 'other'
        group by topic_name
        having count(*) >= 5
        order by count(*) desc, topic_name
        limit 20
    ),
    topic_posts as (
        select distinct
            expanded.topic_name,
            expanded.post_uri,
            expanded.display_score,
            expanded.published_at
        from topic_expanded expanded
        join top_topics top_topic on top_topic.topic_name = expanded.topic_name
        where expanded.published_at is not null
    ),
    trend_agg as (
        select
            topic_name,
            date_trunc('hour', published_at) as bucket_start,
            count(*) as bucket_count,
            avg(display_score) as bucket_avg
        from topic_posts
        group by topic_name, date_trunc('hour', published_at)
    ),
    topic_payloads as (
        select
            topic_name,
            jsonb_agg(jsonb_build_object(
                'bucket_start', bucket_start,
                'count', bucket_count,
                'score', case when bucket_count >= 3 then round(bucket_avg) else null end,
                'raw_avg', bucket_avg
            ) order by bucket_start asc) as trend
        from trend_agg
        group by topic_name
    )
    select coalesce(jsonb_object_agg(topic_name, trend order by topic_name), '{}'::jsonb)
    from topic_payloads;
$$;

-- statement_timeout is set explicitly here (rather than relying on the
-- nested compute_dashboard_v2_aggregate()/compute_top_topic_trends() 20s
-- overrides, which only take effect for a top-level call and are inert when
-- invoked from inside this function) because this is the function actually
-- invoked as a top-level statement by pg_cron and any manual call. Sized
-- well above the normal ~60-85s duration to tolerate contention, but under
-- the 5-minute cron cadence. See
-- 20260914110000_dashboard_v2_cache_refresh_statement_timeout.sql for the
-- production incident that surfaced this.
create or replace function public.refresh_dashboard_v2_cache()
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '240s'
as $$
declare
    v_started_at timestamptz := clock_timestamp();
    v_finished_at timestamptz;
    v_payload jsonb;
    v_trend_by_topic jsonb;
    v_source_row_count bigint;
    v_source_max_processed_at timestamptz;
    v_generation bigint;
    v_error_message text;
begin
    if not pg_try_advisory_lock(hashtext('dashboard_v2_cache_refresh')) then
        return jsonb_build_object('status', 'skipped', 'reason', 'refresh already running');
    end if;

    begin
        select count(*), max(processed_at)
        into v_source_row_count, v_source_max_processed_at
        from public.post_analyses_v2
        where status = 'complete'
          and coalesce(content_type, 'organic') = 'organic';

        v_payload := public.compute_dashboard_v2_aggregate();
        v_trend_by_topic := public.compute_top_topic_trends();

        insert into public.dashboard_v2_cache (payload, trend_by_topic)
        values (v_payload, v_trend_by_topic)
        returning generation into v_generation;

        delete from public.dashboard_v2_cache
        where generation not in (
            select generation
            from public.dashboard_v2_cache
            order by generation desc
            limit 3
        );

        v_finished_at := clock_timestamp();
        insert into public.dashboard_v2_cache_refresh_log (
            started_at,
            finished_at,
            duration_ms,
            success,
            source_row_count,
            source_max_processed_at,
            payload_bytes
        )
        values (
            v_started_at,
            v_finished_at,
            round(extract(epoch from (v_finished_at - v_started_at)) * 1000)::bigint,
            true,
            v_source_row_count,
            v_source_max_processed_at,
            octet_length(v_payload::text)
        );
    exception
        when query_canceled then
            v_error_message := sqlerrm;
        when others then
            v_error_message := sqlerrm;
    end;

    if v_error_message is not null then
        v_finished_at := clock_timestamp();

        insert into public.dashboard_v2_cache_refresh_log (
            started_at,
            finished_at,
            duration_ms,
            success,
            error_message,
            source_row_count,
            source_max_processed_at
        )
        values (
            v_started_at,
            v_finished_at,
            round(extract(epoch from (v_finished_at - v_started_at)) * 1000)::bigint,
            false,
            v_error_message,
            v_source_row_count,
            v_source_max_processed_at
        );

        perform pg_advisory_unlock(hashtext('dashboard_v2_cache_refresh'));
        raise warning 'dashboard_v2 cache refresh failed: %', v_error_message;
        return jsonb_build_object('status', 'failed', 'error_message', v_error_message);
    end if;

    perform pg_advisory_unlock(hashtext('dashboard_v2_cache_refresh'));
    return jsonb_build_object('status', 'refreshed', 'generation', v_generation);
exception
    when query_canceled then
        perform pg_advisory_unlock(hashtext('dashboard_v2_cache_refresh'));
        raise;
    when others then
        perform pg_advisory_unlock(hashtext('dashboard_v2_cache_refresh'));
        raise;
end;
$$;

create or replace function public.get_dashboard_v2_cache_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    with latest as (
        select generation, generated_at
        from public.dashboard_v2_cache
        order by generation desc
        limit 1
    ),
    recent_refreshes as (
        select success, started_at
        from public.dashboard_v2_cache_refresh_log
        order by started_at desc
        limit 5
    )
    select jsonb_build_object(
        'generation', (select generation from latest),
        'generated_at', (select generated_at from latest),
        'age_seconds', (
            select greatest(0, extract(epoch from (now() - generated_at)))::bigint
            from latest
        ),
        'last_5_refresh_success', coalesce((
            select jsonb_agg(success order by started_at desc)
            from recent_refreshes
        ), '[]'::jsonb)
    );
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
    v_cached_trend jsonb;
    v_result jsonb;
begin
    if p_topic is not null then
        select trend_by_topic -> p_topic
        into v_cached_trend
        from public.dashboard_v2_cache
        where trend_by_topic ? p_topic
        order by generation desc
        limit 1;

        if v_cached_trend is not null then
            return jsonb_build_object(
                'prompt_version', v_prompt_version,
                'topic', p_topic,
                'trend', v_cached_trend
            );
        end if;
    end if;

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

revoke all on function public.compute_dashboard_v2_aggregate() from public;
grant execute on function public.compute_dashboard_v2_aggregate() to service_role;

revoke all on function public.compute_top_topic_trends() from public;
grant execute on function public.compute_top_topic_trends() to service_role;

revoke all on function public.refresh_dashboard_v2_cache() from public;
grant execute on function public.refresh_dashboard_v2_cache() to service_role;

revoke all on function public.get_dashboard_v2_cache_status() from public;
grant execute on function public.get_dashboard_v2_cache_status() to service_role;

revoke all on function public.get_dashboard_v2_trend(text) from public;
grant execute on function public.get_dashboard_v2_trend(text) to anon;
grant execute on function public.get_dashboard_v2_trend(text) to authenticated;
grant execute on function public.get_dashboard_v2_trend(text) to service_role;
