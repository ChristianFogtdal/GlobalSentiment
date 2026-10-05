create or replace view public.recent_sentiment_reporting as
select v2.post_uri,v2.sentiment,v2.sentiment_score,round((v2.sentiment_score+1)*50)::integer as display_score,
    v2.confidence,v2.emotions,v2.topics,v2.ai_tooling_stance,v2.rationale,v2.provider,v2.deployment,v2.model,
    v2.prompt_version,v2.processed_at,bp.post_text,bp.author_handle,bp.original_language,
    bp.published_at,bp.source_url
from public.post_analyses_v2 v2 join public.bluesky_posts bp on bp.uri=v2.post_uri
where v2.status='complete' and coalesce(v2.content_type,'organic')='organic'
    and bp.published_at>=now()-interval '720 hours'
    and bp.published_at<=now();

create or replace view public.completed_post_analyses_v2 as
select v2.post_uri,v2.sentiment,v2.sentiment_score,v2.emotions,v2.topics,v2.tools_mentioned,
    v2.ai_tooling_stance,v2.confidence,v2.rationale,v2.provider,v2.deployment,v2.model,v2.prompt_version,
    v2.created_at,v2.processed_at,bp.post_text,bp.author_handle,bp.original_language,
    bp.published_at,bp.source_url,v2.content_type,v2.content_type_reason
from public.post_analyses_v2 v2 join public.bluesky_posts bp on bp.uri=v2.post_uri
where v2.status='complete' and bp.published_at>=now()-interval '720 hours'
    and bp.published_at<=now();

alter function public.compute_dashboard_v2_aggregate() set timezone='UTC';
alter function public.compute_top_topic_trends() set timezone='UTC';
alter function public.refresh_dashboard_v2_cache() set timezone='UTC';

create or replace function public.get_dashboard_v2()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare cached public.dashboard_v2_cache%rowtype;
begin
    select * into cached from public.dashboard_v2_cache order by generation desc limit 1;
    if not found or cached.generated_at<now()-interval '90 minutes' or cached.generated_at>now() then
        raise exception using errcode='55000',message='Dashboard cache unavailable or stale';
    end if;
    return cached.payload;
end;
$$;

create or replace function public.get_dashboard_v2_trend(p_topic text default null)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
    cached public.dashboard_v2_cache%rowtype;
    trend jsonb;
begin
    select * into cached from public.dashboard_v2_cache order by generation desc limit 1;
    if not found or cached.generated_at<now()-interval '90 minutes' or cached.generated_at>now() then
        raise exception using errcode='55000',message='Dashboard cache unavailable or stale';
    end if;
    if p_topic is null then
        return jsonb_build_object('prompt_version',public.get_active_prompt_version(),'topic',null,'trend',cached.payload->'trend');
    end if;
    if cached.trend_by_topic ? p_topic then
        return jsonb_build_object('prompt_version',public.get_active_prompt_version(),'topic',p_topic,'trend',cached.trend_by_topic->p_topic);
    end if;
    with buckets as (
        select date_trunc('hour',published_at) as bucket_start,count(*) as count,
            case when count(*)>=3 then round(avg(display_score)) else null end as score,avg(display_score) as raw_avg
        from public.recent_sentiment_reporting where topics @> jsonb_build_array(jsonb_build_object('name',p_topic))
            or topics @> jsonb_build_array(to_jsonb(p_topic)) group by 1
    ) select coalesce(jsonb_agg(to_jsonb(buckets) order by bucket_start),'[]'::jsonb) into trend from buckets;
    return jsonb_build_object('prompt_version',public.get_active_prompt_version(),'topic',p_topic,'trend',trend);
end;
$$;
revoke all on public.recent_sentiment_reporting from public,anon,authenticated;
revoke all on function public.get_dashboard_v2(),public.get_dashboard_v2_trend(text) from public;
grant execute on function public.get_dashboard_v2(),public.get_dashboard_v2_trend(text) to anon,authenticated,service_role;
grant select on public.completed_post_analyses_v2 to anon,authenticated,service_role;