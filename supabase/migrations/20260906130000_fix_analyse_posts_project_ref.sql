-- ============================================================================
-- Fixes a wrong project ref hardcoded in the analyse-posts cron job's URL.
--
-- Bug: 20260903100000_scheduled_analyse_posts.sql registered the job with
-- url := 'https://ulnmghcziubfdezshgtl.supabase.co/functions/v1/analyse-posts'
-- but the actual live project ref (confirmed via the Supabase Dashboard URL
-- and supabase/config.toml's project_id) is 'bsnzcspfrmlihwxqkjyv'. Every
-- scheduled run has therefore been POSTing to a project that does not host
-- this codebase's analyse-posts function (either a stale/renamed/deleted
-- project, or a typo), meaning scheduled sentiment enrichment has never
-- actually reached the deployed function. Manual invocations (e.g. via curl
-- or the Dashboard) are unaffected since those use the correct ref directly.
--
-- Fix: swap only the hostname inside the existing cron.job.command via
-- replace(), following the same in-place-alter pattern used in
-- 20260903140000_increase_analyse_posts_throughput.sql, so the embedded
-- Authorization/apikey/x-ingestion-secret headers are never restated here.
-- ============================================================================

do $$
declare
  target_job_id bigint;
  current_command text;
  new_command text;
begin
  select jobid, command into target_job_id, current_command
  from cron.job
  where jobname = 'analyse-posts-ai-sentiment';

  if target_job_id is null then
    raise exception 'Cron job analyse-posts-ai-sentiment not found; run 20260903100000_scheduled_analyse_posts.sql first.';
  end if;

  if current_command like '%ulnmghcziubfdezshgtl.supabase.co%' then
    new_command := replace(
      current_command,
      'ulnmghcziubfdezshgtl.supabase.co',
      'bsnzcspfrmlihwxqkjyv.supabase.co'
    );
    perform cron.alter_job(target_job_id, command := new_command);
    raise notice 'analyse-posts-ai-sentiment cron job URL updated to project ref bsnzcspfrmlihwxqkjyv.';
  else
    raise notice 'Expected ulnmghcziubfdezshgtl.supabase.co in the analyse-posts cron command but did not find it (already fixed?). No change made; review cron.job.command manually.';
  end if;
end $$;

-- Verify the corrected URL (command embeds credentials, so only spot-check
-- the host substring rather than printing the full command):
--   select jobname, schedule, active,
--          command like '%bsnzcspfrmlihwxqkjyv.supabase.co%' as url_is_correct,
--          command like '%ulnmghcziubfdezshgtl.supabase.co%' as url_is_stale
--   from cron.job
--   where jobname = 'analyse-posts-ai-sentiment';
