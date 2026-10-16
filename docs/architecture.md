# Architecture

**Source-defined, reviewed 2026-10-16.** This describes repository behavior,
not proof that every definition is deployed. Dated production observations live
only in [current status](../CURRENT_PROJECT_STATUS.md); evidence labels and
authority are defined in [operations](operations.md#documentation-authority).

## Components and ownership

```text
Bluesky -> ingestion Edge Function -> raw posts
                                      |
                         analysis Edge Function [disabled]
                                      |
                               Azure Foundry
                                      |
                          V2 analyses + content cache
                                      |
                         scheduled database cache refresh
                                      |
                         public reporting APIs -> browser

Retention: owner-aware expiry of disposable data.
Recovery: abandoned processing -> pending [disabled].
```

| Component | Owns | Does not own |
| --- | --- | --- |
| [Static frontend](../app.js), [HTML](../index.html), [CSS](../styles.css) | Presentation, active-view polling, review pagination/search and chart interactions | Ingestion, AI execution, privileged credentials or database writes |
| [Ingestion worker](../supabase/functions/ingest-bluesky-search/index.ts) | Bluesky session/search, input preparation, bounded collection | Sentiment classification or rewriting existing raw posts |
| [Analysis worker](../supabase/functions/analyse-posts/index.ts) | Prompt/request contract, provider calls, validation, sequential orchestration | Independent ownership decisions or dashboard refresh |
| [Shared controls](../supabase/functions/_shared/costControls.ts) and [lease helper](../supabase/functions/_shared/workerLease.ts) | Bounds, timestamp/text checks, hashing, lease lifecycle and database HTTP timeout | Cron schedules or authoritative database admission |
| [Database](database.md) | Eligibility, leases/fences, atomic persistence/cache ownership, retention, reporting and grants | Guaranteeing exactly-once external provider charges |

There is no alternate active worker, direct OpenAI fallback, translation service,
frontend build framework or tracked CI/deployment workflow.

## Collection

Default admission is hourly. Each admitted invocation authenticates to Bluesky
and searches five rotating terms from 58, at most five results per term and
25 candidates total. Search requests run concurrently with 10-second timeouts.
The `since` parameter uses the configured admission interval. There is no
pagination, immediate retry or missed-interval backfill.

Preparation normalizes whitespace, keeps original-language metadata and source
links, rejects insufficient text and invalid/future/over-720-hour timestamps,
and deduplicates by AT URI. Publication uses the record timestamp, falling back
to its indexed timestamp when absent. Fenced insertion uses conflict-do-nothing;
it does not replace existing content or generate legacy sentiment scores.
The database defaults `fetched_at`.

Partial search failures can still yield successful collection. Response
`candidates` counts prepared rows, not actual new inserts. Failed admission
makes no Bluesky calls; admitted failure consumes the cadence slot.

## Analysis and recovery

**Operating decision: analysis and recovery remain disabled.** The following
describes dormant source behavior, not permission to exercise it.

Authentication precedes the exact `LLM_PROCESSING_ENABLED=enabled` gate.
The worker acquires a lease and resolves the authoritative database prompt
version. A nonempty legacy environment prompt must match. Configuration is
explicit; no model, endpoint or deployment is inferred.

Scheduled mode requests at most twice the batch size in newest-first candidates,
then processes sequentially, with a default/ceiling of five per normal invocation.
Manual mode shares admission and eligibility; it cannot force terminal posts to
be reanalyzed. The normal minimum admission interval is ten minutes.

The content-cache SHA-256 identity includes the exact serialized request,
normalized endpoint, deployment, configured model identity and prompt version.
The request contains system/user messages, original-language note, fixed
taxonomy/schema, minimal reasoning effort and a 2,000 completion-token limit.
Provider HTTP is bounded to 20 seconds; this is not a token/currency budget.

Valid completed cache hits avoid provider calls. In-flight owned content defers;
expired/inactive entries are reclaimable misses. Fenced completion must report
exactly one persisted result and commits result/cache together. Explicitly
failed or complete posts remain terminal; inactive processing may be reclaimed
by selection or the separate recovery sweep. A lost paid response before commit
can cause a later duplicate charge.

AI sentiment describes evaluation of the AI subject, not generic wording tone.
The canonical score is -1..1. The contract separates emotion, one-to-three
canonical topics, factual named tools, explicit product/tool stance and
organic/promotional/spam intent. Historical null content types count as organic.
See the [contract source](../supabase/functions/analyse-posts/index.ts) rather
than maintaining a second taxonomy list here.

## Reporting and browser behavior

Database reporting covers completed organic/unclassified analyses across prompt
versions, published within 720 elapsed hours and not in the future.
Physical retention and reporting filters are independent.

Hourly refresh writes aggregate totals, topics, emotions, stance, hourly trends,
up to 200 recently processed rows and top-20 topic trends. Three generations
are retained. Cache timestamps describe recomputation, not new AI work.
The frontend currently does not render the bounded recent-result feed.

The browser polls only its active view hourly, avoids hidden-tab polling and
uses freshness gating on visibility/view changes. Data Review is loaded on
demand, 100 rows per page, newest publication first, using estimated counts,
400 ms search debounce and one short retry for transient 5xx responses.
Request sequence counters reject superseded review responses.

Display scores map -1..1 to 0..100; SQL computes aggregate display values and
the browser converts individual review scores. Hourly buckets below three
posts have no displayed score. The chart also requires a connected pair of
valid buckets and does not interpolate gaps. A selected topic affects the
trend only, not the entire dashboard.

Emotion shares exclude neutral/nonapplicable categories; the UI displays up to
seven emotions with at least 1% share of meaningful mentions. The topic cloud
excludes Other and shows a bounded high-volume subset. These are display rules,
not changes to stored classifications.

Implemented UI: totals, topics, emotions, topic trends, Organic/Filtered-away
review and per-post provenance. **Not implemented:** geographic map, country
inference, mood-shift detection, AI-generated explanation or broad shared filters.
Hero quotes are curated hardcoded examples. [Demo data](../demo-data.js) is not
loaded by the page. Product intent remains in the [PRD](product-prd.md).

## API contracts

Supabase PostgREST serves the browser under `/rest/v1/` using a publishable key.
Base V2 analyses are not a browser read/write surface.

| Surface | Request and result semantics |
| --- | --- |
| `POST rpc/get_dashboard_v2`, body `{}` | Newest cached object: metadata, totals, topics, emotions, trend and recent rows. Missing/future/over-90-minute cache raises SQLSTATE `55000`; no compute-on-miss fallback. |
| `POST rpc/get_dashboard_v2_trend`, body `{"p_topic":"..."}` | Cached overall trend for null topic, cached top-topic result when present, otherwise live topic aggregation after the same freshness gate. Returns topic/prompt metadata and trend buckets. |
| `GET completed_post_analyses_v2` | Recent completed rows joined to raw text/source/provenance, across prompt versions and content types. Review filters organic/null versus promotional/spam and searches text, author and topics. |
| Raw-post REST reads | Available under existing raw read policy; used for recorded timestamp-only operational corroboration, not the current main dashboard data source. |
| `POST /functions/v1/ingest-bluesky-search` | Server secret required. Success reports `searchedTerms`, `failedSearches`, `candidates`; admission may return a skip. Check persisted rows separately. |
| `POST /functions/v1/analyse-posts` | Server secret required. Disabled gate returns zero selected/completed/failed and `skipped: processing disabled`. Valid nonempty string `post_uri` selects manual mode; absent, malformed or non-string input falls back to batch mode, not a validation error. |

Both Edge handlers reject non-POST or incorrect-secret requests with 401.
Gateway JWT checks, if enabled in hosting, are an additional boundary.
Enabled analysis responses distinguish selected/completed/failed, skips and
batch scanned/results; admission/error paths do not all share one response shape.
HTTP 200 may mean disabled, busy, already processed, cached completion or a
failed individual analysis. Manual invocations omit batch telemetry.

Public cache APIs are distinct from privileged compute, refresh, retention,
recovery and fenced-write RPCs. See [database definitions](database.md#effective-definition-map)
and [operational checks](operations.md#read-only-health-checks).
