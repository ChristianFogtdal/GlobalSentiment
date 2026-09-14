-- Five-minute safety net. The analysis worker is the primary refresh trigger.

select cron.schedule(
    'dashboard-v2-cache-refresh-safety-net',
    '*/5 * * * *',
    $$select public.refresh_dashboard_v2_cache();$$
);

-- Rollback:
--   select cron.unschedule('dashboard-v2-cache-refresh-safety-net');
