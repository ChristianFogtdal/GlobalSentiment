-- ============================================================================
-- Fix statement timeout in get_dashboard_v2()/get_dashboard_v2_trend() after
-- removing the prompt_version filter (20260906140000_dashboard_v2_include_
-- all_prompt_versions.sql).
--
-- Root cause: with the prompt_version predicate removed, the aggregate
-- queries scan by status alone (no longer benefiting from the composite
-- (prompt_version, status, processed_at desc) index added in
-- 20260904091500_dashboard_v2_aggregate_rpc.sql) over ~4x more rows, with two
-- jsonb_array_elements expansions (topics, emotions) plus grouping/joins on
-- top. This now exceeds the role's default statement_timeout on the hosted
-- project, surfacing as Postgres error 57014 ("canceling statement due to
-- statement timeout") -> HTTP 500 from PostgREST.
--
-- Fix:
--   1. Add an index on (status, processed_at desc) so status-only scans
--      (now that prompt_version is no longer part of the predicate) stay
--      index-backed instead of falling back to a sequential scan.
--   2. Raise the statement_timeout for just these two functions via a
--      function-scoped `set` option, which overrides the calling role's
--      default only for the duration of the function call -- it does not
--      change the timeout for any other query, role, or session.
-- ============================================================================

create index if not exists post_analyses_v2_status_processed_idx
    on public.post_analyses_v2 (status, processed_at desc);

alter function public.get_dashboard_v2() set statement_timeout = '20s';
alter function public.get_dashboard_v2_trend(text) set statement_timeout = '20s';

-- Verify (should return promptly, without a 57014 timeout error):
--   select public.get_dashboard_v2();
--   select public.get_dashboard_v2_trend('Reliability');
