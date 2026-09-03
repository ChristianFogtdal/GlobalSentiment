-- ============================================================================
-- Raises analyse-posts throughput so LLM enrichment keeps pace with Bluesky
-- ingestion instead of falling permanently behind.
--
-- Problem: ingest-bluesky-search runs every 5 minutes (24 search terms x
-- POSTS_PER_TERM=10, deduplicated), which was measured landing ~87 new rows
-- in bluesky_posts per 15 minutes (~333/hour). analyse-posts ran every 15
-- minutes at LLM_BATCH_SIZE=10, i.e. ~10 analyses per 15 minutes. Intake
-- therefore exceeded enrichment by roughly 8x and the unanalysed backlog grew
-- by ~7,000 rows/day; no batch-size change alone could close that gap because
-- LLM_BATCH_SIZE is clamped to MAX_BATCH_SIZE=50 in the function.
--
-- Fix: increase invocation FREQUENCY rather than only batch size. At
-- LLM_BATCH_SIZE=50 every 5 minutes the function completes ~150 analyses per
-- 15 minutes, which exceeds the measured ~87/15min intake with headroom to
-- also drain the accumulated backlog. 50 is exactly the existing
-- MAX_BATCH_SIZE ceiling, so the per-invocation cost cap is unchanged and no
-- function code change is required.
--
-- Why not a single larger batch every 15 minutes: Foundry calls within an
-- invocation are deliberately sequential (cost containment), measured at
-- ~3s each. A batch of ~150 would run ~7.5 minutes of wall clock in one
-- invocation and risks being killed mid-batch by the Edge Function execution
-- limit. Three ~2.5-minute invocations carry the same throughput well inside
-- that limit.
--
-- COST: this raises Foundry call volume from ~960/day to ~14,400/day. That is
-- an intentional, roughly 15x increase in provider spend. Note that once the
-- backlog is drained, steady-state volume is dictated by the ~333/hour
-- ingestion rate, not by the batch size.
--
-- To revert to the previous rate: re-run this file's alter_job block with
-- schedule := '*/15 * * * *' and unset LLM_BATCH_SIZE.
--
-- REQUIRED companion step (not scriptable here -- Edge Function environment
-- variables are not settable from SQL). Without it the schedule fires more
-- often but each run still processes only DEFAULT_BATCH_SIZE=10 posts, which
-- does NOT keep pace with ingestion:
--
--   supabase secrets set LLM_BATCH_SIZE=50
--
-- or set LLM_BATCH_SIZE=50 in Dashboard > Edge Functions > analyse-posts >
-- Secrets. This is deliberately configuration rather than a code change:
-- DEFAULT_BATCH_SIZE stays at 10 so that an unset or malformed
-- LLM_BATCH_SIZE still fails safe to the cheap value rather than to the
-- maximum.
--
-- timeout_milliseconds: raised to 240000 (4 min) to comfortably cover a
-- ~2.5-minute batch of 50 sequential Foundry calls, leaving margin if Foundry
-- latency exceeds the observed ~3s/call. As documented in
-- 20260903100000_scheduled_analyse_posts.sql, a short timeout does not abort
-- the Edge Function -- the work still completes server-side -- it only means
-- net._http_response never records the final status/body. Raised here so
-- normal runs still report a real status_code.
-- ============================================================================

-- Altered in place rather than unschedule+reschedule so the existing job's
-- command (which embeds credentials) is not restated in this migration.
-- Only the cadence changes; the request body/headers are left untouched.
do $$
declare
  target_job_id bigint;
  current_command text;
begin
  select jobid, command into target_job_id, current_command
  from cron.job
  where jobname = 'analyse-posts-ai-sentiment';

  if target_job_id is null then
    raise exception 'Cron job analyse-posts-ai-sentiment not found; run 20260903100000_scheduled_analyse_posts.sql first.';
  end if;

  perform cron.alter_job(target_job_id, schedule := '*/5 * * * *');

  -- Bump the pg_net response-wait window to cover a ~2.5-minute batch of 50
  -- sequential Foundry calls, without restating the credentialed command.
  if current_command like '%timeout_milliseconds := 60000%' then
    perform cron.alter_job(
      target_job_id,
      command := replace(current_command, 'timeout_milliseconds := 60000', 'timeout_milliseconds := 240000')
    );
  else
    raise notice 'Expected timeout_milliseconds := 60000 in the analyse-posts cron command but did not find it; schedule was updated to */5 but the timeout was left unchanged. Review cron.job.command manually.';
  end if;
end $$;

-- Verify the new cadence:
--   select jobname, schedule, active from cron.job
--   where jobname = 'analyse-posts-ai-sentiment';
