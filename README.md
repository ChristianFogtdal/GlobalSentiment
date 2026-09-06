# Global Mood Intelligence

A desktop-first interactive dashboard for exploring aggregated public sentiment. It presents the overall mood score, emotional composition, discussion topics, detected shifts, representative signals, and country-level mood on an interactive map.

## Run locally

The application is static. Serve this folder with any web server, for example:

```powershell
node -e "const http=require('http'),fs=require('fs'),path=require('path');http.createServer((req,res)=>{const file=path.join(process.cwd(),req.url==='/'?'index.html':decodeURIComponent(req.url));fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);return res.end('Not found');}const type={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type});res.end(data);});}).listen(4173)"
```

Open `http://localhost:4173`.

## Data and dependencies

- The dashboard reads completed V2 analyses from Supabase Postgres; it does not call Bluesky directly. Scheduled ingestion collects public Bluesky posts, and the Foundry worker enriches them before they appear in dashboard aggregates.
- The Bluesky AT URI is the primary key, so repeat searches do not add duplicate rows. Data review displays the full archived time series.
- New ingested posts retain Bluesky's declared original-language tag (such as `en`, `es`, or `pt-BR`). Translation is not performed.
- See `global-mood-intelligence-prd.md` for the product scope and responsible-AI constraints.

## Scheduled Bluesky ingestion

The `supabase/` directory contains the secure ingestion function and migration. The browser only reads the Supabase archive. Every scheduled run retrieves up to 5 recent public posts for each configured AI-related phrase. AT URI deduplication prevents repeat searches from adding the same post.

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
`post_analyses_v2`, which is isolated from the existing `post_analyses` legacy table. Completed V2
results are exposed to the dashboard through narrowly scoped read-only views and aggregate RPCs.

Configure these secrets on the function before invoking it or enabling its schedule:

- `AZURE_FOUNDRY_ENDPOINT`
- `AZURE_FOUNDRY_API_KEY`
- `AZURE_FOUNDRY_DEPLOYMENT`
- `AZURE_FOUNDRY_MODEL`
- `LLM_PROCESSING_ENABLED` (must be exactly `enabled`, otherwise the function exits before
  selecting or calling any post)
- `LLM_BATCH_SIZE` (optional; defaults to 10, hard-clamped to a ceiling of 50 regardless of
  configured value)

The active V2 prompt version is **not** an independent function secret. It is resolved at runtime
by the worker from the single authoritative database source, `public.get_active_prompt_version()`
(see `supabase/migrations/20260904090000_active_prompt_version_contract.sql`). Update the active
prompt version by updating that single database row
(`update public.app_settings set value = '...' where key = 'active_prompt_version'`); the
`(post_uri, prompt_version)` uniqueness constraint then creates forward-only analyses without
changing historical V2 rows.

The dashboard and V2 Data Review include all completed prompt versions to preserve historical
continuity. Each V2 review row displays its prompt version for auditability; analytics across
versions must account for any prompt-contract changes.

`LLM_PROMPT_VERSION` may still be set on the function as a transitional legacy value during
deployment migration. If present, it is validated against the database value on every invocation
and the worker fails closed (claims and processes nothing) on any mismatch. Remove this env var entirely once
all environments have migrated to the database-resolved value.

### V2 AI-Sentiment taxonomy contract

For the new prompt version, `sentiment` is **AI Sentiment**: the author's evaluation of the AI
technology, company, model, deployment, or AI-related development under discussion. It is not
generic textual tone. `positive`, `negative`, `neutral`, and `mixed` respectively mean endorsement,
criticism/harm, factual reporting without an evaluative position, and material positive plus
negative views. `sentiment_score` stays in `[-1, 1]` and agrees with its category.

Topics contain one to three unique labels from this fixed taxonomy:
`Reliability, Accuracy, Quality, Performance, Capabilities, Innovation, Safety, Security, Privacy,
Trust, Transparency, Explainability, Bias, Fairness, Automation, Productivity, Efficiency,
Usability, Accessibility, Personalization, Integration, Deployment, Scalability, Availability,
Compatibility, Cost, Pricing, Business Value, ROI, Competition, Market Adoption, Economic Impact,
Employment Impact, Regulation, Governance, Ethics, Copyright, Digital Rights, Public Opinion,
Political Impact, Misinformation, Education, Learning, Research, Healthcare, Environmental Impact,
Open Source, Community, Risk, Opportunity, Other`. `Other` is used only where no listed label
fits. Emotions are independently selected from: `excitement, optimism, trust, curiosity,
admiration, relief, neutral, surprise, confusion, concern, skepticism, uncertainty, frustration,
disappointment, fear, anger, awe, hype, doubt, urgency`.

`ai_tooling_stance` remains a separate **Product/Tool Stance**. It is populated only for an
explicit evaluation of a named AI product or tool; factual named-tool mentions and general AI posts
use `not_applicable`. `tools_mentioned` remains factual entity extraction.

Legacy analyses remain keyword-based generic tone and are not comparable to this V2 AI Sentiment.
Existing Legacy and V2 records, including historic free-form topic variants, are intentionally
retained and are not backfilled.

### Manual single-post invocation

Supplying an explicit `post_uri` in the request body bypasses batching entirely and processes at
most that one post, making at most one Foundry provider call — this preserves the original
one-post manual-test behavior for debugging or targeted reprocessing.

### Scheduled batch invocation

With no `post_uri` in the request body, the function selects up to `LLM_BATCH_SIZE` eligible posts
(oldest `bluesky_posts.published_at` first, excluding posts that already have a
`post_analyses_v2` row for the current database-resolved active prompt version) and processes them **sequentially**
— never concurrently. A per-post Foundry or validation failure is recorded as `status='failed'`
with a sanitized `error_message`, and the batch continues to the next candidate rather than
aborting. There is no automatic retry in this phase; failed rows are simply not reprocessed
because they already occupy the `(post_uri, prompt_version)` unique slot.

A cron schedule (see `supabase/migrations/20260903140000_increase_analyse_posts_throughput.sql`,
named `analyse-posts-ai-sentiment`) fires every 5 minutes with an empty request body. It reuses the same Vault-secret pattern
(`bluesky_ingestion_secret`) for its `x-ingestion-secret` header. It can be paused independently of
Bluesky ingestion with `select cron.unschedule('analyse-posts-ai-sentiment');`.

There is **no automated daily/run cost cap** — Foundry spend is throttled solely by
cron cadence (5 minutes) × batch size (configured in `LLM_BATCH_SIZE`). If spend becomes a concern,
unschedule the cron job manually or reduce `LLM_BATCH_SIZE`; a future phase should add an explicit cost/quota
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
manual verification surface, independent of the main Dashboard/map:

- Both sources are ordered by `published_at desc`, so the review starts with the most recently
  published posts regardless of when the pipeline analyzed them.
- V2's canonical `sentiment_score` is `[-1, 1]`; the UI converts it to a 0-100 display score with
  `displayScore = round((sentiment_score + 1) * 50)` — the database itself performs no conversion.
- Curated always-visible V2 columns: Published Date, AI Sentiment score, AI Sentiment, Tools Mentioned, Topics,
  Confidence, Provider, Processed At. All other V2 fields (raw `sentiment_score`, `emotions`,
  `ai_tooling_stance`, `rationale`, `deployment`, `model`, `prompt_version`) are available per-row
  via a "View" details expander. `ai_tooling_stance = 'not_applicable'` is labeled "Not applicable" as
  Product/Tool Stance in the UI.

### Main Dashboard/map: compact, all-version aggregate (not a full-archive download)

The main Dashboard/map aggregation (`selectedData()` / `archiveDashboardData()`) is sourced from a
single server-side RPC, `public.get_dashboard_v2()` (see
`supabase/migrations/20260904091500_dashboard_v2_aggregate_rpc.sql`), loaded via `loadDashboardV2()`.
The browser no longer paginates through the full `completed_post_analyses_v2` archive to build the
dashboard: the RPC computes full-history totals, topic/emotion/stance aggregates, and hourly trend
buckets in SQL across all `status = 'complete'` V2 prompt versions, and returns them in one compact response alongside a bounded
recent-post feed (`dashboardV2.recent`, currently the 200 most recently processed rows). Full-history
metrics and the trend chart therefore remain historically accurate even though the browser never
downloads the full archive — only Data Review does that, via its own paginated/searchable queries.

Topic-filtered trend views (the trend chart's topic dropdown) call a companion RPC,
`public.get_dashboard_v2_trend(p_topic)`, on demand only when a specific topic is selected; the
"all topics" trend is already included in the main aggregate.

The Data review tab's Legacy/V2 toggle is unaffected by this and remains available for
side-by-side comparison and ongoing spot-checking of individual V2 rows — it includes all completed
prompt versions and uses its own separate
`bluesky` (legacy) / `blueskyV2` (V2) state, distinct from the dashboard's `dashboardV2` state, and
does not filter V2 queries to only the active prompt version.


See `DEPLOYMENT_SECRETS.txt` at the repo root for the full names-only secret template. Do not
commit secret values, `.env` files, or logs containing credentials.
