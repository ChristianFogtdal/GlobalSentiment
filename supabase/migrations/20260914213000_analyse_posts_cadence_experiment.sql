-- ============================================================================
-- CONTROLLED EXPERIMENT (2026-09-14): raises analyse-posts-ai-sentiment's
-- invocation frequency from */5 to */2 minutes, keeping MAX_BATCH_SIZE=20
-- (see supabase/functions/analyse-posts/index.ts) unchanged.
--
-- Why: MAX_BATCH_SIZE was lowered 50 -> 20 to eliminate 504 IDLE_TIMEOUT /
-- 546 WORKER_RESOURCE_LIMIT failures (see
-- 20260914201500_reclaim_stuck_processing_analyses.sql commit message and
-- surrounding investigation). That fixed reliability but capped theoretical
-- throughput at 20 posts x 12 runs/hour = 240/hour, below the measured
-- ~460-480/hour ingestion rate observed over the following hours -- the
-- backlog would resume growing under sustained load at that ceiling.
--
-- 20 posts x 30 runs/hour (every 2 minutes) raises the ceiling to 600/hour,
-- restoring surplus over ingestion while keeping the same per-invocation
-- Foundry call count that was already confirmed safe.
--
-- Preconditions verified before this migration (see accompanying
-- 20260914210000_analyse_posts_invocation_log.sql, deployed and confirmed
-- logging first):
--   1. Concurrent invocations cannot double-process a post or waste a batch
--      slot: claimAndProcess() claims via an atomic insert relying on the
--      (post_uri, prompt_version) unique constraint; a losing concurrent
--      claim returns null and is excluded from that invocation's counts
--      before any Foundry call is made (see runBatch() in index.ts).
--   2. No documented Foundry/Supabase concurrency ceiling exists in this
--      codebase to check against, and no 429 has ever been observed in the
--      historical failure breakdown -- this is a real unknown the experiment
--      itself is designed to surface, not something provable in advance.
--   3. analyse_posts_invocation_log (+ analyse_posts_invocation_stats view)
--      now records started_at/finished_at/selected/completed/failed per
--      invocation, making concurrent-invocation overlap, abandoned
--      (killed-mid-run) invocations, and realised (not just theoretical)
--      throughput directly measurable.
--
-- This is explicitly a controlled experiment, not a final configuration --
-- see the rollback note below. Re-measure analyses/hour, ingestion/hour,
-- backlog size, oldest-pending age, invocation overlap frequency, and
-- 504/546 rates after several hours before treating this as permanent.
-- ============================================================================

do $$
declare
  target_job_id bigint;
begin
  select jobid into target_job_id
  from cron.job
  where jobname = 'analyse-posts-ai-sentiment';

  if target_job_id is null then
    raise exception 'Cron job analyse-posts-ai-sentiment not found; run 20260903100000_scheduled_analyse_posts.sql first.';
  end if;

  perform cron.alter_job(target_job_id, schedule := '*/2 * * * *');
end $$;

-- Verify the new cadence:
--   select jobname, schedule, active from cron.job
--   where jobname = 'analyse-posts-ai-sentiment';

-- Rollback (revert to the pre-experiment cadence if the invocation log shows
-- meaningful overlap/abandonment, or if 504/546 rates increase):
--   do $$
--   declare
--     target_job_id bigint;
--   begin
--     select jobid into target_job_id from cron.job where jobname = 'analyse-posts-ai-sentiment';
--     perform cron.alter_job(target_job_id, schedule := '*/5 * * * *');
--   end $$;
