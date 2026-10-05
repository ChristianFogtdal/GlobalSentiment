# Global Mood Intelligence

A desktop-first interactive dashboard for exploring aggregated public sentiment. It presents the overall mood score, emotional composition, discussion topics, detected shifts, representative signals, and country-level mood on an interactive map.

The current operating policy is a rolling 30-day sample, not a historical archive.
Live-schema correction: raw posts use required `published_at` for retention and
reporting, and database-defaulted `fetched_at` for collection time. They have no
`created_at` column. Local SQL tests now use this observed schema. The user's
live-only/no-backup decision is recorded in the safety report; it is not proof
that native or staging validation passed.
**Live status, 2026-10-05:** both Edge Functions were reported deployed; hourly
ingestion, dashboard refresh and retention are enabled. Azure/LLM processing and
the analysis/recovery schedules remain disabled. After approved cleanup and V2
compaction, SQL reported 475 MB database size (previously 585 MB). Hosted ingestion
and cache-refresh success remain unverified; further smoke tests were skipped.
The local frontend deployment is not confirmed. The correctness repair,
reproduction evidence and live operator record are in
[PRODUCTION_SAFETY.md](PRODUCTION_SAFETY.md). That report supersedes the earlier
cost-optimization concurrency, cache-expiry, audit-retention and rollback claims.
Real multi-session PostgreSQL and timeout tests remain unexecuted.
See [COST_OPTIMIZATION.md](COST_OPTIMIZATION.md) for the source audit, table/index
inventory, exact settings, estimates, validation results, and deployment sequence.
For new deployments, the retention job is installed **inactive**, with a second database enable
gate. Preview counts with [retention-operations.sql](supabase/scripts/retention-operations.sql)
and obtain approval before enabling deletion. Local edits do not deploy Supabase
changes. Reconcile the live schema before applying migrations: this live project
has no migration ledger, and historical baselines are local fixtures only.

## Run locally

The application is static. Serve this folder with any web server, for example:

```powershell
node -e "const http=require('http'),fs=require('fs'),path=require('path');http.createServer((req,res)=>{const file=path.join(process.cwd(),req.url==='/'?'index.html':decodeURIComponent(req.url));fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);return res.end('Not found');}const type={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream';res.writeHead(200,{'Content-Type':type});res.end(data);});}).listen(4173)"
```

Open `http://localhost:4173`.

## Data and dependencies

- The dashboard reads completed V2 analyses from Supabase Postgres; it does not call Bluesky directly. Scheduled ingestion collects public Bluesky posts, and the Foundry worker enriches them before they appear in dashboard aggregates.
- The Bluesky AT URI is the primary key, so repeat searches do not add duplicate rows or update stored content. Data review queries the last 30 days.
- New ingested posts retain Bluesky's declared original-language tag (such as `en`, `es`, or `pt-BR`). Translation is not performed.
- See `global-mood-intelligence-prd.md` for the product scope and responsible-AI constraints.

## Scheduled Bluesky ingestion

The `supabase/` directory contains the secure ingestion function and migrations.
The browser never calls Bluesky. Defaults: one hourly run, five rotating search
terms, five posts per term, at most 25 posts per run. The full set of 58 terms
rotates over time. Search requests use a recent `since` timestamp; local validation
rejects old, invalid and future dates and content with insufficient text. URI
deduplication precedes one insert batch with `ON CONFLICT DO NOTHING` semantics.
New rows no longer store unused keyword-based legacy sentiment scores.

Before deployment, configure `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`, and a long random `INGESTION_SECRET` as Supabase Edge Function secrets. Create a matching Vault secret and schedule the function only after the function is deployed:

```sql
select vault.create_secret('your-long-random-ingestion-secret', 'bluesky_ingestion_secret');

select cron.schedule(
  'ingest-bluesky-ai-coding-posts',
  '0 * * * *',
  $$
  select net.http_post(
    url := 'https://bsnzcspfrmlihwxqkjyv.supabase.co/functions/v1/ingest-bluesky-search',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer your-legacy-anon-jwt',
      'apikey', 'your-legacy-anon-jwt',
      'x-ingestion-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'bluesky_ingestion_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

This is a template for a new schedule, not a command to overwrite the live job.
With hosted gateway JWT verification enabled, use a valid legacy anon JWT in
the Bearer header, not an `sb_publishable_*` key. The separate ingestion secret
is still required. Keep actual secret values out of source control. A successful
manual authenticated request does not verify the stored cron command's headers.

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
- `LLM_BATCH_SIZE` (optional; defaults to 5, hard-clamped to a ceiling of 5 regardless of
  configured value)

The active V2 prompt version is **not** an independent function secret. It is resolved at runtime
by the worker from the single authoritative database source, `public.get_active_prompt_version()`
(see `supabase/migrations/20260904090000_active_prompt_version_contract.sql`). Update the active
prompt version by updating that single database row
(`update public.app_settings set value = '...' where key = 'active_prompt_version'`).
Existing posts are not automatically reanalysed after version changes. The
`(post_uri, prompt_version)` unique constraint remains an additional safety net.
Use a new version when changing a deployment's model behavior in place.

The dashboard and V2 Data Review include all completed prompt versions within the
recent window. Each V2 review row displays its prompt version for auditability; analytics across
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
Existing Legacy and V2 records are not backfilled. They expire with their raw
post's publication date once retention is enabled; legacy orphan analyses use
their own creation date. No reporting schema or provenance columns are dropped.

### Manual single-post invocation

Supplying `post_uri` processes at most one recent, unclaimed post. Manual requests
share the same database admission and content-cache checks as scheduled requests;
they cannot bypass the cost cap or force repeat processing.

### Scheduled batch invocation

The worker selects recent unclaimed posts, newest first, with a bounded 2x
candidate overfetch. Five posts per batch run sequentially, every ten minutes
(`5-59/10 * * * *`), for at most 30 provider calls per UTC hour. Admission is
atomic and shared with manual requests. There is no monetary/token quota.

`claim_post_analysis_fenced` combines eligibility, ownership and cache lookup.
SHA-256 keys cover the exact transmitted Foundry request, endpoint, model
revision and prompt version. Matching valid completed inputs reuse validated
results; live in-flight inputs defer. `finish_post_analysis` commits the owned
result and cache together and must return exactly one persisted result. Foundry
calls time out after 20 seconds. Expired or ownerless cache entries can be
reclaimed; an explicitly failed post is not automatically retried.

Workers now acquire an owner-token/fence lease, renew it before paid calls, and
write only through fenced RPCs. Expired cache entries are misses. Abandoned
processing can be recovered; this may repeat an ambiguous external request
after a crash, but stale workers cannot persist results. Operational/audit
history is excluded from deletion. See the safety report for the rollout order.

The scheduler still uses the Vault `bluesky_ingestion_secret` and function
`INGESTION_SECRET`. Pausing a job does not change credentials or RLS.

Invocation (manual or scheduled) requires a server-side scheduler/admin secret; it cannot be
triggered from the browser or with only the publishable key.

## V2 sentiment data in the "Data review" tab (validation only)

`post_analyses_v2` itself remains service-role-only (no anon/authenticated access). A separate,
narrowly-scoped view — `public.completed_post_analyses_v2` (see
`supabase/migrations/20260903123451_completed_post_analyses_v2_view.sql`) — exposes only
`status = 'complete'` V2 rows joined to `bluesky_posts`, granted `SELECT` to `anon`/`authenticated`,
mirroring the legacy `completed_post_analyses` view's access pattern. This view excludes
queue-internal fields (`status`, `error_message`, `locked_until`, `retry_count`, `id`).

The Data review tab's **Source** toggle switches between organic and filtered
(promotional/spam) V2 posts. Both query `completed_post_analyses_v2`, independently
of the main Dashboard/map:

- Both sources are ordered by `published_at desc`, so the review starts with the most recently
  published posts regardless of when the pipeline analyzed them.
- V2's canonical `sentiment_score` is `[-1, 1]`; the UI converts it to a 0-100 display score with
  `displayScore = round((sentiment_score + 1) * 50)` — the database itself performs no conversion.
- Curated always-visible V2 columns: Published Date, AI Sentiment score, AI Sentiment, Tools Mentioned, Topics,
  Confidence, Provider, Processed At. All other V2 fields (raw `sentiment_score`, `emotions`,
  `ai_tooling_stance`, `rationale`, `deployment`, `model`, `prompt_version`) are available per-row
  via a "View" details expander. `ai_tooling_stance = 'not_applicable'` is labeled "Not applicable" as
  Product/Tool Stance in the UI.

### Main Dashboard/map: compact 30-day aggregate

The main Dashboard/map aggregation (`selectedData()` / `archiveDashboardData()`) is sourced from a
single server-side RPC, `public.get_dashboard_v2()` (see
`supabase/migrations/20260904091500_dashboard_v2_aggregate_rpc.sql`), loaded via `loadDashboardV2()`.
The browser no longer paginates through the full `completed_post_analyses_v2` archive to build the
dashboard: hourly cache refreshes compute 30-day totals, topic/emotion/stance
aggregates and hourly trend buckets across organic completed V2 prompt versions.
The cache returns one compact response with the 200 most recently processed rows.
The browser polls only its active view once per hour and loads review pages on
demand. Hourly buckets with fewer than three posts have no displayed score.
Reduced sampling preserves a useful overall signal, not guaranteed topic-level
coverage or a representative measure of global public opinion.

Topic-filtered trend views (the trend chart's topic dropdown) call a companion RPC,
`public.get_dashboard_v2_trend(p_topic)`, on demand only when a specific topic is selected; the
"all topics" trend is already included in the main aggregate.

Data Review includes recent completed prompt versions and uses separate state
from the dashboard. It does not preload or poll while hidden.

## Validation

On a machine permitting Deno, run `deno test --allow-env supabase/functions`,
`deno check supabase/functions/analyse-posts/index.ts supabase/functions/ingest-bluesky-search/index.ts`,
and `deno lint supabase/functions`. This workstation blocks native Deno execution.
The permitted Node compatibility suite, strict TypeScript check, ESLint check,
and embedded PostgreSQL tests are documented in [COST_OPTIMIZATION.md](COST_OPTIMIZATION.md).
Never commit secret values, environment files, or credential-bearing logs.
