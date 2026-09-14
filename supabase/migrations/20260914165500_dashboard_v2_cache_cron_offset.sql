-- The dashboard cache safety-net cron and the analyse-posts cron both ran on
-- the identical "*/5 * * * *" schedule, firing at the same wall-clock second.
-- Confirmed in production (2026-09-14): dashboard_v2_cache_refresh_log shows
-- refreshes routinely taking 60-140s (occasionally hitting the statement
-- timeout outright), directly correlated with analyse-posts invocations
-- failing on the same ticks with 500 "canceling statement due to statement
-- timeout", 500 "Failed to resolve active prompt version: Gateway Timeout",
-- and 546 WORKER_RESOURCE_LIMIT. Offsetting the safety-net refresh by 2
-- minutes removes the direct collision while keeping the same 5-minute
-- safety-net cadence.
select cron.unschedule('dashboard-v2-cache-refresh-safety-net');

select cron.schedule(
    'dashboard-v2-cache-refresh-safety-net',
    '2-59/5 * * * *',
    $$select public.refresh_dashboard_v2_cache();$$
);

-- Rollback:
--   select cron.unschedule('dashboard-v2-cache-refresh-safety-net');
--   select cron.schedule(
--       'dashboard-v2-cache-refresh-safety-net',
--       '*/5 * * * *',
--       $$select public.refresh_dashboard_v2_cache();$$
--   );
