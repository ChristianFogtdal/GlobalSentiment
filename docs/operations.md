# Operations

**Current guidance reviewed 2026-10-16.** This guide describes source contracts
and safe procedures, not authorization to execute writes. Current dated production
state belongs in [CURRENT_PROJECT_STATUS.md](../CURRENT_PROJECT_STATUS.md).
AI analysis and recovery must remain disabled unless separately approved.

## Documentation authority

| Evidence label | Meaning |
| --- | --- |
| Source-defined | Implemented in reviewed source; not proof of deployment |
| Observed (date/time) | Dated catalog/API result; identify operator-supplied SQL versus direct public reads |
| Reported (date) | Operator-reported action without complete independently retained artifacts |
| Historical | Preserved prior state, recommendation or test result; not current instructions |
| Unknown/unverified | Evidence missing; do not infer from defaults, filenames or a successful related check |

For implementation, current source and latest effective SQL definitions outrank
prose. For production, dated observations outrank source defaults. Product intent
does not prove implementation, and evidence does not grant permission to act.
If source, docs and observations disagree, report the conflict before changes.

Document ownership:

- README: orientation and documentation index; no repeated deployment snapshots.
- Current status: latest dated observations, active decisions and approved next work.
- Architecture: component/API/UI contracts; update with component changes.
- Database: effective objects, ownership and retention/reporting contracts; update
  with approved SQL changes, without rewriting historical migrations.
- Operations: configuration authorities, checks and approval boundaries.
- Development: local tooling, tests and release-surface limitations.
- PRD: product intent; histories: retained evidence, not operational authority.

The person/agent changing a contract updates its owning guide. Record observation
timestamps and source revision when known; no named team ownership is established.

## Configuration authority

Configuration deliberately spans browser, Edge, PostgreSQL and hosting. Inventory
these authorities; do not attempt to centralize runtime configuration through docs.
Never document secret values or paste credential-bearing cron commands.

| Authority | Configuration | Evidence boundary |
| --- | --- | --- |
| [Browser source](../app.js) | Supabase origin/publishable key, polling, review page/debounce/retry and display constants | Public configuration; source values do not prove what Pages serves |
| [Supabase config](../supabase/config.toml) | Project reference and both `verify_jwt=false` flags | Hosted gateway flags unverified; manual deployment can differ |
| Hosted Edge secrets | Supabase URL/service role, ingestion secret, Bluesky credentials, Azure settings, kill switch and numeric overrides | Full hosted overrides not read back |
| Supabase Vault | `bluesky_ingestion_secret`, matching Edge `INGESTION_SECRET` | Privately compare; do not export decrypted values |
| Database settings | `active_prompt_version`, `retention_enabled` | Prompt RPC is authoritative; dated live values belong in status |
| pg_cron jobs | Schedule, active flag, command, target, role and caller timeouts | Environment variables do not reschedule cron |
| SQL source | Retention/reporting window, lease protocol, permissions, freshness/cache rules | Installed definitions require catalog reconciliation |
| Hosting/provider | Pages release, Edge file layout, Azure deployment/model compatibility and quotas | Separate release/configuration surfaces, not inferred from Git HEAD |

Both workers require `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
`INGESTION_SECRET`. Ingestion additionally needs `BLUESKY_HANDLE` and
`BLUESKY_APP_PASSWORD`. Analysis needs `AZURE_FOUNDRY_ENDPOINT`,
`AZURE_FOUNDRY_API_KEY`, `AZURE_FOUNDRY_DEPLOYMENT`, `AZURE_FOUNDRY_MODEL` and
the exact enable gate. `LLM_PROMPT_VERSION`, if nonempty, is only a transitional
match check against the database value, not a second authority.

The Foundry path appends `/openai/v1/chat/completions`; request `model` is the
deployment name. Configured model identity is provenance/cache identity.
No separate API-version parameter or alternative provider fallback is configured.
Model changes in place require deliberate versioning; do not force blanket
reanalysis by changing the prompt setting.

If the hosted gateway requires JWT verification, valid gateway credentials are
additional to the ingestion secret; a publishable key is not a legacy JWT.
An authenticated disabled-path success does not verify stored cron headers.

### Source numeric defaults

These are not verified hosted overrides. Malformed/below-minimum numeric values
fall back to defaults; above-maximum values clamp.

| Edge setting | Default | Bounds / meaning |
| --- | ---: | --- |
| `INGEST_INTERVAL_MINUTES` | 60 | 60..1440; admission, not cron wake-ups |
| `INGEST_POSTS_PER_SOURCE` | 25 | 1..100, capped by hourly-cap setting |
| `INGEST_MAX_POSTS_PER_HOUR` | 100 | 1..100; single implemented source |
| `INGEST_TERMS_PER_RUN` | 5 | 1..58, also limited by run budget |
| `INGEST_POSTS_PER_TERM` | 5 | 1..25, sharing run budget |
| `LLM_BATCH_SIZE` | 5 | 1..5 |
| `ANALYSIS_INTERVAL_MINUTES` | 10 | 10..1440; manual and scheduled share admission |
| `ANALYSIS_MIN_TEXT_LENGTH` | 8 | 1..100 Unicode code points after URL removal; requires a letter |

Ingestion text minimum stays eight. Defaults yield at most 25 candidate posts
per admitted collection run and 30 provider calls per UTC hour when analysis is
enabled under normal admission. These are source-derived ceilings, not measured
cost savings or sliding-hour monetary quotas. Lease expiry/fencing does not
prevent a charge for a request already sent.

## Jobs and execution boundaries

[Schedule source](../supabase/migrations/20261005093000_cost_control_schedules.sql)
defines ingestion at minute 00, analysis at 05/15/25/35/45/55, retention at 48,
recovery at 52 and cache refresh at 58. These are source cadences, not activation
instructions. See the single [dated active-state table](../CURRENT_PROJECT_STATUS.md#operating-decision-and-recorded-schedules).
Verify `cron.timezone` before reproducing schedules elsewhere.

Ingestion and analysis dispatch through pg_net to Edge Functions. SQL dispatch
success is not the asynchronous HTTP outcome. Retention/recovery/refresh are
database calls. Analysis does not trigger dashboard refresh.

Retention requires both its job and database gate. Its final
[caller command](../supabase/migrations/20261005102000_retention_caller_timeout.sql)
sets statement timeout 60 seconds, lock timeout two seconds and UTC before
cleanup. Do not remove these guards. Disabling a job/gate does not cancel work
already running or undo committed deletion.

## Read-only health checks

Use the intended project and bounded read-only queries. Even read-only scans
consume resources; use ordinary query timeouts and avoid credential-bearing output.
Do not invoke refresh, recovery, cleanup, claims or leases as diagnostics.

1. Check job names/schedules/active flags and recent cron results. Keep analysis
   and recovery inactive; do not recreate jobs merely because a snapshot is old.
2. Correlate ingestion dispatch with bounded Edge/pg_net HTTP evidence and recent
   raw `fetched_at` batches. Check partial search failures and deduplication before
   interpreting zero new rows as an outage.
3. Read retention setting, preview and audit counts across consecutive cycles.
   Eligible rows between hourly runs are normal; all protected audit deletion
   counters must remain zero. Preview is not approval to delete.
4. Read refresh success/duration and generation age. Read latest completed
   processing time separately; a fresh dashboard can contain only old analyses.
5. Check public dashboard/review/raw responses with bounded reads. HTTP 200 alone
   does not establish correct payload, provider execution or complete UI health.
6. Measure cluster bytes on the same basis as quota, separately from physical
   disk/WAL. PostgreSQL pretty-size binary labels differ from decimal quota MB.
   Row deletion/autovacuum makes space reusable, not necessarily smaller files.
7. Inspect actual indexes, constraints, grants and effective function bodies
   before proposing deployment/SQL work; never create a ledger from filenames.

### Existing script classification

| Script | Effects and limits |
| --- | --- |
| [Storage preflight](../supabase/scripts/storage-reclamation-preflight.sql) | Read-only catalog/storage inspection with timeouts; does not reclaim storage |
| [Live storage measurement](../supabase/scripts/measure-live-storage.sql) | Read-only scans with a 20-second bound; row bytes are not guaranteed compaction savings |
| [Legacy schema inspection](../supabase/scripts/inspect_legacy_analysis_schema.sql) | Read-only legacy metadata, not a comprehensive current inventory; review output and apply normal timeout controls |
| [Retention operations](../supabase/scripts/retention-operations.sql) | Executable inspection is read-only; commented examples enable deletion/change schedules/pause jobs and require exact approval |
| [Validation runners](development.md#validation) | Local mocks/PGlite or explicitly disposable native fixtures; not production diagnostics |

The two storage scripts were untracked at the start of this documentation work.
Their contents and tracking state were left unchanged. A clean clone may not
contain them until separately reviewed/committed; do not invent substitutes or
run maintenance because a referenced script is missing.

## Approval-gated production work

Every production write, SQL change, secret update, schedule change, deployment,
recovery invocation, manual refresh/cleanup and paid call requires explicit scope
approval. SQL beginning with `SELECT` may mutate state. Previous live-only/
no-new-backup acceptance is historical, not permission for the next operation.

Storage maintenance is complete. Do not repeat full vacuum, purge audits, drop
indexes or shorten retention as routine follow-up.

### Future analysis readiness and re-enablement

**Not approved by this documentation phase. Keep analysis and recovery disabled.**

1. Reconcile deployed workers, gateway/cron authentication, database prompt and
   optional environment match, fenced RPCs/ACLs/ownership, current leases and
   pending work. Do not reset fences/claims or restore direct-write grants.
2. Privately establish Azure readiness, endpoint/deployment compatibility
   (strict JSON schema, minimal reasoning, completion-token setting), quotas
   and an approved spend envelope. Actual provider readiness is unverified.
3. Address native Deno, real concurrency/cancellation and hosted-runtime gates in
   [development](development.md#validation-limitations). A renewed decision to
   accept an unmet gate must be scoped and recorded as risk acceptance, not a pass.
4. Present exact configuration changes and one uncached manual canary for approval.
   Proposed canary batch size is one, not a verified live override. Keep both jobs
   inactive. Validate a recent eligible nonterminal URI and exact request JSON:
   malformed/missing `post_uri` falls back to batch mode.
5. Only after approval, exercise the canary. Require response selected=1,
   completed=1, failed=0; read back exactly one persisted valid result/provenance.
   Provider/Edge evidence must establish an uncached call because completion can
   be a cache hit. Manual requests do not appear in batch invocation logs.
6. Wait for normal refresh or obtain separate manual-refresh approval; verify
   organic inclusion or filtered review, cache freshness and retained audit history.
   One post need not create a visible trend point because of sample suppression.
7. Only after passing/explicitly resolving gates and obtaining activation approval,
   resume the analysis schedule at the approved bounded batch. Verify actual HTTP,
   persisted results and spend across several cycles. Review/approve recovery
   separately; it can reoffer ambiguous attempts and is not required to inspect state.

A valid authenticated disabled-path check is also a hosted POST requiring
approval, even though the expected path makes no paid call. Never induce failure,
race or cancellation scenarios on live data without separately approved scope.

### Pause and incident handling

Under approved incident scope, disable the analysis gate and both analysis/
recovery jobs, verify read-back and inspect in-flight work. The gate is checked
at invocation start; pausing does not cancel a provider request already sent.
Keep fences, failed rows, content cache and audit evidence.

Leave healthy collection/reporting/retention unchanged unless the incident
requires a separately approved pause. Retention disable is a mutating procedure,
not rollback of prior deletes. Do not redeploy unfenced workers or restore their
grants. Committed deletions need a restore source; external charges cannot be
reversed by SQL. Record the incident, evidence and unresolved gates before retrying.

## Historical evidence

Archives retain original meaning, including recommendations later superseded.
Only archive labels and mechanical reference repairs were added. Snapshot dates
do not imply original authorship dates.

| Record | Classification |
| --- | --- |
| [October 16 operations and earlier handover](history-2026-10-16-operations.md) | Full October 16 compactions, restored cycles, measurements/limits and earlier October 6 evidence |
| [October 5 safety repair](history-2026-10-05-production-safety.md) | Rollout risk acceptance, ownership design and historical validation gaps |
| [October 5 cost audit](history-2026-10-05-cost-optimization.md) | Initial audit, estimates and superseded implementation claims |
| [September 10 content-type plan](history-2026-09-10-content-type-plan.md) | Completed plan; later prompt/UI behavior differs |
| [Evolution snapshot captured October 16](history-2026-10-16-evolution-snapshot.md) | Undated historical narrative, not current capabilities |
| [README snapshot captured October 16](history-2026-10-16-readme.md) | Prior mixed operational/product guidance, retained for provenance |
