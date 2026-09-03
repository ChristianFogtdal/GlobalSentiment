-- ============================================================================
-- Scheduled batch invocation for public.analyse-posts (Foundry sentiment
-- enrichment). Additive: reuses the existing INGESTION_SECRET/vault pattern
-- from 20260902090000_scheduled_bluesky_search.sql. Registered as a
-- separately named cron job so it can be paused/unscheduled independently
-- of Bluesky ingestion.
--
-- Prerequisite: analyse-posts must already be deployed and its secrets
-- (AZURE_FOUNDRY_*, LLM_PROMPT_VERSION, LLM_PROCESSING_ENABLED=enabled,
-- LLM_BATCH_SIZE, INGESTION_SECRET) already configured before this schedule
-- starts firing, otherwise every run will short-circuit with an error/skip
-- response (no post is selected and no Foundry call is made in that case).
--
-- This migration assumes the same vault secret name
-- ('bluesky_ingestion_secret') already created for ingest-bluesky-search is
-- reused for analyse-posts' x-ingestion-secret header. If a distinct secret
-- value is desired for this function, create a separate vault secret first
-- and reference its name below instead.
--
-- timeout_milliseconds: analyse-posts processes a sequential batch of posts
-- (one Foundry call per post), which can legitimately take well beyond
-- pg_net's default response-wait window. A short timeout does NOT cause the
-- Edge Function invocation to fail or be retried -- the request is still
-- dispatched and the function still runs to completion server-side -- it
-- only means net._http_response never records the final status/body for
-- that request id. Raised here so normal-sized batches report a real
-- status_code instead of a misleading null/timeout row.
-- ============================================================================

select cron.schedule(
  'analyse-posts-ai-sentiment',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://ulnmghcziubfdezshgtl.supabase.co/functions/v1/analyse-posts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsbm1naGN6aXViZmRlenNoZ3RsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MDc0MDQsImV4cCI6MjEwMzk4MzQwNH0.qsooYsKQaPr0UIguR_q3RDYkod-HGGuyEWXo-IaKGdM',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVsbm1naGN6aXViZmRlenNoZ3RsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0MDc0MDQsImV4cCI6MjEwMzk4MzQwNH0.qsooYsKQaPr0UIguR_q3RDYkod-HGGuyEWXo-IaKGdM',
      'x-ingestion-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bluesky_ingestion_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- To pause/remove this schedule without touching Bluesky ingestion:
--   select cron.unschedule('analyse-posts-ai-sentiment');
