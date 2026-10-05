-- Read-only preflight. Run and review before enabling cleanup.
select now() as observed_at, now() - interval '720 hours' as cutoff;
select * from public.preview_sentiment_retention();
select jobname, schedule, active from cron.job order by jobname;
select conrelid::regclass as child_table, confrelid::regclass as parent_table,
       conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where contype = 'f' and confrelid in (
    'public.bluesky_posts'::regclass, 'public.post_analyses'::regclass,
    'public.post_analyses_v2'::regclass, 'public.analysis_content_cache'::regclass
);
select event_object_table, trigger_name, action_statement
from information_schema.triggers where event_object_schema = 'public';
select relname, n_live_tup, n_dead_tup, last_autovacuum
from pg_stat_user_tables order by relname;

-- APPROVAL REQUIRED: execute only the enable block, separately, after reviewing
-- the preflight, backups, unknown foreign keys/triggers and aggregate samples.
-- begin;
-- update public.app_settings set value = 'true', updated_at = now()
-- where key = 'retention_enabled';
-- select cron.alter_job(jobid, active := true) from cron.job
-- where jobname = 'sentiment-retention-cleanup';
-- commit;

-- APPROVAL REQUIRED: optional bounded catch-up, one transaction per invocation.
-- SET statement_timeout = '60s';
-- SET lock_timeout = '2s';
-- SET timezone = 'UTC';
-- select public.cleanup_sentiment_history(1000);
-- select * from public.preview_sentiment_retention();
-- select * from public.retention_cleanup_log order by started_at desc limit 20;

-- APPROVAL REQUIRED: disable procedure. Deleted rows cannot be restored by SQL
-- rollback after commit; restore approved backups if needed.
-- select public.disable_sentiment_retention();

-- APPROVAL REQUIRED: pause external spending independently, retaining caches.
-- select cron.alter_job(jobid, active := false) from cron.job
-- where jobname in ('ingest-bluesky-ai-coding-posts', 'analyse-posts-ai-sentiment');

-- Schedule-only rollback (does NOT restore higher worker budgets or lost data).
-- Do not redeploy an old worker without an approved compatibility migration:
-- direct table writes and unfenced RPCs are deliberately revoked.
-- select cron.alter_job(jobid, schedule := '*/15 * * * *') from cron.job
-- where jobname = 'ingest-bluesky-ai-coding-posts';
-- select cron.alter_job(jobid, schedule := '*/2 * * * *') from cron.job
-- where jobname = 'analyse-posts-ai-sentiment';
-- select cron.alter_job(jobid, schedule := '2-59/5 * * * *') from cron.job
-- where jobname = 'dashboard-v2-cache-refresh-safety-net';
-- select cron.alter_job(jobid, schedule := '3-59/10 * * * *') from cron.job
-- where jobname = 'reclaim-stuck-processing-analyses';