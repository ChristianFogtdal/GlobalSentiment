-- ============================================================================
-- Documents a required-but-not-scriptable manual setup step discovered while
-- staging-verifying 20260903100000_scheduled_analyse_posts.sql: the vault
-- secret 'bluesky_ingestion_secret' referenced by both the
-- analyse-posts-ai-sentiment and (presumably) the pre-existing
-- ingest-bluesky-search cron jobs did not actually exist in this project.
-- Without it, net.http_post sends x-ingestion-secret: NULL, which never
-- matches the real INGESTION_SECRET configured on either Edge Function, and
-- every scheduled invocation fails with a 401 from the function's own
-- authorization check (not a gateway-level failure).
--
-- This is intentionally NOT a `create` statement: vault secret values are
-- sensitive and must not be embedded in a source-controlled migration. This
-- file exists purely so the requirement is discoverable in the schema
-- history, not silently missing.
--
-- Manual step required once per environment (staging, and again before
-- production is scheduled), run in the SQL editor with the real
-- ingestion-secret value substituted:
--
--   select vault.create_secret(
--     '<same value as INGESTION_SECRET in analyse-posts and ingest-bluesky-search secrets>',
--     'bluesky_ingestion_secret',
--     'Shared x-ingestion-secret header value for scheduled Edge Function calls (ingest-bluesky-search, analyse-posts).'
--   );
--
-- Verify with:
--   select name from vault.secrets where name = 'bluesky_ingestion_secret';
-- ============================================================================

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'bluesky_ingestion_secret') then
    raise notice 'bluesky_ingestion_secret vault secret is missing. Scheduled analyse-posts/ingest-bluesky-search cron invocations will receive a 401 until it is created manually (see comment header in this migration for the exact vault.create_secret call).';
  end if;
end $$;
