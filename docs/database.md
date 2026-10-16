# Database

**Source-defined, reviewed 2026-10-16**, except explicitly dated observations.
This is an effective-definition map, not an execution order or a deployed-schema
certification. See [status](../CURRENT_PROJECT_STATUS.md) for observed state and
[operations](operations.md) for approval boundaries.

## Migration history is not a bootstrap script

The live `supabase_migrations.schema_migrations` ledger was absent in operator
catalog results on **2026-10-05**. Functionality SQL was manually applied; some
index builds timed out. Later valid/ready-index observations do not prove every
intended index exists. Full installed definitions and ACL parity remain unverified.

There are 40 historical migrations. Early files reference raw tables before
their later reconstructed baselines. The raw/legacy baselines are **local test
fixtures only**, and test runners load a selected dependency order.
Do not replay, squash, reorder, rewrite or move historical migrations.
`IF NOT EXISTS` and `CREATE OR REPLACE` do not make replay harmless.

Historical files include operational effects: prompt updates, backfills, cache
seeding, immediate recovery, cron creation, grant changes and retention resets.
Blind replay can enable work, revoke/restore the wrong permissions or disable
approved retention. Reconciliation requires inspection and separate approval,
not fabricated migration history.

## Application tables

| Table | Role and lifecycle |
| --- | --- |
| `bluesky_posts` | Raw public text, author, language, source URL, publication/fetch timestamps; URI primary key. Required `published_at` and `source_url`; `fetched_at DEFAULT now()`. No raw `created_at`. Legacy scoring columns remain, but new ingestion omits them. |
| `post_analyses_v2` | Internal analysis status, validated result/provenance, prompt version, cache reference and worker ownership. Unique `(post_uri,prompt_version)`; FK to raw URI. Canonical sentiment score -1..1. |
| `post_analyses` | Retained legacy schema; no active repository producer. Recorded empty October 16. Legacy RPCs are not a supported fallback. |
| `analysis_content_cache` | Exact-request reusable validated results, status, creation age and owner-analysis reference; not full raw provider responses. |
| `pipeline_run_state` | Protected admission/owner/fence/lease state for analysis and ingestion. Never truncate/reset fences to force admission. |
| `app_settings` | Protected active-prompt and retention-gate settings. Prompt lookup is database-authoritative. |
| `dashboard_v2_cache` | Aggregate generations; refresh keeps three, independently of raw-data cleanup. |
| `analyse_posts_invocation_log` | Protected best-effort batch telemetry; not manual-request or provider-billing coverage. |
| `dashboard_v2_cache_refresh_log` | Protected refresh outcomes/durations. |
| `retention_cleanup_log` | Protected transactional deletion-count audit. |

The publication/fetch schema above was observed in operator catalog results
October 5 and is reflected in corrected source fixtures. Runtime table names
and fields must still be reconciled before a new deployment.

Views include completed legacy/V2 analyses, internal recent reporting, developer
validation and invocation statistics. They are not additional stored tables.
Supabase-managed schemas, Vault, cron history and pg_net queues/responses are
outside application retention.

## Effective definition map

Read the current body **and** later alterations/grants. Earlier bodies explain
history, not current behavior.

| Contract | Current defining source / relevant follow-up |
| --- | --- |
| Raw and legacy fixture schema | [Raw baseline](../supabase/migrations/20260902150000_legacy_baseline_bluesky_posts.sql), [legacy baseline](../supabase/migrations/20260902200000_legacy_baseline_post_analyses.sql); never hosted repair scripts |
| V2 base schema | [V2 migration](../supabase/migrations/20260902210000_post_analyses_v2.sql), then [content classification](../supabase/migrations/20260910120000_post_analyses_content_type.sql), cache and ownership additions below |
| Prompt setting / `get_active_prompt_version` | [Prompt contract](../supabase/migrations/20260904090000_active_prompt_version_contract.sql); content migration sets source prompt `v4`, not proof of live value |
| Cache/run-state base | [Initial cost controls](../supabase/migrations/20261005090000_pipeline_cost_controls.sql); later fenced implementation supersedes old admission/claim behavior |
| Lease acquire/renew/release, validation, fenced ingestion/claim/finish, selector and recovery | [Fenced pipeline](../supabase/migrations/20261005100000_fenced_pipeline.sql), including ownership FKs, transitions and grant cutover |
| Retention log, preview and cleanup | [Initial retention](../supabase/migrations/20261005092000_retention_cleanup.sql), superseded preview/cleanup in [safe retention](../supabase/migrations/20261005101000_safe_retention.sql) |
| Retention disable and schedules | [Schedule controls](../supabase/migrations/20261005093000_cost_control_schedules.sql); final [caller timeout command](../supabase/migrations/20261005102000_retention_caller_timeout.sql) |
| Dashboard storage | [Cache tables/log](../supabase/migrations/20260914090000_dashboard_v2_cache_tables.sql) |
| Aggregate/top-topic compute and refresh | [Recent reporting](../supabase/migrations/20261005094000_recent_sentiment_reporting.sql); UTC alterations in [UTC reporting](../supabase/migrations/20261005103000_utc_reporting.sql) |
| Recent reporting / public V2 review views / public dashboard and trend RPCs | [UTC reporting](../supabase/migrations/20261005103000_utc_reporting.sql) |
| Internal cache-status RPC and original compute grants | [Cache functions](../supabase/migrations/20260914091500_dashboard_v2_cache_refresh_functions.sql); refresh body/timeout later replaced by recent reporting |
| Invocation telemetry/stats | [Invocation log](../supabase/migrations/20260914210000_analyse_posts_invocation_log.sql) |
| Retained analysis marker trigger | [Analysis tracking](../supabase/migrations/20260914100000_bluesky_posts_analysis_tracking.sql); latest selector no longer treats the marker as authority |

The [historical migration inventory](history-2026-10-16-operations.md#migration-inventory-reviewed)
lists all 40 files, also explicitly not an execution sequence.

## Ownership and permissions

The fenced protocol uses random owner tokens, monotonically increasing fences,
database-clock 180-second leases and minimum admission intervals of 3,600 seconds
for ingestion / 600 for analysis. The Edge helper also has a 120-second local
deadline and 10-second database HTTP bound.

Short database transitions share advisory transaction lock `78123901`; HTTP calls
do not hold a database transaction lock. Renewal cannot resurrect an expired lease.
Stale owners cannot finish results or release another owner's lease.

Claim checks lease, authoritative prompt, publication eligibility and terminal/
live-owned prior analyses. It locks raw/cache state and either claims, defers,
filters or copies a valid completed cached result. Completion checks analysis and
cache ownership, updates both transactionally and requires exactly one persisted
result. Bidirectional references and an owner-removal trigger make inactive
orphaned content-cache state reclaimable.

Final source revokes direct worker mutations on pipeline tables and service-role
execution of old unfenced admission/claim functions. New mutations use
service-role-only SECURITY DEFINER RPCs with fixed search paths. Service-role
RLS bypass is not a substitute for SQL grants.

Public browser roles read narrow reporting APIs/views and raw data under existing
raw read policy; they do not read/write the V2 base table or invoke operational
write RPCs. Compute/refresh/status are privileged, not public dashboard endpoints.
Do not restore old grants to make an old worker work.

## Retention and recovery contracts

- Disposable data expires strictly before `now() - interval '720 hours'`;
  exactly-at-cutoff records survive. Raw publication governs matching analyses.
  Legacy orphans and content-cache entries use their own creation time.
- Live analysis/cache ownership can defer physical expiry. Cleanup selects
  bounded parents, deletes V2/legacy children first, then parents, and separately
  handles old legacy orphans and inactive content-cache entries.
- Default batch is 1,000 parents; accepted range 1..10,000. Child/cache phases
  have their own bounds, so this is not a total transaction-row cap.
- The enable setting must be exactly true. New-deployment migrations install
  retention inactive/reset the gate false; observed production activation is
  a separate operator decision.
- Caller statements set `statement_timeout='60s'`, `lock_timeout='2s'` and
  timezone UTC. Cleanup rejects absent/unbounded/oversized timeouts and
  unexpected incoming FKs/delete triggers. A client timeout alone does not
  establish database cancellation.
- Cleanup and its audit entry are transactional. Invocation, refresh and
  retention audit logs are not deleted. Settings, leases, aggregate generations,
  managed schemas and extension history are excluded.
- Latest recovery changes at most 1,000 old inactive-owner processing rows to
  pending, with a minimum age threshold of ten minutes. It does not delete claims
  or reset raw flags. **Recovery remains disabled by operating decision.**

Legacy `NOT VALID` FK installation enforces new writes without proving historical
rows were validated. Retained old RPCs, detached trigger functions, marker state
and overlapping indexes are compatibility/history artifacts, not incidental
deletion candidates.

## Reporting semantics and duplication

Both recent views join completed analyses to raw posts using the 720-hour,
nonfuture publication window. Internal reporting is organic/null-content only;
public review includes all classifications. All prompt versions contribute.

Aggregate, top-topic and uncached-topic paths share UTC buckets and sparse-score
rules but are not identical: aggregate topic counts expand entries, top-topic
computation deduplicates post/score/time/topic tuples, and fallback trends count
matching reporting rows. Do not consolidate SQL by assuming identical counts.

Latest main reads require a fresh generation and never recompute on a cache miss.
Topic reads apply the same freshness gate before any live fallback. Main payload
metadata is cached; topic responses resolve active-prompt metadata at request time.
Display-score conversion exists in SQL as well as the review browser.

Refresh uses its own advisory transaction lock, writes payload/topic cache and
audit state, and retains three generations. It is separate from the content-result
cache and does not perform new AI analysis. See [architecture](architecture.md#reporting-and-browser-behavior).
