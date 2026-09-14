-- ============================================================================
-- Recovery for orphaned post_analyses_v2 rows stuck in status = 'processing'.
--
-- Root cause: claimAndProcess() in analyse-posts/index.ts claims a post by
-- inserting a post_analyses_v2 row with status='processing' (see
-- 20260903100000_scheduled_analyse_posts.sql / analyse-posts source). The
-- post_analyses_v2_mark_analysed trigger (20260914100000) then immediately
-- sets bluesky_posts.has_v2_analysis = true for that post, and
-- select_unanalysed_posts() only ever returns has_v2_analysis = false rows.
-- So the moment a post is claimed, it can never be selected again by any
-- existing code path, regardless of what happens next.
--
-- If the Edge Function invocation is killed mid-batch (504 IDLE_TIMEOUT,
-- 546 WORKER_RESOURCE_LIMIT -- both confirmed in production on 2026-09-14)
-- after claiming a post but before it finishes processing that post, the
-- claimed row is permanently stuck in status='processing': it is never
-- retried, never completes, and never surfaces again. Confirmed in
-- production: 1,347 stuck rows as of 2026-09-14 16:59 UTC, growing to 1,383
-- by 20:11 UTC (~3 hours later) with no existing recovery path -- a slow,
-- permanent, unbounded leak from the analysis pipeline.
--
-- Fix: a sweep that finds post_analyses_v2 rows still in 'processing' well
-- past any single invocation's maximum possible lifetime (the Edge Function
-- idle-timeout budget is ~150s; 10 minutes gives a wide, safe margin with no
-- risk of reclaiming a genuinely in-flight row), deletes them, and resets
-- has_v2_analysis = false on the corresponding bluesky_posts row so
-- select_unanalysed_posts() will offer the post again on the next tick.
-- Deleting (rather than resetting status to 'pending') requires no changes
-- to analyse-posts' claim logic: the existing insert-to-claim path already
-- handles "no post_analyses_v2 row exists yet" as its only precondition.
-- ============================================================================

create or replace function public.reclaim_stuck_processing_analyses(
    p_stuck_after interval default interval '10 minutes'
)
returns integer
language sql
as $$
    with stuck as (
        delete from public.post_analyses_v2
        where status = 'processing'
          and updated_at < now() - p_stuck_after
        returning post_uri
    ),
    reclaimed as (
        update public.bluesky_posts bp
        set has_v2_analysis = false
        from stuck s
        where bp.uri = s.post_uri
        returning bp.uri
    )
    select count(*)::integer from reclaimed
$$;

revoke all on function public.reclaim_stuck_processing_analyses(interval) from public;
revoke all on function public.reclaim_stuck_processing_analyses(interval) from anon;
revoke all on function public.reclaim_stuck_processing_analyses(interval) from authenticated;
grant execute on function public.reclaim_stuck_processing_analyses(interval) to service_role;

-- One-time backfill: reclaim the backlog of stuck rows that has already
-- accumulated so they re-enter the pipeline immediately, rather than waiting
-- for the first cron tick below.
select public.reclaim_stuck_processing_analyses();

-- Safety-net cron, offset to its own minute (:03/:13/:23/...) so it never
-- fires on the same tick as analyse-posts-ai-sentiment (*/5, i.e. :00/:05/
-- :10/...) or dashboard-v2-cache-refresh-safety-net (2-59/5, i.e. :02/:07/
-- :12/...). This is a cheap, indexed delete/update over a small row count
-- (post_analyses_v2_status_idx), so collision risk is low either way, but
-- the offset avoids any unnecessary lock contention with analyse-posts'
-- own inserts/updates on the same table.
select cron.schedule(
    'reclaim-stuck-processing-analyses',
    '3-59/10 * * * *',
    $$select public.reclaim_stuck_processing_analyses();$$
);

-- Rollback:
--   select cron.unschedule('reclaim-stuck-processing-analyses');
--   drop function public.reclaim_stuck_processing_analyses(interval);

-- Verify:
--   select count(*) from public.post_analyses_v2 where status = 'processing';
--   select public.reclaim_stuck_processing_analyses(interval '0 seconds'); -- force-reclaim everything currently processing, for testing only
