-- ============================================================================
-- Fix statement timeout for Data Review (completed_post_analyses_v2) after
-- removing its prompt_version filter (20260906140000_dashboard_v2_include_
-- all_prompt_versions.sql / app.js loadArchiveV2).
--
-- Root cause: Data Review queries completed_post_analyses_v2 directly via
-- PostgREST (not through a plpgsql function), joining post_analyses_v2 to
-- bluesky_posts, ordering by published_at desc, with an exact row count
-- (Prefer: count=exact). With the prompt_version predicate removed this now
-- scans/sorts/counts the full cross-version history and exceeds the anon/
-- authenticated role's default statement_timeout, surfacing as Postgres
-- error 57014 -> HTTP 500 from PostgREST, the same failure mode fixed for
-- the dashboard RPCs in 20260906141500_dashboard_v2_fix_statement_timeout.sql.
--
-- Because this is a plain view queried directly (not a function call), the
-- per-function `set statement_timeout` trick used for get_dashboard_v2()/
-- get_dashboard_v2_trend() does not apply here. Instead, raise the timeout
-- for the two PostgREST-facing roles that ever query this view. This is
-- scoped to just those roles (not superuser/service_role/postgres) and only
-- changes how long a statement may run before Postgres cancels it -- it
-- grants no new privileges.
-- ============================================================================

alter role anon set statement_timeout = '20s';
alter role authenticated set statement_timeout = '20s';

-- Verify (should return promptly, without a 57014 timeout error):
--   select count(*) from public.completed_post_analyses_v2;
--   select * from public.completed_post_analyses_v2 order by published_at desc limit 50;
-- (Re-connect / start a new session after running this migration so the new
-- role-level setting takes effect for subsequent PostgREST requests.)
