# Global Mood Intelligence

A desktop-first interactive dashboard for exploring aggregated public sentiment. It presents the overall mood score, emotional composition, discussion topics, detected shifts, representative signals, and country-level mood on an interactive map.

## Run locally

The application is static. Serve this folder with any web server, for example:

```powershell
node -e "const http=require('http'),fs=require('fs'),path=require('path');http.createServer((req,res)=>{const file=path.join(process.cwd(),req.url==='/'?'index.html':decodeURIComponent(req.url));fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);return res.end('Not found');}const type={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type});res.end(data);});}).listen(4173)"
```

Open `http://localhost:4173`.

## Data and dependencies

- The dashboard uses the demo dataset in `demo-data.js`.
- The dashboard reads the shared historical archive from Supabase Postgres; it does not call Bluesky directly. A scheduled Supabase Edge Function searches public Bluesky posts every 15 minutes for the configured AI-coding keywords and writes matching posts to the archive.
- The Bluesky AT URI is the primary key, so repeat searches do not add duplicate rows. Data review displays the full archived time series.
- New ingested posts retain Bluesky's declared original-language tag (such as `en`, `es`, or `pt-BR`). Translation is not performed.
- Leaflet, map tiles, and country boundary data are loaded from public CDNs at runtime.
- See `global-mood-intelligence-prd.md` for the product scope and responsible-AI constraints.

## Scheduled Bluesky ingestion

The `supabase/` directory contains the secure ingestion function and migration. The browser only reads the Supabase archive. Every 15 minutes, the function retrieves up to 10 recent public posts for each of 24 AI-related phrases: core AI concepts, products, AI coding, and societal impact. AT URI deduplication prevents repeat searches from adding the same post.

Before deployment, configure `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`, and a long random `INGESTION_SECRET` as Supabase Edge Function secrets. Create a matching Vault secret and schedule the function only after the function is deployed:

```sql
select vault.create_secret('your-long-random-ingestion-secret', 'bluesky_ingestion_secret');

select cron.schedule(
  'ingest-bluesky-ai-coding-posts',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://bsnzcspfrmlihwxqkjyv.supabase.co/functions/v1/ingest-bluesky-search',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer your-supabase-publishable-key',
      'apikey', 'your-supabase-publishable-key',
      'x-ingestion-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bluesky_ingestion_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

## Scheduled batch Foundry sentiment-enrichment slice (`analyse-posts`)

This function processes Bluesky posts through a Foundry deployment that you select and deploy
yourself in Azure AI Foundry. The code does not choose, deploy, or infer a model, endpoint, or API
version, and the browser never sees Foundry credentials or endpoints. Results are persisted to
`post_analyses_v2`, which is isolated from the existing `post_analyses` / `completed_post_analyses`
legacy tables and is not exposed to the dashboard.

Configure these secrets on the function before invoking it or enabling its schedule:

- `AZURE_FOUNDRY_ENDPOINT`
- `AZURE_FOUNDRY_API_KEY`
- `AZURE_FOUNDRY_DEPLOYMENT`
- `AZURE_FOUNDRY_MODEL`
- `LLM_PROMPT_VERSION`
- `LLM_PROCESSING_ENABLED` (must be exactly `enabled`, otherwise the function exits before
  selecting or calling any post)
- `LLM_BATCH_SIZE` (optional; defaults to 10, hard-clamped to a ceiling of 50 regardless of
  configured value)

### Manual single-post invocation

Supplying an explicit `post_uri` in the request body bypasses batching entirely and processes at
most that one post, making at most one Foundry provider call — this preserves the original
one-post manual-test behavior for debugging or targeted reprocessing.

### Scheduled batch invocation

With no `post_uri` in the request body, the function selects up to `LLM_BATCH_SIZE` eligible posts
(oldest `bluesky_posts.published_at` first, excluding posts that already have a
`post_analyses_v2` row for the current `LLM_PROMPT_VERSION`) and processes them **sequentially**
— never concurrently. A per-post Foundry or validation failure is recorded as `status='failed'`
with a sanitized `error_message`, and the batch continues to the next candidate rather than
aborting. There is no automatic retry in this phase; failed rows are simply not reprocessed
because they already occupy the `(post_uri, prompt_version)` unique slot.

A cron schedule (see `supabase/migrations/20260903100000_scheduled_analyse_posts.sql`, named
`analyse-posts-ai-sentiment`) fires every 15 minutes with an empty request body, matching the
existing `ingest-bluesky-search` cadence. It reuses the same Vault-secret pattern
(`bluesky_ingestion_secret`) for its `x-ingestion-secret` header. It can be paused independently of
Bluesky ingestion with `select cron.unschedule('analyse-posts-ai-sentiment');`.

There is **no automated daily/run cost cap** in this phase — Foundry spend is throttled solely by
cron cadence (15 minutes) × batch size (default 10). If spend becomes a concern, unschedule the
cron job manually or reduce `LLM_BATCH_SIZE`; a future phase should add an explicit cost/quota
ledger before scaling batch size or cadence further.

Invocation (manual or scheduled) requires a server-side scheduler/admin secret; it cannot be
triggered from the browser or with only the publishable key.

## V2 sentiment data in the "Data review" tab (validation only)

`post_analyses_v2` itself remains service-role-only (no anon/authenticated access). A separate,
narrowly-scoped view — `public.completed_post_analyses_v2` (see
`supabase/migrations/20260903123451_completed_post_analyses_v2_view.sql`) — exposes only
`status = 'complete'` V2 rows joined to `bluesky_posts`, granted `SELECT` to `anon`/`authenticated`,
mirroring the legacy `completed_post_analyses` view's access pattern. This view excludes
queue-internal fields (`status`, `error_message`, `locked_until`, `retry_count`, `id`).

The Data review tab has a **Source** toggle (Legacy / V2 (Foundry)) that switches its query between
the legacy `completed_post_analyses` view and this new `completed_post_analyses_v2` view. This is a
manual verification surface only:

- The main Dashboard/map view always reads the legacy source and is unaffected by this toggle.
- V2 rows are ordered by `processed_at desc, published_at desc` (most recently analyzed first),
  distinct from the legacy tab's `created_at desc` ordering.
- V2's canonical `sentiment_score` is `[-1, 1]`; the UI converts it to a 0-100 display score with
  `displayScore = round((sentiment_score + 1) * 50)` — the database itself performs no conversion.
- Curated always-visible V2 columns: Published Date, Score, Sentiment, Tools Mentioned, Topics,
  Confidence, Provider, Processed At. All other V2 fields (raw `sentiment_score`, `emotions`,
  `ai_tooling_stance`, `rationale`, `deployment`, `model`, `prompt_version`) are available per-row
  via a "View" details expander. `ai_tooling_stance = 'not_applicable'` is labeled "N/A" in the UI.

There is no scheduler/dashboard cutover implied by this: replacing the legacy source on the main
Dashboard/map is an explicitly separate, not-yet-started future proposal.


See `DEPLOYMENT_SECRETS.txt` at the repo root for the full names-only secret template. Do not
commit secret values, `.env` files, or logs containing credentials.

