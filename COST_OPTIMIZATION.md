# Recent Sentiment Cost Controls

> Live schema verified from user-supplied catalog results on 2026-10-05:
> raw posts have required `published_at` and defaulted `fetched_at`, not
> `created_at`. The pending SQL and local fixtures are corrected accordingly;
> old raw-creation fallback assumptions in this historical audit are superseded.
> The user accepted no backup and no staging; see the safety report for scope.

> Superseded safety claims: [PRODUCTION_SAFETY.md](PRODUCTION_SAFETY.md) is the
> authoritative correctness/rollout report after the independent review.
> Operational/audit logs are now protected indefinitely. Lease fencing replaces
> start-time admission, expired cache entries are recoverable misses, and crashed
> processing is retryable. The previous at-most-once, timeout and rollback claims
> below describe the reviewed implementation, not production guarantees. Direct
> worker table writes are now revoked; native concurrency/cancellation tests
> remain unexecuted. The user subsequently approved live retention and manual
> cleanup without staging or backup. On 2026-10-05, SQL read-back after V2
> compaction showed 475 MB, down from 585 MB. Ingestion, cache refresh and
> retention schedules are active; LLM analysis and recovery are disabled.
> See the safety report's live rollout outcome for evidence and limitations.

## Audit Before Changes (2026-10-05)

Scope: both Edge Functions, their tests, all tracked SQL migrations, Supabase
configuration, browser data access and supporting product/history documents.
There is no tracked CI, package manifest, other worker, or queue consumer.
This is a source audit, not a measurement of the hosted database. The worktree
was clean. Hosted secrets, jobs, extra tables/triggers and actual row counts
have not been inspected. No hosted writes or deletion have been authorized.

### Data Flow And Storage

- [ingest-bluesky-search](supabase/functions/ingest-bluesky-search/index.ts)
  authenticates to Bluesky `com.atproto.server.createSession`, then runs all 58
  `app.bsky.feed.searchPosts` searches concurrently, five posts per term. Maximum
  290 candidates and 59 external requests/run, before overlap. No pagination,
  network retries, request timeout, distributed run guard, or hourly quota.
- In-memory URI deduplication precedes one `bluesky_posts` upsert using
  `onConflict: 'uri', ignoreDuplicates: true`. The URI primary key already
  prevents duplicate inserts and unchanged updates. Raw rows also contain
  redundant deterministic legacy sentiment fields produced by `analysePost`.
- [analyse-posts](supabase/functions/analyse-posts/index.ts) resolves
  `get_active_prompt_version`, selects through `select_unanalysed_posts`, inserts
  one processing row per post and sends one Azure Foundry chat completion per
  claim. Completion writes the validated fields, not the full provider response.
  There is no verified provider multi-input batch contract. Requests allow 2,000
  completion tokens with minimal reasoning effort. No HTTP timeout or retry.
- `LLM_PROCESSING_ENABLED=enabled` gates the worker. `LLM_BATCH_SIZE` defaults to
  10, ceiling 25; selection overfetch multiplier is 2. Foundry endpoint/key,
  deployment/model and Supabase service credentials are server-only.
  `LLM_PROMPT_VERSION`, when present, must match `app_settings.active_prompt_version`.
- V2 uniqueness is `(post_uri,prompt_version)`. The insert trigger marks
  `bluesky_posts.has_v2_analysis=true`. Automatic selection uses its partial
  published-time index and skips **all** previously claimed versions/statuses.
  Failed claims currently swallow every database error as though it were a
  duplicate. There is no content cache across different URIs.
- [stale recovery](supabase/migrations/20260914201500_reclaim_stuck_processing_analyses.sql)
  deletes processing rows after ten minutes and resets the raw marker. That can
  repeat a paid AI call whose response/persistence was lost. Legacy
  `claim_posts_for_analysis` defaults to batch 10 / maximum retries 3, but no
  tracked worker or schedule calls it. `ensure_analysis_records`,
  `update_analysis_result`, and `mark_analysis_failed` remain legacy RPCs.
- [dashboard refresh](supabase/migrations/20260914091500_dashboard_v2_cache_refresh_functions.sql)
  computes full-history organic aggregates and top-20 topic trends, writes one
  JSON cache generation plus one log row, and keeps three generations. A session
  advisory lock avoids concurrent refreshes. Refresh timeout is 240 seconds;
  compute functions have 20-second settings and 256 MB work memory. Historical
  comments report 60-140 second refreshes; these are not current measurements.
- [browser](app.js) polls every five minutes, fetching both the dashboard cache
  and an unused review page, and refetches on every visibility change. Review
  pages are 100 rows with estimated counts, 400 ms search debounce and one
  300 ms retry after 5xx. Cached topic misses run live aggregate SQL. Static HTML,
  CSS and demo data contain no database writers or collection workers.

### Tables And Retention

| Table | Relevant time | Existing retention / action needed | Relevant index |
| --- | --- | --- | --- |
| `bluesky_posts` | `published_at`, fallback `created_at` | Unbounded raw posts; expire by publication age, not ingestion age | existing `bluesky_posts_published_at_idx`; add fallback expression index |
| `post_analyses` | parent publication time; orphan `created_at` | Unbounded legacy analyses; delete before raw parents, expire old orphans | existing `post_analyses_post_uri_idx`, `post_analyses_created_at_idx` |
| `post_analyses_v2` | parent publication time | Unbounded analyses/claims/errors; FK to raw URI has no cascade | existing `post_analyses_v2_post_uri_idx`, `post_analyses_v2_created_at_idx` |
| `analyse_posts_invocation_log` | `started_at` | Unbounded run telemetry; expire after 30 days | existing `analyse_posts_invocation_log_started_at_idx` |
| `dashboard_v2_cache_refresh_log` | `started_at` | Unbounded refresh telemetry; expire after 30 days | existing `dashboard_v2_cache_refresh_log_started_at_idx` |
| `dashboard_v2_cache` | `generated_at` | Protected aggregate; exclude from retention; preserve existing three-generation replacement | existing `dashboard_v2_cache_generated_at_idx` |
| `app_settings` | `updated_at` | Protected configuration; never expire | primary key `key` |

The inventory has seven application tables, including `app_settings`.
Completed-analysis, dev-validation and invocation-stats objects
are views, not independent storage. No application-owned auth, billing or
user-managed tables are defined. Do not infer that hosted schemas contain none.
Vault/auth/storage schemas, `cron.job`, `cron.job_run_details`, pg_net queues and
response tables are outside application cleanup. Inspect extension-managed TTLs
and operational log growth separately; no custom deletion is added for them.

### Scheduled Jobs: Latest Tracked State

| Job | Old frequency | Evidence |
| --- | --- | --- |
| `ingest-bluesky-ai-coding-posts` | Every 15 minutes, documented only | [README](README.md); earliest ingestion migration only sets RLS/index, not cron |
| `analyse-posts-ai-sentiment` | `*/2 * * * *`, 30/hour | [cadence experiment](supabase/migrations/20260914213000_analyse_posts_cadence_experiment.sql) |
| `dashboard-v2-cache-refresh-safety-net` | `2-59/5 * * * *`, 12/hour | [cache offset](supabase/migrations/20260914165500_dashboard_v2_cache_cron_offset.sql) |
| `reclaim-stuck-processing-analyses` | `3-59/10 * * * *`, 6/hour | [stale recovery](supabase/migrations/20260914201500_reclaim_stuck_processing_analyses.sql) |

Earlier analysis schedules (15 then 5 minutes) are superseded. The README also
misstates the analysis ceiling as 50 and describes an obsolete Legacy/V2 review
toggle; current UI distinguishes organic versus promotional/spam V2 posts.
`config.toml` disables JWT verification for both functions; the functions require
the shared ingestion secret. This authentication boundary must be preserved.

### Largest Drivers

1. Unbounded raw text, structured analyses, indexes and telemetry accumulation.
2. Up to 236 Bluesky HTTP requests/hour and 1,160 fetched candidates/hour under
   the documented ingestion cadence, with repeated overlapping term searches.
3. Up to 750 Foundry calls/hour at batch ceiling, or 300/hour at unset default,
   plus possible repeat calls after stale claims are deleted.
4. Full-history cache recomputation 288 times/day; browser polling and unnecessary
   review reads; per-post claim/update plus raw-marker trigger writes.

## Implementation Assumptions

- Favor overall directional trends over exhaustive coverage. Default to 25
  Bluesky candidates/hour, five rotating search terms with five results each;
  all 58 terms rotate rather than favoring a permanent prefix. Search matching
  is not a representative sample of all public opinion. Preserve low-sample
  suppression (three posts/hour) and do not promise reliable narrow topic trends.
- Raw/analysis age follows publication time, falling back to raw creation time
  for legacy null dates. A record exactly at `now() - interval '30 days'` stays.
  Missing/invalid or future publication dates in new ingestion are rejected.
- Preserve existing reporting fields, provenance, RLS and historical schema.
  Stop populating unused keyword scores on new raw rows, without dropping columns.
- Never automatically retry an ambiguous paid AI attempt. Cache keys include
  exact prompt input, language, prompt version and provider identity. Changing
  model behavior in place requires a new prompt version. Cache TTL is 30 days.
- Install retention disabled, review counts and hosted schema first, and enable
  only with explicit operator approval. Batched physical deletion is eventually
  consistent; reporting independently filters the rolling window.

## Validation And Deployment

Native Deno is blocked by this machine's Device Guard; no attempt was made to
bypass it. Hosted migration execution is out of scope. No production data,
secrets, schedules or other external records were changed.

## Implemented Defaults

| Control | Before | After |
| --- | --- | --- |
| Collection schedule | Documented `*/15 * * * *` | `0 * * * *` |
| Search requests/run | 58 | 5, rotating over 58 terms |
| Results/search | 5 | 5 |
| Candidate ceiling/run | 290 | 25 |
| Candidate ceiling/hour | 1,160, assuming documented cadence | 25 default; configurable up to 100 |
| Analysis schedule | `*/2 * * * *` | `5-59/10 * * * *` |
| Analysis batch default / ceiling | 10 / 25 | 5 / 5 |
| Analysis provider ceiling/hour | 300 default / 750 ceiling | 30 ceiling, typically <=25 once backlog clears |
| Cache refresh | `2-59/5 * * * *` | `58 * * * *` |
| Stale-claim sweep | `3-59/10 * * * *`, delete and retry | `52 * * * *`, mark failed, max 1,000 rows |
| Cleanup | None | `48 * * * *`, inactive until approved |
| Browser polling | Two reads every five minutes | One active-view read/hour; freshness-gated visibility events |

The run gate uses UTC buckets anchored at 2000-01-01 and a three-minute minimum
gap to prevent near-boundary overlap. Hourly limits mean UTC clock hours, not
every sliding 60-minute interval. The default 25/run remains below 100 even
across two adjacent hourly buckets. There is only one source; adding other
sources requires extending the shared budget enforcement. Requests denied by
the gate make no external API calls and no row updates. Failed admitted runs
consume their interval; there is no immediate retry or pagination/backfill.

### Environment And Configuration

| Setting | Default | Allowed behavior |
| --- | --- | --- |
| `INGEST_INTERVAL_MINUTES` | 60 | Integer 60-1440; larger values reduce admissions, not cron wake-ups |
| `INGEST_POSTS_PER_SOURCE` | 25 | Integer 1-100, clamped by hourly cap |
| `INGEST_MAX_POSTS_PER_HOUR` | 100 | Integer 1-100 shared cap for the single implemented source |
| `INGEST_TERMS_PER_RUN` | 5 | Integer 1-58, also bounded by post budget |
| `INGEST_POSTS_PER_TERM` | 5 | Integer 1-25; sum of requested limits never exceeds run cap |
| `LLM_BATCH_SIZE` | 5 | Integer 1-5; old values such as 25 clamp to 5 |
| `ANALYSIS_INTERVAL_MINUTES` | 10 | Integer 10-1440, shared by manual and scheduled requests |
| `ANALYSIS_MIN_TEXT_LENGTH` | 8 | Integer 1-100, counts Unicode code points after removing URLs |
| `app_settings.retention_enabled` | `false` | Must be exactly `true` for cleanup to delete anything |
| Cleanup `p_batch_size` | 1000 | 1-10000; raw parents, each child phase, cache and each log table bounded separately |

Malformed or below-minimum numeric settings fall back to defaults; above-maximum
values clamp. SQL schedules are explicit migration constants: Edge environment
variables cannot configure pg_cron. Change both together when deliberately
reducing frequency further. Credential variables and the processing kill switch
are unchanged. Retention stays fixed at 30 days, not an environment-controlled
way to accidentally shorten it. Ingestion's minimum text length stays at eight;
analysis can apply a stricter threshold. No English keyword relevance heuristic
was added: it would wrongly discard multilingual, sarcastic and terse opinions.

### Additional Tables

| Table | Retention timestamp | Action / index |
| --- | --- | --- |
| `analysis_content_cache` | `created_at` | 30 days; `analysis_content_cache_created_at_idx`; expired results are not reused |
| `retention_cleanup_log` | `started_at` | 30 days; `retention_cleanup_log_started_at_idx`; logs counts for every cleaned table, including itself |
| `pipeline_run_state` | `started_at` | Protected operational state; at most two fixed keys; no retention deletion |

New raw rows omit six unused legacy scoring fields. V2 fields used by dashboard,
review and provenance remain intact. No raw provider responses or credentials
are persisted. The cache stores only validated reporting fields and provenance;
this intentionally duplicates result data to save AI calls. No extra author,
engagement, media, provider usage or full external payload is collected.

### Correctness And Operations

- `claim_post_analysis` locks the raw row, verifies the current database prompt
  version and recentness, checks global prior-claim eligibility, and claims the
  unique content key before a provider call. Exact prompt hashing prevents
  accidental reuse across languages, model identities or changed prompt text.
  Distinct URLs/case/text remain distinct; there is no unsafe fuzzy normalization.
- A completed cache hit is copied in one RPC, without a Foundry call or a separate
  client-side lookup/update. An in-flight hash defers. Failed hashes suppress
  repeat attempts. Terminal per-post updates and cache persistence are one
  transaction. Persistence failures leave a durable claim, not a retryable gap.
- At-most-once means no automatic replay of a claimed post/version during its
  retained lifetime. A timeout cannot reveal whether the provider charged, so
  completeness is sacrificed rather than attempting an impossible exactly-once
  guarantee across PostgreSQL and an external provider. Admin deletes or direct
  bypasses are outside the worker contract.
- Foundry's existing endpoint accepts one structured post per call; no supported
  multi-input batch API is configured. Requests remain sequential. SQL combines
  claim/cache checks, ingestion uses one bulk insert, and selection is bounded.
  Per-post completions remain immediate so a later failed call cannot discard
  earlier paid results. This is intentional, not an unimplemented batch feature.
- Cleanup captures one cutoff per transaction, locks bounded expired parents,
  deletes V2 then legacy children before parents, and handles legacy orphans
  separately. Each child phase is bounded too; a parent with many versions can
  take multiple runs. Exactly-at-cutoff rows stay. Recent parents keep all their
  analyses, even when analysis creation timestamps are old.
- Ordinary indexes are idempotent but may briefly block writes when built on a
  large table. Review sizes in staging; use operator-approved concurrent index
  creation outside a migration transaction if required. Deletes create dead
  tuples/WAL; autovacuum enables page reuse, not immediate file shrinkage. Do not
  automatically run `VACUUM FULL`, compact storage, or delete extension logs.
- Cleanup deliberately excludes aggregate/configuration/reference/auth/billing
  and user-managed data. Cache refresh retains its existing three-generation
  replacement behavior; retention never deletes cache generations. Reporting
  computes the last 30 days even before cleanup. Existing cached generations
  remain visible until the first approved/scheduled refresh, and later snapshots
  are up to one hour old; hourly browser polling can add another hour of latency.
- Physical expiry is eventual: default cleanup removes at most 1,000 parents/hour,
  with independent log/cache budgets. Expect up to one hour of expiry lag once
  caught up, longer during initial backlog drain. The preview reports all eligible
  rows; one run removes only a bounded subset. No global/ad-hoc foreign-key cascade
  is introduced. Unknown hosted dependencies fail transactionally, not silently.

### Deployment And Rollback

1. With explicit approval, pause ingestion/analysis jobs. Inspect hosted schema,
   RLS, triggers, actual job schedules, row counts, index sizes, extension availability,
   and backups. Only application objects evidenced in this repository are covered.
2. Apply the five new 20261005 migrations in order in staging first. They add
   controls, indexes, disabled cleanup, schedules, and rolling reporting. The
   schedule migration requires existing pg_cron; this repository already depends
   on it. Missing named pipeline jobs produce warnings rather than inventing
   credentials/commands. Provision a missing ingestion job from the reviewed
   README template, not by assuming it already exists.
3. Do not replay old baseline migrations against production. They explicitly warn
   against that; the earliest migrations reference tables before their later
   reconstructed definitions. The existing history is not a clean `db reset`
   chain. Local tests load the relevant baseline in dependency order, then apply
   each new non-cron migration twice. Staging must verify actual migration history.
4. Deploy both Edge Functions and browser changes; configure the variables above
   and validate the database-resolved prompt version. Old workers can bypass the
   new hash cache, so do not run old/new deployments together. No AI backfill is
   required. Review `LLM_PROCESSING_ENABLED` before resuming.
5. With approval, run `select public.refresh_dashboard_v2_cache();`, verify recent
   totals/trends and low-sample behavior, then resume the approved pipeline jobs.
   Inspect hourly sample counts, cache hits, failures and short-content exclusions
   before claiming statistical reliability. A full rotation takes about 12 hours;
   larger rolling/day-level aggregates are more stable than small topic buckets.
6. Run the read-only [operator script](supabase/scripts/retention-operations.sql).
   Its `preview_sentiment_retention()` query lists exact deletion counts per
   disposable table. Obtain approval for those counts and then run only the
   commented enable block. It enables both the setting and cron flag atomically.
   Repeat bounded manual catch-up calls only with approval; inspect logs/preview.
7. To disable: `select public.disable_sentiment_retention();`. This sets the gate
   false and disables its cron job atomically. It does not cancel a transaction
   already running. Never drop tables or remove RLS to roll back.
8. If reverting behavior, pause workers first, disable cleanup, redeploy the
   previous functions/browser, and restore previous scheduler definitions using
   the commented operator SQL. Restore prior reporting definitions from
   `20260914091500_dashboard_v2_cache_refresh_functions.sql` and the 240-second
   timeout migration only after reviewing the intended historical behavior.
   Keep the new terminal stale-claim handling unless repeat AI spend is explicitly
   accepted. Additive tables/indexes can remain dormant. Committed deletions are
   irreversible without an approved backup restore.

### Validation Results

- 70/70 existing and new Edge Function tests pass using the Node compatibility
  runner. It maps the existing Deno test/assert API to Node and uses the real
  Supabase JS client; network behavior is mocked, with no paid calls.
- Browser logic tests pass for the moving chart start, active-view-only reads,
  freshness gating and hidden-tab suppression. No visual layout changes were made.
- Strict TypeScript passes for all 12 TypeScript files, using local declarations
  for the Deno APIs and actual Supabase client types. ESLint correctness rules
  pass for 16 source/test/script files. There was no existing lint configuration.
- Embedded PostgreSQL (PGlite) passes repeat migration application, raw URI and
  post/version uniqueness, sequential competing claims, cache result reuse,
  in-flight exclusion, terminal abandoned attempts, grants, cutoff/boundary/null
  dates, disabled cleanup, preview counts, bounded child-first deletion, log
  trimming, protected/recent records and rolling reporting/cache refresh tests.
- Native `deno test`, `deno check` and `deno lint` could not run because Device
  Guard blocks Deno. pg_cron/pg_net are unavailable in PGlite; the schedule
  migration's fail-closed capability check is tested, but successful scheduling,
  disable RPC dispatch, real multi-session contention and hosted performance
  must be checked in staging. No production row preservation has been verified.

Reproduce permitted checks in PowerShell (dependencies stay outside the repo):

```powershell
npm install --prefix "$env:TEMP/sentimentmap-validation" --no-audit --no-fund @electric-sql/pglite @supabase/supabase-js@2.117.2 typescript@5.9.3 eslint@9.39.5 typescript-eslint@8.71.0
node supabase/scripts/test-edge-node.mjs
node supabase/scripts/test-cost-controls.mjs
node supabase/scripts/check-types.mjs
git diff --check
```

Set `TEST_DEPS_PATH` to use another dependency directory. TypeScript 7's package
does not expose the compiler API this check uses; keep the explicit 5.9.3 pin.
The Node adapter is not a substitute for testing Supabase Edge Runtime in staging.

## Cost Estimates

These are source-derived ceilings and illustrative formulas, not observed bills.
The old ingestion cadence is documented, not proven deployed. Actual settings,
deduplication rates, post sizes, tokens and cache-hit rates are unknown.

| Driver | Old source-derived bound | New default bound | Estimated change |
| --- | --- | --- | --- |
| Bluesky HTTP requests | `4 * (1 + 58) = 236/hour` | `1 + 5 = 6/hour` | 97.5% fewer |
| Fetched candidates | `4 * 58 * 5 = 1160/hour` | 25/hour | 97.8% lower ceiling |
| Foundry calls at batch ceiling | `30 * 25 = 750/hour` | `6 * 5 = 30/hour` during backlog | 96% lower ceiling |
| Foundry calls with old unset default | `30 * 10 = 300/hour` | <=30/hour during backlog | 90% lower ceiling |
| Foundry steady state | Actual unique eligible input rate, unknown | <=25/hour before cache/filters | Versus old 750 ceiling: 96.7%; do not confuse with measured savings |
| Analysis invocation logs | 720 inserts + 720 updates/day | 144 inserts + 144 updates/day | 80% fewer scheduled log writes |
| Cache refreshes/logs | 288/day | 24/day | 91.7% fewer full aggregate refreshes |
| Idle visible browser background reads | 24/hour/tab | 1/hour/tab | 95.8% fewer, excluding user actions/retries |
| Ingestion client DB requests | 4 bulk inserts/hour | <=1 admission + 1 bulk insert/hour | Up to 50% fewer requests, with stronger enforcement |

Let `R_old` and `R_new` be actual unique inserted posts/hour, `D` retained days
before this change, and `H` the duplicate-content cache-hit fraction among
eligible posts. At the new default `R_new <= 25`:

- Raw rows: old approximately `24 * R_old * D`; new approximately
  `24 * R_new * 30 <= 18,000`, plus cleanup lag and the initial backlog.
  Raw-row reduction is `1 - (R_new * 30)/(R_old * D)` when comparing steady states.
  Retention alone, unchanged intake, gives `1 - 30/D` for `D > 30`.
- New V2 rows are approximately at most raw rows; new content-cache rows are
  at most unique attempted inputs over 30 days (normally <=18,000 at default
  intake). The transitional existing backlog can temporarily increase this.
  New ingestion does not create legacy analyses; their count tends to zero.
- Approximate live bytes: `N_raw*B_raw + N_v2*B_v2 + N_cache*B_cache + logs + indexes`.
  `B_*` must be measured with `pg_total_relation_size`/row counts. Raw fields are
  smaller, but the new content cache adds a second validated result copy for each
  unique input. Therefore row reductions must not be presented as an identical
  percentage reduction in bytes or Supabase billed disk.
- AI calls after backlog drain: approximately `24*R_new*(1-F)*(1-H)` per day,
  where `F` is the fraction filtered before a provider call. Absolute maximum
  is 720/day from admission/batch size; normal default intake supports <=600/day.
  The price estimate requires observed input/output token counts and model rates.
- Analysis client DB requests: old approximately `4*J_old + 2*P_old` per hour;
  new `5*J_new + 2*U + C + F_count + S`, where `J` is admitted batches, `U` is
  uncached attempts, `C` cache hits, `F_count` filtered claims and `S` deferred
  claims. Each batch can scan at most ten candidates. Under a full uncached
  ceiling example: old `4*30+2*750=1620`; new `5*6+2*30=90`, 94.4% fewer requests.
  This is not a count of internal SQL reads, index probes, or WAL writes.
- New cache misses need about five row mutations (claim/result, raw marker,
  cache claim/result), versus three formerly. At 25/hour versus the old 750/hour
  ceiling that is 125 versus 2,250 mutations/hour, about 94.4% fewer, before raw
  ingestion/logs/cleanup. Cache hits need fewer mutations and no provider call.
- Aggregate read work is roughly proportional to `refreshes * eligible rows`
  plus JSON expansion/index overhead. Estimate a ratio of
  `(1/12) * (N_recent_new/N_historical_old)` for refresh scans, not a guaranteed
  latency or monetary improvement. The separate full-history metadata scan is
  removed; source counts are derived from the computed rolling payload.

As an **assumed example only**, 60 days at 500 unique posts/hour would hold
720,000 raw rows. Thirty days at 25/hour holds 18,000, a 97.5% raw-row reduction.
This does not estimate actual existing storage. Reduced rates can also increase
sampling variance and delay topic changes, so evaluate daily sample counts and
organic coverage before raising or lowering the limits.

## Exact Changed Files

Runtime:
- [app.js](app.js)
- [supabase/functions/_shared/costControls.ts](supabase/functions/_shared/costControls.ts)
- [supabase/functions/ingest-bluesky-search/index.ts](supabase/functions/ingest-bluesky-search/index.ts)
- [supabase/functions/analyse-posts/index.ts](supabase/functions/analyse-posts/index.ts)

SQL migrations and operator procedure:
- [supabase/migrations/20261005090000_pipeline_cost_controls.sql](supabase/migrations/20261005090000_pipeline_cost_controls.sql)
- [supabase/migrations/20261005091000_retention_indexes.sql](supabase/migrations/20261005091000_retention_indexes.sql)
- [supabase/migrations/20261005092000_retention_cleanup.sql](supabase/migrations/20261005092000_retention_cleanup.sql)
- [supabase/migrations/20261005093000_cost_control_schedules.sql](supabase/migrations/20261005093000_cost_control_schedules.sql)
- [supabase/migrations/20261005094000_recent_sentiment_reporting.sql](supabase/migrations/20261005094000_recent_sentiment_reporting.sql)
- [supabase/scripts/retention-operations.sql](supabase/scripts/retention-operations.sql)

Tests and validation:
- [supabase/functions/analyse-posts/batchLoop.test.ts](supabase/functions/analyse-posts/batchLoop.test.ts)
- [supabase/functions/analyse-posts/batchSize.test.ts](supabase/functions/analyse-posts/batchSize.test.ts)
- [supabase/functions/analyse-posts/candidateScan.test.ts](supabase/functions/analyse-posts/candidateScan.test.ts)
- [supabase/functions/ingest-bluesky-search/index.test.ts](supabase/functions/ingest-bluesky-search/index.test.ts)
- [supabase/scripts/test-edge-node.mjs](supabase/scripts/test-edge-node.mjs)
- [supabase/scripts/test-cost-controls.mjs](supabase/scripts/test-cost-controls.mjs)
- [supabase/scripts/check-types.mjs](supabase/scripts/check-types.mjs)

Documentation:
- [README.md](README.md)
- [COST_OPTIMIZATION.md](COST_OPTIMIZATION.md)

## Three Largest Expected Savings

1. Reduce intake from 58 searches every documented 15 minutes to five hourly
   searches, capped at 25 posts. This cuts external requests and downstream work.
2. Bound AI work to five posts per ten minutes, reuse exact content analyses, and
   retain terminal claims instead of repeating ambiguous paid attempts.
3. Keep only 30 days of disposable data, compute only recent aggregates, and
   refresh hourly rather than repeatedly rescanning an ever-growing archive.