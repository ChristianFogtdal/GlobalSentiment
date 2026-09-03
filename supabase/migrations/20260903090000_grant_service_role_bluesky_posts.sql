-- ============================================================================
-- Fix: grant service_role table-level privileges on public.bluesky_posts
--
-- The reconstructed legacy baseline (20260902150000_legacy_baseline_bluesky_posts.sql)
-- added RLS policies for service_role but never issued the underlying GRANT,
-- so service_role (used by analyse-posts and ingest-bluesky-search) received
-- "permission denied for table bluesky_posts" even though its RLS policy
-- allowed the row. Postgres requires both grant-level and row-level (RLS)
-- permission. This is additive and does not alter any other object.
-- ============================================================================

grant select, insert, update, delete on table public.bluesky_posts to service_role;
