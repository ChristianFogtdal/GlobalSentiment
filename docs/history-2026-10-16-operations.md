# Historical operations record: October 16, 2026

**Historical evidence, not current operational instructions.** Captured from the
working copy on 2026-10-16, including the pre-existing uncommitted maintenance
record. Original location: `CURRENT_PROJECT_STATUS.md`.
The body preserves October 16 maintenance/verification and earlier October 6
handover material, including superseded recommendations and their original dates.
Only this label and mechanical reference repairs were added during relocation.

Use [current status](../CURRENT_PROJECT_STATUS.md) for the concise dated snapshot
and [operations](operations.md) for current guidance. No historical approval
authorizes a new write, compaction, provider call or AI/recovery enablement.

<!-- Preserved original document begins below. -->
# Global AI Pulse / SentimentMap: Current Project Status

## Current State: October 16 Compactions Completed

**Both individually approved compactions are complete and verified.** Ingestion,
retention and dashboard refresh have been restored to their original hourly
schedules. AI analysis and stuck-analysis recovery remain disabled.

**Latest cluster database size:** **299,948,853 bytes (299.95 decimal MB)** at
**2026-10-16 11:09:12 UTC**. This is approximately **60.0% of the 500 MB quota**,
leaving **200.05 MB headroom**. The SQL measurement is current at that timestamp;
the Supabase quota/physical-disk panels were not refreshed after the second
compaction. The last pre-analysis Infrastructure view showed 0.67 GB used of
2 GB, with approximately 1.33 GB free.

The cluster started this investigation at 465,361,717 bytes and measured
299,703,093 bytes immediately after the second compaction, a reduction of
165,658,624 bytes at that checkpoint. Direct relation reclamation from the two operations
totals **165,478,400 bytes (165.48 MB)**; intervening normal activity and other
allocations account for the difference from the cluster-wide change.

| Operation | Relation total before | Relation total after | Reclaimed |
| --- | ---: | ---: | ---: |
| Raw posts | 134,881,280 bytes | 82,657,280 bytes | **52.224 MB** |
| V2 analyses | 272,596,992 bytes | 159,342,592 bytes | **113.2544 MB** |

### Analyses Compaction: Final Evidence

After verifying the first normal cycle following raw compaction, the user
separately approved analyses-only maintenance. Fresh disk and database preflight
checks passed, and the same three operational jobs were paused. No active
pipeline leases, queued ingestion requests, running jobs, concerning transactions
or raw/analysis table locks were reported at the final preflight.

The operator executed only
`VACUUM (FULL, ANALYZE, VERBOSE, SKIP_LOCKED) public.post_analyses_v2;`
in Supabase SQL Editor and reported success. Before/after SQL read-backs establish
actual compaction rather than a lock-related skip. No agent private database
connection was used. Raw posts were not compacted again.

| Analyses measurement | Before: 10:26:21 UTC | After: 10:28:48 UTC |
| --- | ---: | ---: |
| Heap bytes | 197,705,728 | 115,138,560 |
| Index bytes | 74,809,344 | 44,195,840 |
| Total bytes | 272,596,992 | 159,342,592 |
| Complete rows | 112,386 | 112,386 |
| Failed rows | 15,626 | 15,626 |
| Total rows | 128,012 | 128,012 |

- Analyses heap reclamation was **82.57 MB**; indexes reclaimed **30.61 MB**.
  Combined with raw heap reclamation, the measured heap reduction was
  **124.73 MB**, within the earlier rough 110-130 MB combined-heap estimate.
  Index reclamation across both operations added **40.62 MB**.
- All **nine analysis indexes** were valid and ready after compaction.
- During this second maintenance window, the raw baseline stayed unchanged at
  **134,270 rows** and **82,698,240 bytes**. Its row count differed from the earlier
  raw-maintenance baseline because the intervening normal cycle deleted 185
  expired posts and ingested 17 new ones.
- Cluster allocation decreased from 412,941,109 to 299,703,093 bytes during this
  operation. That decrease is 16,384 bytes less than analysis relation reclamation
  because other database allocation changed; its precise source was not measured.
- Database default read-only remained off; the database was not in recovery.
  WAL remained **134,218,095 bytes**, and archiver failures remained **154**,
  with no failure since October 5. Latest observed archive success: **10:27:15 UTC**.
- Dashboard, Data Review and raw-post APIs returned HTTP 200 at **10:28:07 UTC**.
  The dashboard served its 09:58 generation containing 102,357 organic analyses.
- Row/status counts and index/API health were verified; no full content checksum,
  exhaustive UI test, peak-disk/quota trace or precise vacuum duration was captured.
  No new backup/staging environment or measurement/repacking extension was created.
  No indexes were dropped, and no AI processing was enabled.

### Final Restored Schedules

Operator read-back received at approximately **10:30 UTC**:

| Job | Schedule | Active |
| --- | --- | --- |
| `ingest-bluesky-ai-coding-posts` | `0 * * * *` | true |
| `dashboard-v2-cache-refresh-safety-net` | `58 * * * *` | true |
| `sentiment-retention-cleanup` | `48 * * * *` | true |
| `analyse-posts-ai-sentiment` | `5-59/10 * * * *` | false |
| `reclaim-stuck-processing-analyses` | `52 * * * *` | false |

### Final Scheduled-Cycle Verification: Storage Work Closed

Operator-supplied SQL at **11:09:12 UTC** confirms the first normal cycle after
analyses maintenance. Independent public API checks were made at **11:08:33 UTC**.

| Check | Verified result |
| --- | --- |
| Retention at 10:48 UTC | Cron succeeded; audit recorded 86 raw posts and 86 V2 analyses removed; all protected audit deletion counters zero |
| Dashboard refresh at 10:58 UTC | Cron and refresh audit succeeded; 32,930 ms refresh duration |
| Ingestion at 11:00 UTC | Cron dispatch succeeded; public timestamp-only read independently confirmed 19 posts persisted at 11:00:09 UTC |
| APIs | Dashboard, Data Review and raw-post APIs all HTTP 200; dashboard generation 10:58 UTC with 102,300 organic analyses |
| Database writable | Default read-only off; not in recovery |
| Cluster allocation | 299,948,853 bytes, only 245,760 bytes (0.246 MB) above the immediate post-analysis-compaction snapshot |
| Raw / analysis allocation | Raw 82,706,432 bytes; analyses unchanged at 159,342,592 bytes |
| Index health | No invalid or unready indexes on either main table |
| WAL / archiver | WAL unchanged at 134,218,095 bytes; failure count still 154, latest failure still October 5; successful archive at 11:03:17 UTC |
| Schedules | Ingestion, retention and dashboard refresh active on original hourly schedules; AI analysis and recovery remain disabled |

**Storage work is complete for this maintenance scope.** Both compactions,
preserved row counts, restored schedules and subsequent normal execution cycles
are verified. Small allocation changes during normal operation do not indicate
that reclaimed space has returned. No additional compaction is recommended for
the remaining tables assessed below.

Keep reduced intake, 720-hour retention and routine autovacuum in place. Keep
AI/recovery disabled; Azure readiness and any paid re-enablement remain separate
work requiring their existing safety gates. Continue ordinary storage/health
monitoring rather than scheduling repeated full vacuums.

### Remaining Application Tables: Read-Only Assessment

Operator catalog inventory at **10:39:37 UTC** and exact-count/live-size scans at
**10:42:24 UTC** found **eight remaining application tables**. PostgreSQL/Supabase
managed schemas, extension-owned relations and the two already-compacted tables
were excluded. No additional custom-schema tables, materialized views,
partitions or foreign tables were returned within that scope.

All eight tables together occupy **4,907,008 bytes (4.91 decimal MB)**, approximately
**1.64%** of the latest measured 299.70 MB cluster. Main-table indexes account for
2,039,808 bytes. Exact row counts and live-row representation sizes are below.
All sizes use decimal MB.

| Table | Exact rows | Heap MB | Main indexes MB | Total MB | Live-row MB | Modeled non-main-index reclaim ceiling MB | Ceiling as % of total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `analyse_posts_invocation_log` | 12,071 | 0.860 | 1.466 | 2.367 | 0.758 | 0.074 | 3.1% |
| `dashboard_v2_cache_refresh_log` | 5,932 | 0.705 | 0.410 | 1.155 | 0.655 | 0.041 | 3.5% |
| `dashboard_v2_cache` | 3 | 0.008 | 0.033 | 1.049 | 0.762 | 0.254 | 24.2% |
| `retention_cleanup_log` | 261 | 0.090 | 0.033 | 0.156 | 0.081 | 0.025 | 15.8% |
| `pipeline_run_state` | 1 | 0.008 | 0.016 | 0.066 | 0.000061 | 0.033 | 50.0% |
| `post_analyses` | 0 | 0 | 0.041 | 0.049 | 0 | 0 | 0% |
| `app_settings` | 2 | 0.008 | 0.016 | 0.033 | 0.000117 | 0 | 0% |
| `analysis_content_cache` | 0 | 0 | 0.025 | 0.033 | 0 | 0 | 0% |

**Estimation limits:** these are optimistic storage-layout estimates, not measured
total bloat or guaranteed `VACUUM FULL` savings. Main-index bloat is **unmeasured**
and excluded from the reclaim columns; its required live keys must not be treated
as waste. No page-inspection extension was installed.

For tables without populated TOAST storage, the model rounds each live-row
representation to eight-byte alignment, adds a four-byte row pointer, allows
24-byte headers per 8,192-byte page, and retains the empty TOAST index allocation.
It compares that ideal packed heap with allocated non-main-index storage.
Variable row packing can require more pages, and auxiliary map files can regrow.
The model produces no meaningful heap reduction for the already-empty legacy/
content-cache tables or the minimal settings table.

The dashboard cache has **974,848 bytes of TOAST storage including its index**;
its 8 KB heap does not represent all its data. Its live-row measurement
(762,072 bytes) and sum of stored column-value sizes (761,956 bytes) were
cross-checked. The 253,736-byte difference from non-main-index allocation is only
an optimistic ceiling: it includes required TOAST chunk/index/page overhead.
Generations are replaced hourly, so reclaimed reusable space may soon be needed
again. It would be incorrect to call the entire TOAST allocation bloat.

The modeled non-main-index ceilings sum to **425,768 bytes (0.43 MB)**. Even
adding every byte of the 2.04 MB main indexes as hypothetical removable space
would total only about 2.47 MB; that is not achievable because live indexes must
remain. Precise total/index bloat percentages were not established, but the
inventory establishes that no large application-table storage target remains.

**Recommendation: no further `VACUUM FULL` on any remaining application table.**
Potential benefit is too small relative to blocking, WAL and maintenance risk.
In particular, a nominal 50% ceiling on the 66 KB lease-state table represents
only 32 KB and is not a useful reason to rewrite operational state. Keep routine
autovacuum and the existing retention policy; preserve audit history.
The previously observed approximately 25.21 MB of `cron.job_run_details` is
extension-managed, excluded as requested, and was not purged or compacted.
This assessment changed no schedules or database objects and executed no vacuum.

## Raw-Table Compaction (Earlier October 16)

The sections below preserve the earlier raw-maintenance and investigation
evidence. Their pending/unauthorized-analyses statements describe those earlier
stages and are superseded by the separate approval and completion record above.

**Raw-post compaction completed and verified; original job states restored.**
Only `public.bluesky_posts` was compacted. The analyses table was explicitly
excluded and its total allocation remains **272,596,992 bytes**.

The operator executed
`VACUUM (FULL, ANALYZE, VERBOSE, SKIP_LOCKED) public.bluesky_posts;`
in Supabase SQL Editor and reported success. The subsequent size reduction and
unchanged row count establish that this was not merely a skipped operation.
SQL results were supplied by the operator, not obtained through an agent
database connection.

### Verified Before/After

Final before snapshot: **2026-10-16 09:02:16 UTC**.
After snapshot: **2026-10-16 09:14:58 UTC**. All MB below are decimal.

| Measurement | Before bytes | After bytes | Reclaimed |
| --- | ---: | ---: | ---: |
| Raw-post heap | 108,781,568 | 66,617,344 | 42.16 MB |
| Raw-post indexes | 26,034,176 | 16,031,744 | 10.00 MB |
| Raw-post total | 134,881,280 | 82,657,280 | **52.224 MB** |
| Cluster database total | 465,361,717 | 413,137,717 | **52.224 MB** |
| Raw-post live rows | 134,438 | 134,438 | No row-count change |

Immediately after compaction, the cluster measured **413.14 decimal MB**, approximately **82.6%** of the
500 MB quota, with **86.86 MB** headroom. This is the verified SQL measurement;
the provider quota display was not separately refreshed after compaction.
Raw heap reclamation was about **93% of the earlier 45.27 MB heap/live-row gap**,
plus 10.00 MB from rebuilt indexes. The gap scan preceded the final baseline
and had a slightly different row count, so this is an approximate comparison,
not an exact decomposition of PostgreSQL overhead.

### Safety And Health Evidence

- The user approved raw-only compaction and temporary pauses/restoration of
  ingestion, retention and dashboard refresh. Analysis/recovery stayed disabled.
- Fresh pre-maintenance Infrastructure display reported **0.72 GB used of 2 GB**,
  approximately **1.28 GB free**, with WAL 128 MB and System 168 MB. Physical
  free space was distinct from the then-34.64 MB database quota headroom.
- PostgreSQL 17.6 was writable, with maintenance privilege available. Final
  preflight found no concerning transactions, prepared transactions, replication
  slots, raw-table locks, invalid raw indexes or active pipeline leases.
- Pauses were confirmed at 09:00:07 UTC. The hourly ingestion had already
  dispatched; a subsequent check confirmed its completion, zero queued ingestion
  requests and the final baseline of 134,438 rows before maintenance.
- After compaction all three raw indexes were valid and ready; default read-only
  was off and the database was not in recovery. WAL remained **134,218,095 bytes**.
  Archiver failures stayed at 154, last failure October 5; latest observed
  successful archive was **09:13:20 UTC**.
- Public dashboard and raw-joined Data Review requests both returned HTTP 200
  at **09:12:21 UTC**. Dashboard cache was generated at 08:58 UTC and contained
  102,534 organic analyses. Row count and API checks passed; a full content
  checksum comparison and exhaustive UI testing were not performed.
- Temporary peak disk/quota usage and exact vacuum duration were not captured.
  Successful completion does not establish a platform-wide quota exemption.
- No new backup or staging environment was created during this maintenance.
  No measurement/repacking extension was installed; no indexes were dropped.

### Restored Schedules And Next Decision

Operator-supplied read-back received at approximately **09:16 UTC**:

| Job | Schedule | Active |
| --- | --- | --- |
| `ingest-bluesky-ai-coding-posts` | `0 * * * *` | true |
| `dashboard-v2-cache-refresh-safety-net` | `58 * * * *` | true |
| `sentiment-retention-cleanup` | `48 * * * *` | true |
| `analyse-posts-ai-sentiment` | `5-59/10 * * * *` | false |
| `reclaim-stuck-processing-analyses` | `52 * * * *` | false |

These match the recorded pre-maintenance states and schedules.

### First Restored Scheduled Cycle: Verified

Operator-supplied SQL at **2026-10-16 10:21:15 UTC** confirms the first normal
cycle after restoration. Independent public API reads were performed at
**10:19:49 UTC**. Times below are UTC.

| Check | Result |
| --- | --- |
| Retention at 09:48 | Cron succeeded; removed 185 raw posts and 185 V2 analyses; all protected audit-log deletion counters zero |
| Dashboard refresh at 09:58 | Cron and refresh audit succeeded; refresh duration 38,969 ms |
| Ingestion at 10:00 | Cron dispatch succeeded; public timestamp-only read independently confirmed 17 posts persisted at 10:00:03 UTC |
| API health | Dashboard, Data Review and raw-post endpoints all HTTP 200; dashboard generation 09:58 UTC |
| Database state | Default read-only off; not in recovery |
| Cluster size | 412,941,109 bytes: **412.94 decimal MB**, approximately 82.6% of quota, with **87.06 MB headroom** |
| Raw-post allocation | 82,698,240 bytes, only 40,960 bytes above the immediate post-compaction snapshot |
| Analyses allocation | Unchanged at 272,596,992 bytes; no analyses compaction performed |
| WAL/archiving | WAL unchanged at 134,218,095 bytes; failure count unchanged at 154; latest failure still October 5; successful archive at 10:03:22 UTC |
| Schedules | Ingestion, retention and dashboard refresh active on original schedules; analysis and recovery still inactive |

**Health-gate recommendation: conditional GO for a separately approved,
analyses-only maintenance window.** No regression was detected in the first
restored cycle. Repeat immediate physical-disk/WAL/activity checks and the
pause/verify/restore sequence before execution: the larger analyses table needs
more working space, and the successful raw rewrite does not prove a Free-plan
quota exemption. The Infrastructure physical-disk view was not refreshed during
this cycle check. No analyses maintenance has been authorized or executed.

**Recommendation:** normal collection, retention and cached reporting may
continue. The measured raw-table result supports evaluating a separate
analyses-table compaction, but additional headroom reduces urgency. Do not
compact analyses under the raw-table approval: obtain separate authorization
and fresh disk/WAL/activity checks, allow for its larger 272.60 MB footprint,
and remeasure its reclaimable space before promising savings.

## October 16 Verification Before Compaction

The following records the earlier October 16 investigation. The completed
maintenance and restored-state record above supersedes its pending-compaction
recommendations and pre-compaction size readings.

**Verified October 16, 2026, at 08:01-08:05 UTC:** collection, retention and
dashboard refresh are operating at the reduced hourly cadence. Scheduled AI
analysis and recovery remain disabled. The cost controls are working in the
observed window, but allocated storage remains close to the free-plan quota.

### Database Size And Quota Reconciled

Operator-supplied read-only SQL at **08:03:21 UTC** measured the current
`postgres` database at **450,088,083 bytes**. A cluster-wide read at
**08:05:40 UTC** measured **465,361,717 bytes**, including `template0`
(7,520,783 bytes) and `template1` (7,752,851 bytes).

- Supabase's screenshot shows **465 / 500 MB**, consistent with the cluster's
  **465.36 decimal MB**, approximately **93.1% used** and **34.64 MB remaining**.
- PostgreSQL `pg_size_pretty` displays binary units labelled "MB": **429 MB**
  for `postgres`, **444 MB** for the cluster. These are not contradictory
  measurements or evidence of a stale dashboard.
- On the same current-database basis, allocated size is approximately stable:
  **428 MB on October 6 -> 429 MB on October 16**, versus 585 MB before cleanup.
- Largest relations, including indexes, are V2 analyses **260 MB**, raw posts
  **129 MB**, and cron run history **24 MB** (PostgreSQL display units).
  Routine deletion/vacuum makes space reusable but need not shrink these files.
  Autovacuum was recorded on both main tables on October 14. Dead-row estimates
  do not measure exact reclaimable bytes; no compaction estimate was established.

Supabase [documents the cluster-wide database-size calculation](https://supabase.com/docs/guides/platform/database-size).
No quota breach is shown by this snapshot, but the remaining headroom is small.
No cleanup, compaction, index build, schedule change or paid AI call was performed
as part of this verification.

### Live Operational Evidence

| Check | October 16 result |
| --- | --- |
| Scheduled jobs, preceding 24 hours | 24 successful runs each for ingestion dispatch, retention and dashboard refresh; no failures in supplied results |
| Retention | Enabled; latest 24 runs deleted 6,750 raw posts and 6,750 matching V2 analyses; all protected audit-log deletion counters zero |
| Pending retention | 13 raw posts and 13 matching analyses eligible at 08:03 UTC; all other preview counts zero, consistent with expiry since the 07:48 run |
| Persisted ingestion | Public timestamp-only read returned 368 new posts in the preceding 24 hours, across 22 hourly buckets with 6-25 posts each; latest fetch 08:00:10 UTC |
| Dashboard refresh | Latest 24 audit entries successful; duration 44.27-50.60 seconds, mean 48.11 seconds |
| Public dashboard | HTTP 200; cache generated 07:58 UTC; rolling window starts September 16 at 07:58 UTC; 102,597 completed organic analyses |
| AI processing | Analysis/recovery jobs inactive with no runs in supplied 24-hour results; newest visible completed analysis still October 3 at 10:01:04 UTC |
| Settings/index checks | `retention_enabled=true`, active prompt `v4`; no invalid/unready indexes returned, which does not prove all intended indexes exist |
| Frontend deployment | Latest Pages build succeeded October 6 at 15:43:10 UTC for `6a24ff355dfa9cdc4b97f17b5c72466a6bd9e313`; served `app.js` matches local source after line-ending normalization and uses hourly polling |

Cron ingestion success confirms dispatch, not each asynchronous Edge outcome.
Persisted posts corroborate ongoing collection, but the two hours without new
rows were not diagnosed; duplicates/no new matches and failed requests remain
possible explanations. Complete Edge/source parity and enabled Azure processing
remain unverified. Fewer visible analyses reflect the rolling window and paused
AI, not new AI results. Before/after CPU, query-volume and paid content-cache
savings were not measured.

### Additional Storage-Reclamation Assessment

Operator-supplied catalog results at **08:11:08 UTC** and successful read-only
live-row scans at **08:23:56 UTC** refine the storage assessment. The following
figures use **decimal MB**, matching the Supabase quota display, rather than
PostgreSQL's binary display units.

| Relation | Exact live rows | Allocated main heap | Measured live-row bytes | Difference | Allocated indexes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Raw posts | 134,482 | 108.78 MB | 63.51 MB | 45.27 MB | 26.03 MB |
| V2 analyses | 128,254 | 197.71 MB | 108.90 MB | 88.81 MB | 74.81 MB |
| Cron run history | 31,490 | 24.40 MB | 16.24 MB | 8.17 MB | 0.76 MB |

Live-row bytes are `sum(pg_column_size(table_row))`, not a prediction of
compacted relation size. Differences include normal tuple/page overhead and
unused/dead space; index rebuild savings are not measured. The **134.08 MB**
main-heap difference across raw/V2 supports evaluating compaction, but is not a
guaranteed reclaimable amount. No `pgstattuple`, `pg_freespacemap` or `pg_repack`
extension was found installed, and no measurement extension was installed.

Of the retained raw posts, **130,316 (96.9%)** were published before October 6.
The ten complete days October 6-15 contain **383-429 posts/day**, averaging
**406.7/day**. If this publication-day rate persists, a 30-day raw-data window
would contain approximately **12,201 posts**, not today's 134,482. This is a
row-count scenario, not a byte forecast or a guaranteed intake rate. The old
high-volume publication cohorts will age out around November 4-5 if retention
keeps operating. File allocation need not fall proportionally without
reclamation. With AI still paused, analyzed dashboard data will also age out.

Options ranked by relevance:

1. **Evaluate data-preserving compaction of raw/V2 first**, one table at a time.
   A full vacuum rewrites the table and rebuilds its indexes, requiring working
   disk space and an exclusive table lock. Check actual physical disk free space
   (not just the 34.64 MB database quota headroom), live activity/transactions,
   provider limits and an approved maintenance/backup-risk plan before execution.
   No compaction or schedule pauses are authorized by this assessment.
2. **Index consolidation is secondary, pending performance validation.**
   `post_analyses_v2_post_uri_idx` occupies 20,594,688 bytes and overlaps the
   leading key of required `(post_uri, prompt_version)` uniqueness. It has
   117,053,453 historical scans, so removal is not automatically safe for latency.
   The hypothesized duplicate raw publication-date index is absent in the live
   inventory. Protect uniqueness, primary/FK-supporting access paths and cache
   ownership; zero use of the cache-key index while AI is paused is not proof it
   is unnecessary. Counters span the reported August 25 reset, not only recent
   production behavior.
3. **Keep the 30-day policy unless product requirements change.** Further
   shortening it discards useful history and still does not guarantee immediate
   file shrinkage. Waiting for old cohorts to expire could increase eventual
   reclamation, but does not ensure more quota headroom in the meantime.
4. **Do not purge history as a shortcut.** Cron history occupies 25.21 MB total,
   not all reclaimable without deletion; all protected application audit logs
   remain out of deletion scope. Actual cron rows are 31,490, correcting the stale
   catalog estimate of 4,623. Legacy analysis and content-cache tables are already
   essentially empty and are not material storage targets. The 15,628 failed V2
   analyses contain only 3.00 MB of live row bytes; deleting them is not the main
   opportunity and would remove diagnostic/claim state.

The successful operator-run diagnostics are preserved as
[catalog preflight](../supabase/scripts/storage-reclamation-preflight.sql) and
[live storage measurement](../supabase/scripts/measure-live-storage.sql). They are
read-only and bounded by a 20-second statement timeout. No production maintenance
or data deletion was performed during this assessment.

**Recommendation:** retain the current controls and disabled AI/recovery state.
Monitor cluster bytes and expiry backlog on the same basis. If more immediate
headroom is required, first review a separately approved storage-reclamation
plan; do not purge protected history or repeat locking compaction automatically.

## October 6 Handover (Historical)

The remainder preserves the October 6 handover and its evidence boundaries.
The October 16 verification above supersedes its dated current-state claims,
particularly quota uncertainty, pending frontend deployment and prompt-version
uncertainty. Safety and approval gates below remain applicable.

### October 6 State Snapshot

**Project:** Global AI Pulse / SentimentMap

**Current state at the last recorded checks on October 6, 2026:**

- **Enabled and observed working:** collection, retention and dashboard refresh.
- **Database:** 428 MB, down from 585 MB; **below-quota status is unverified** because no Supabase quota/billing read-back was supplied.
- **Disabled:** AI analysis and stuck-analysis recovery.
- **Unverified:** the enabled Azure provider path.

**Latest known database size:** 428 MB at 2026-10-06 15:12:51 UTC.

**Latest deployed commit:** not established across production components. Latest confirmed source commit on GitHub `main`: `ebbdece381cffe701b77da2dc0bcfeed5347915e`. Its Pages retry was still queued at 15:27:26 UTC and the website served older code; Edge deployments were reported separately and not SHA-verified.

**Most important next step:** restore/verify Azure and, after satisfying the safety and approval gates, successfully execute one verified uncached analysis before re-enabling scheduled analysis. Keep AI analysis and recovery disabled until then.

**Quick navigation:** [Start Here](#start-here-for-future-humans-and-ai-agents) | [Known Good Configuration](#known-good-configuration) | [Database Status](#5-database-status) | [Outstanding Work](#7-outstanding-work) | [Re-Enablement Runbook](#8-re-enablement-runbook) | [Known Risks](#9-known-risks-and-evidence-boundaries) | [Resume Checklist](#resume-checklist)

### Snapshot Scope And Evidence

**Handover date:** 2026-10-06. All observation times below are UTC.
**Source revision:** `ebbdece381cffe701b77da2dc0bcfeed5347915e` on `main`.
**Operating decision:** keep collection, reporting and retention running; keep AI analysis and recovery disabled.
**Scope:** documentation only. Creating this document did not deploy code, execute production SQL, change secrets, or change schedules.

This is the consolidated operational handover, not a promise that its snapshot will remain current. Reverify live state before acting after a break. It includes the production evidence supplied by the operator on October 6 so that chat history is not required.

Evidence labels used throughout:

- **Observed:** direct read-only GitHub/public API checks, or dated SQL results supplied by the operator. The latter were not obtained through an agent database connection.
- **Reported:** an operator-reported deployment or administrative action without independently archived deployment artifacts.
- **Source:** behavior implemented in the reviewed repository; not proof that the exact file/function body is deployed.
- **Unknown:** no sufficient evidence. Defaults, migration filenames and documentation are not live configuration read-backs.

## 1. Executive Summary

### Purpose And Architecture

The project collects public Bluesky posts about AI and, when analysis is enabled, uses an Azure AI Foundry chat-completion deployment to classify AI sentiment, topics, emotions, named tools, product/tool stance, and organic/promotional/spam content. A static website presents aggregate sentiment, topics, emotions, hourly trends and a paginated Data Review view.

Names refer to the same project: local folder **SentimentMap**, GitHub repository **GlobalSentiment**, document/product name **Global Mood Intelligence**, and public heading **The World's AI Pulse**. The sample is term-selected Bluesky discussion, not a representative measurement of worldwide opinion. The current application has no geographic map or country inference, despite older names and product plans.

Flow: Bluesky search -> Supabase Edge ingestion -> `bluesky_posts` -> optional fenced analysis worker -> Azure Foundry -> `post_analyses_v2` and content cache -> hourly PostgreSQL reporting cache -> browser. The browser has no provider credentials and does not trigger collection or analysis.

### Operational State

At **2026-10-06 15:12:51 UTC**, the operator's SQL read-back showed **18 successful runs each** for ingestion, retention and dashboard refresh since October 5 at 21:00 UTC, with no failed runs in that window. Public raw data independently showed 293 inserted posts across 18 consecutive hourly batches, each containing 3-25 posts. Analysis and stuck-processing recovery were inactive with zero scheduled runs in that window.

The dashboard returned HTTP 200 with a cache generated at **14:58 UTC**, containing **176,693 completed organic analyses** in its rolling window. This is a fresh computation of older analyses, not evidence of new AI processing. The newest visible completed analysis by processing time was **October 3 at 10:01:04 UTC**. New raw posts are collected but do not appear as analyzed sentiment while AI is disabled. Existing results progressively expire; continued disablement will eventually leave no recent analyzed data.

Retention is operational: hourly logs record raw-post and matching V2 deletions, with all three protected audit-log deletion counters zero. The current database measurement is **428 MB**, versus 475 MB after yesterday's cleanup and 585 MB before it. These are PostgreSQL size measurements, not a verified Supabase billing/quota reading.

### Deployment State

- GitHub `main` and local HEAD both contain `ebbdece381cffe701b77da2dc0bcfeed5347915e`, **Reduce pipeline costs and harden retention safety**. Remote SHA checked October 6 at 15:27 UTC.
- Both Edge Functions and the functionality SQL were **reported deployed manually** on October 5. The complete hosted source/configuration has not been exported and compared with this commit. Retention indexes were only partially applied.
- **Frontend deployment remains incomplete.** Pages run [37371894972](https://github.com/ChristianFogtdal/GlobalSentiment/actions/runs/37371894972) failed because a hosted runner did not acquire the job; deployment was skipped. An explicitly approved retry was accepted October 6 at 15:11:30 UTC. At **15:27:26 UTC**, it was still queued, with no conclusion. The public script still used five-minute polling, not the committed hourly behavior.

### Readiness Assessment

**Routine collection, retention and cached reporting are verified for the observed period. AI processing is not ready to resume without the gates in sections 7-8.** Recent work reduced schedules and batch sizes, added exact-request content caching, enforced worker ownership with leases/fences, limited reporting and disposable data to 720 hours, preserved audit history, and reclaimed storage. Native concurrency/cancellation tests and the enabled hosted Foundry path remain unverified. The operator knowingly accepted a live-only rollout without a new backup or staging environment; that decision is not a passed safety test or standing permission for future writes.

## Start Here (For Future Humans And AI Agents)

- **Treat this as a dated snapshot, not live telemetry.** Recheck production before acting after a break; use the [Resume Checklist](#resume-checklist).
- **Running:** hourly Bluesky collection, 720-hour retention and hourly dashboard cache refresh. The last observed overnight window had 18 successful runs per active job.
- **Paused:** AI analysis and recovery. New posts are collected but not analyzed; refreshing the dashboard does not make old sentiment new. Existing analyzed data will expire.
- **Database health:** 428 MB at the last measurement, down from 585 MB. Cleanup was keeping pace and reported zero audit-log deletions; provider quota/headroom was not independently verified.
- **Deployment:** GitHub `main` contains `ebbdece`; its Pages retry was queued and the served frontend still polled every five minutes. Edge Functions/SQL were manually deployed, with incomplete parity evidence and partial indexes.
- **Do not replay migrations or reset state.** There is no verified live migration ledger; baselines are local fixtures. Preserve fences, audit logs, permissions, ownership FKs and retention guards.
- **Do not enable AI, spend on provider tests or change production without exact approval.** The accepted live-only/no-backup rollout is not blanket permission for new writes.
- **Next validation:** verify Azure/configuration and the outstanding native/hosted safety gates, then perform one approved uncached single-post analysis with persisted-result read-back. Follow [section 8](#8-re-enablement-runbook) before enabling schedules.

## Known Good Configuration

This is the central settings reference. **Known good describes the observed running schedules, not certification of every source default or the disabled AI path.** Schedules/state were supplied in the October 6 SQL snapshot; Edge environment overrides were not fully read back. All times are UTC as observed; verify `cron.timezone` before recreating jobs elsewhere. These tables are not commands or authorization to change production.

### Scheduled Jobs And Operational Gates

| Capability / job or setting | Recorded value | Evidence / interpretation |
| --- | --- | --- |
| Ingestion: `ingest-bluesky-ai-coding-posts` | `0 * * * *`, active | Observed: hourly at minute 00, 18 successful dispatches corroborated by persisted batches. |
| Retention: `sentiment-retention-cleanup` | `48 * * * *`, active | Observed: hourly at minute 48, 18 successful cleanup runs. |
| Refresh: `dashboard-v2-cache-refresh-safety-net` | `58 * * * *`, active | Observed: hourly at minute 58, 18 successful refresh runs after 21:00 UTC October 5. |
| Analysis: `analyse-posts-ai-sentiment` | `5-59/10 * * * *`, inactive | Observed disabled; cadence is every ten minutes at 05/15/25/35/45/55, not permission to enable. |
| Recovery: `reclaim-stuck-processing-analyses` | `52 * * * *`, inactive | Observed disabled; configured hourly at minute 52. |
| `LLM_PROCESSING_ENABLED` | `disabled` | Reported October 5; disabled-path response verified then, secret not reread October 6. Only exact `enabled` permits processing in source. |
| `app_settings.retention_enabled` | `true` | Operator-enabled; subsequent deletion audits corroborate an open gate. New-deployment source defaults remain disabled. |
| Retention/reporting window | 720 elapsed hours (30 days) | Final source contract; live cutoff evidence agrees. Strictly older records are eligible for deletion; live ownership can defer it. |
| Cleanup request | 1,000 parents per default call | Source-defined schedule; bounded child/orphan/cache phases also apply. Not a total transaction-row cap. |
| Cleanup caller guards | `statement_timeout='60s'`, `lock_timeout='2s'`, `timezone='UTC'` | Final source cron contract; do not remove. Inspect actual job command privately before changes. |
| Dashboard stale-cache limit | 90 minutes | Final source rejects absent, future-dated or older generations. Fresh refresh evidence does not test the rejection path. |

### Edge Limits: Source Defaults, Not Verified Hosted Overrides

| Edge numeric setting | Source default | Source bounds / meaning |
| --- | --- | --- |
| `INGEST_INTERVAL_MINUTES` | 60 | 60-1440; changes admission interval, not cron wake-ups |
| `INGEST_POSTS_PER_SOURCE` | 25 | 1-100; capped by `INGEST_MAX_POSTS_PER_HOUR` |
| `INGEST_MAX_POSTS_PER_HOUR` | 100 | 1-100, for the single implemented source; default run budget is still 25 |
| `INGEST_TERMS_PER_RUN` | 5 | 1-58, additionally bounded by post budget |
| `INGEST_POSTS_PER_TERM` | 5 | 1-25; requested search limits share the run budget |
| `LLM_BATCH_SIZE` | 5 | 1-5; old settings above five clamp to five. Proposed restart canary is one, not a verified live override. |
| `ANALYSIS_INTERVAL_MINUTES` | 10 | 10-1440; shared by scheduled and manual requests |
| `ANALYSIS_MIN_TEXT_LENGTH` | 8 | 1-100 Unicode code points after URLs are removed; must contain a letter |

Malformed/below-minimum settings fall back to defaults; above-maximum settings clamp. The observed 3-25 inserted posts per hour are consistent with defaults but do not establish every environment value. Sources: [costControls.ts](../supabase/functions/_shared/costControls.ts), [ingestion worker](../supabase/functions/ingest-bluesky-search/index.ts), [analysis worker](../supabase/functions/analyse-posts/index.ts).

For service dependencies/authentication, see [section 2](#2-current-production-configuration); for data/retention safeguards, [section 5](#5-database-status); for provider settings, ownership checks and activation order, [section 8](#8-re-enablement-runbook).

## 2. Current Production Configuration

### Service Identity And Access

| Item | Value / evidence |
| --- | --- |
| Public website | https://christianfogtdal.github.io/GlobalSentiment/ |
| GitHub repository | https://github.com/ChristianFogtdal/GlobalSentiment |
| Supabase project | `bsnzcspfrmlihwxqkjyv` |
| Supabase API origin | `https://bsnzcspfrmlihwxqkjyv.supabase.co` |
| Edge endpoints | `/functions/v1/ingest-bluesky-search` and `/functions/v1/analyse-posts` |
| Hosting | GitHub Pages; previously verified source `main:/`, platform-generated Pages workflow. No tracked workflow file or frontend build system. |
| Local framework | Static HTML/CSS/JavaScript; server-side TypeScript Edge Functions; Supabase PostgreSQL, pg_cron, pg_net and Vault. |

Both workers require `POST` and a matching `x-ingestion-secret` header. The scheduler uses Vault entry `bluesky_ingestion_secret`, which must match Edge secret `INGESTION_SECRET`. Both workers also need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; ingestion needs `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD`. Never put private credentials in this document, browser code, SQL output pasted into chat, or Git.

[supabase/config.toml](../supabase/config.toml) sets `verify_jwt = false` for both functions. **The actual hosted gateway setting is not verified.** Manual web-editor deployments may differ. If hosted JWT verification is enabled, the gateway additionally needs an appropriate legacy JWT; an `sb_publishable_*` key is not a Bearer JWT. A successful disabled-path manual request does not validate stored cron headers. Inspect configuration privately without exposing secret values.

### Enabled

Schedules and operational gates are centralized in [Known Good Configuration](#known-good-configuration). Dependencies are listed here so configuration is not confused with execution readiness.

| Service | Configuration and dependencies |
| --- | --- |
| Collection | Calls ingestion through pg_net. Requires Bluesky credentials, scheduler secret, Supabase service credentials and fenced RPCs. Writes raw posts only. |
| Retention | Requires enabled setting/job, final owner-aware cleanup, caller timeouts, reviewed FKs/triggers and bounded batches. Actual deletion logs confirm the gate allows cleanup. |
| Dashboard refresh | Calls `refresh_dashboard_v2_cache()`. Computes recent organic V2 aggregates and top-topic trends. Depends on SQL data, not Azure availability. |
| Reporting cache / public reads | On demand through `get_dashboard_v2()`, `get_dashboard_v2_trend(p_topic)` and `completed_post_analyses_v2`; dashboard generations must meet the freshness guard. |

**Collection defaults from source, not a full secret inventory:** five rotating searches from 58 terms, up to five results per search, at most 25 candidate posts per admitted run. Each search uses a `since` timestamp based on the configured interval; no pagination or missed-interval backfill exists. URI deduplication and `ON CONFLICT DO NOTHING` prevent replacement of existing raw posts. Invalid/future/over-720-hour dates and insufficient text are rejected. `fetched_at` comes from the database default. Responses report candidate count, not actual inserted count; verify insertion using stored rows.

**Cache and frontend:** refresh keeps three database generations, with up to 200 recent processed rows in the aggregate and precomputed top-20 topic trends. Other topic requests can run a live aggregate. Reporting includes completed organic rows across prompt versions, treating historical null content types as organic. Data Review includes both organic and filtered-away completed V2 rows. Hourly buckets with fewer than three posts suppress their score. Committed [app.js](../app.js) polls only the active view hourly, suppresses hidden-tab work and gates visibility refresh by freshness; **public deployment still polls every five minutes**. The committed behavior can add up to roughly another hour of browser latency beyond the hourly database snapshot.

### Disabled

| Capability | Recorded state | Reason and consequences |
| --- | --- | --- |
| AI processing switch | `LLM_PROCESSING_ENABLED=disabled`, operator-set October 5 | Azure was reported unavailable. Source requires the exact value `enabled`; anything else exits before database selection/provider calls. New raw posts are not enriched. Secret value was not independently reread October 6. |
| `analyse-posts-ai-sentiment` | `5-59/10 * * * *`, inactive | Prevents scheduled analysis. Zero cron runs observed since October 5 at 21:00 UTC. Manual requests still need the switch, valid auth and admission. |
| `reclaim-stuck-processing-analyses` | `52 * * * *`, inactive | Recovery was intentionally left off with analysis; it does not require Azure itself. No scheduled stale-claim transitions occur. |
| Azure/OpenAI processing by this app | Not running through the scheduled analysis path | No recent completions and the documented kill switch/cron state support this. Azure account/deployment health, credentials, billing and independent activity outside this app were not verified. |

There is no independent OpenAI fallback, translation service or alternate active analysis worker in the repository. Azure resource existence does not imply a working provider path. Raw collection, retention, cached reporting and Data Review continue without Azure. The frontend has no dedicated indication that AI is paused; a fresh cache timestamp can be mistaken for fresh sentiment. With continued disablement, existing analyzed posts expire by publication age and the dashboard eventually becomes empty. Do not disable retention merely to preserve the appearance of fresh coverage.

## 3. End-to-End System Status

This table combines dated live evidence with source contracts, not product-plan claims.

| Capability | Status | Notes |
| --- | --- | --- |
| Collection | Enabled; observed working | 18 successful cron dispatches plus 18 hourly persisted batches, 293 posts, since the observed rollout window. Cron success alone would not prove Edge HTTP success. |
| Analysis | Disabled | Kill switch reported disabled; cron read-back inactive; latest visible completed processing October 3. Enabled hosted path not tested after rollout. |
| Dashboard | Enabled; serving older frontend | HTTP 200 aggregate, 176,693 analyzed organic posts at 14:58 UTC. Pages cost-control deployment pending. |
| Retention | Enabled; observed working | 18 hourly successful runs and actual deletion audit entries; logs preserved by cleanup. |
| Cache Refresh | Enabled; observed working | 18/18 successful runs after 21:00 UTC; roughly 73-83 seconds each. |
| Azure AI | Disabled at application level; provider readiness unknown | No verified restored model deployment or paid-path smoke test. |
| Recovery | Disabled | Final source sets inactive-owner processing rows pending; does not delete them. |
| Content-result reuse | Implemented; enabled-path production evidence missing | Exact-request SHA-256 cache, separate from dashboard cache. Do not claim measured cache-hit savings. |
| Worker fencing | Implemented; ingestion operational | Owner token + monotonic fence + lease; true concurrency/crash tests remain unexecuted. |
| Website release | Pending | Remote source current; approved retry queued at 15:27 UTC; served script still old. |

## 4. Recent Cost Optimization Work

### What Changed And Why

Unbounded raw/analysis storage, frequent search/AI calls, repeated full-history aggregates and unnecessary browser reads were the main source-derived cost drivers. The October 5 change set addresses each without dropping reporting/provenance columns:

| Area | Before | Current source / operational state |
| --- | --- | --- |
| Ingestion | Prior live schedule every 15 minutes; 58 searches per run in old source | Hourly; default five rotating searches and 25 candidate maximum. Short HTTP timeouts, no pagination/retry, URI deduplication. |
| Analysis | Every two minutes; batch default 10 / maximum 25 | Schedule defined every ten minutes; batch default/maximum five. **Currently inactive**, not operating at the proposed reduced ceiling. |
| Content cache | No cross-URI exact-input reuse | SHA-256 covers exact transmitted request, endpoint, deployment, configured model identity/revision and prompt version. Valid completed hits avoid another provider call. |
| Ownership | Start-time gate and unfenced writes | Renewable 180-second database lease, 120-second local admission deadline, owner UUID and increasing fence, RPC-only worker mutations. |
| Recovery | Historical deletion of stale processing claims | Preserves/reoffers abandoned claims using ownership; explicit failed/complete posts remain terminal. Recovery schedule disabled today. |
| Reporting | Full-history aggregates 12 times/hour | Rolling 720-hour organic aggregates once/hour. Server cutoff applies independently of physical cleanup. |
| Browser | Five-minute polling, including unnecessary reads | Source now hourly active-view-only; **not yet publicly deployed**. |
| Retention | No rolling cleanup | Hourly bounded child-first removal after 720 hours, live-owner protection, protected audit logs. |
| Legacy/storage | Populated legacy table and larger V2 relation | Operator-approved legacy `TRUNCATE ... RESTRICT`, regular vacuum, then V2-only `VACUUM (FULL, ANALYZE)` reported complete. Do not repeat automatically. |

Fences prevent stale database commits, not an external charge already incurred. Expired cache entries are misses and abandoned processing is reclaimable. A provider response lost before commit can cause a later retry and duplicate spending. Earlier at-most-once claims are superseded.

### Expected Savings: Source-Derived, Not Billing Measurements

- Default Bluesky request ceiling: 236/hour before (`4 * (1 login + 58 searches)`) versus six/hour after (`1 + 5`), approximately 97.5% lower under those configurations.
- Candidate ceiling: 1,160/hour versus 25/hour by default, approximately 97.8% lower. Candidates are not guaranteed new inserted rows.
- If re-enabled at approved defaults, analysis permits at most five calls per admitted invocation and six ten-minute admissions per UTC hour: 30 calls/hour, versus the old 750/hour maximum. This is not a token or monetary budget, an exactly-once guarantee, or necessarily a sliding-hour bound.
- Cache recomputation: 288/day to 24/day, 91.7% fewer scheduled refreshes. CPU/latency/dollar reduction is not necessarily proportional.
- Committed frontend idle background reads: approximately 24/hour/tab to one/hour/tab, excluding user actions/retries; that benefit is pending deployment.
- Under continuous maximum default intake, raw steady-state intake retained for 30 days is at most approximately 18,000 rows plus deletion lag. Present historical volume, audits, indexes, duplicate result cache and logs prevent using this as a byte estimate.

### Verified Results And Unknowns

Observed: hourly jobs ran; 293 raw posts were inserted in 18 batches; cleanup removed 316-576 raw posts and matching V2 rows per hourly run in the 18-run window; protected audit-deletion counters were zero. Database size is 47 MB lower than yesterday's post-cleanup 475 MB and 157 MB below the earlier 585 MB reading. V2 size remains 260 MB. Do not attribute the additional overnight reduction to any single table or operation without further measurements.

Unknown: actual Azure token/currency savings, present provider billing, content-cache hit rate, before/after matched-workload CPU savings, exact hosted environment overrides, Supabase quota reporting, full retention index deployment and statistical representativeness at reduced intake. Raw/analysis rows should decrease while historical expiry exceeds intake; physical relation files can plateau because PostgreSQL reuses freed pages. Indefinitely retained audit/extension history can still grow.

## 5. Database Status

### Latest Production Evidence

Operator-supplied SQL snapshot: **2026-10-06T15:12:51.381248+00:00**.

| Measurement | Observed value |
| --- | --- |
| Database (`pg_database_size`) | 428 MB |
| Raw posts including indexes (`pg_total_relation_size`) | 128 MB |
| V2 analyses including indexes | 260 MB |
| Legacy `post_analyses` exact row count | 0 |
| Latest retention run | October 6 at 14:48 UTC; cutoff September 6 at 14:48 UTC |
| Latest retention deletion counts | 536 raw posts and 536 V2 analyses; zero legacy/cache/audit deletions |
| Pending expiry preview at 15:12 UTC | 268 raw posts and 268 V2 analyses; all other reported targets zero |
| Latest refresh | 14:58 UTC, success, 78,030 ms |
| Post-21:00 refresh durations | 73,095-82,652 ms, all 18 successful |
| Earlier refresh error | October 5 at 19:17 UTC, timeout after 120,559 ms; all 19 later refreshes in the supplied history succeeded |

The 268 eligible expired parents are consistent with records aging out since the last hourly cleanup; this is not evidence of a runaway backlog. Recheck successive runs rather than assuming a preview must always be zero. The latest raw `published_at` minimum observed publicly was September 6 at 14:48:01 UTC, consistent with the cutoff. Public review independently applied the rolling 720-hour filter.

### Data Model And Protected State

- `bluesky_posts`: URI-primary-key raw public text, author, language, source URL and timestamps. Live schema has `published_at NOT NULL`, `source_url NOT NULL`, `fetched_at NOT NULL DEFAULT now()`, `has_v2_analysis DEFAULT false`, and legacy `sentiment_score` smallint constrained to 0-100. **There is no raw `created_at` column.** New ingestion omits unused legacy scoring fields.
- `post_analyses_v2`: internal analysis state and validated fields; unique `(post_uri, prompt_version)` and FK to raw URI. Canonical sentiment score is -1 to 1. SQL reporting and frontend mapping produce a 0-100 display score.
- `post_analyses`: retained legacy table/schema, currently empty. No active repository worker populates it. Old legacy RPCs are not a supported fallback pipeline.
- `analysis_content_cache`: validated reusable results and ownership references, not raw provider responses. Cache validity includes creation age; physical cleanup excludes live ownership.
- `pipeline_run_state`: protected lease/cadence state for `analysis` and `bluesky_ingestion`. Preserve owner/fence history; do not truncate or reset it.
- `app_settings`: protected configuration, including `active_prompt_version` and `retention_enabled`. Current active prompt string was not supplied. Source history seeds `v1` and later sets `v4`; this does **not** prove live `v4`.
- `dashboard_v2_cache`: aggregate snapshots, excluded from retention; refresh separately keeps three generations.
- `retention_cleanup_log`, `analyse_posts_invocation_log`, `dashboard_v2_cache_refresh_log`: protected operational/audit history, no automatic retention in the approved cleanup.

### Retention Contract

Final source removes disposable records strictly older than `now() - interval '720 hours'`; exactly-at-cutoff rows survive. Raw publication age governs associated V2 and legacy analyses. Old legacy orphans use their analysis creation time. Old inactive content-cache entries use their creation time. Active analysis ownership can preserve otherwise expired records until safe to remove.

The default cleanup request is 1,000 parents, with bounded child/orphan/cache phases; accepted argument range is 1-10,000. This is not a 1,000-row total transaction cap. V2 and legacy children are deleted before parents; many children can require additional runs. The final function checks dependencies, rejects unexpected incoming FKs/delete triggers, uses advisory transaction lock `78123901`, and logs deletion counts transactionally. New source deployments keep retention disabled; the live activation was separately approved.

The source-defined cron command sets **caller-level** `statement_timeout='60s'`, `lock_timeout='2s'`, and `timezone='UTC'` before calling `cleanup_sentiment_history(1000)`. The function refuses missing/unbounded/too-large timeout settings. Do not remove those guards. Successful routine cleanup is not a forced cancellation/rollback test.

Cleanup does not target configuration, aggregate generations, auth, billing, user-managed/reference tables, Vault, `cron.job`, `cron.job_run_details`, pg_net queues/responses or protected audit history. Extension-managed logs may need a separately reviewed policy. No new log purge is authorized by this document.

### Important Warnings

1. **No live migration ledger:** `supabase_migrations.schema_migrations` was absent in the supplied October 5 catalog results. Manual application means filenames cannot tell which definitions are installed. Do not run `db push`, `db reset` or a blanket replay to reconcile it.
2. **Historical chain is not clean-reset-safe:** early files reference tables before later reconstructed baselines. The two baseline migrations are explicitly local test fixtures, not production repair scripts. Tests load dependencies in a special order.
3. **Partial indexes:** some October 5 index builds timed out. The exact missing/invalid subset is unknown. Inspect `pg_index` validity/readiness and `pg_indexes` definitions before proposing changes. The migration lists `bluesky_posts_retention_at_idx`, `bluesky_posts_recent_unanalysed_idx`, `analysis_content_cache_created_at_idx`, `post_analyses_v2_processing_updated_idx`, and two previously defined audit timestamp indexes. Ordinary `CREATE INDEX` can block writes; no automatic retry/build is authorized.
4. **Schema reconciliation:** compare live function definitions, ACLs, triggers, constraints and columns with the final migrations. The legacy FK is installed `NOT VALID` in source; do not assume historical validation. Cache-owner FKs use `ON DELETE SET NULL` and a transition trigger. Do not replace them with broad cascades.
5. **RLS is not the whole authorization model:** final migrations revoke direct worker mutations and old unfenced admission/claim paths, including service-role privileges. Current workers use service-role-only SECURITY DEFINER RPCs with fixed search paths. Do not restore old grants to make an old worker work.
6. **Disk versus rows:** deletes usually free reusable space, not proportionally smaller files. Routine vacuum is not equivalent to `VACUUM FULL`. Previous compaction was an individually approved, locking operation; repeat only with a new reviewed plan.

Sources: [fenced pipeline](../supabase/migrations/20261005100000_fenced_pipeline.sql), [safe retention](../supabase/migrations/20261005101000_safe_retention.sql), [caller timeouts](../supabase/migrations/20261005102000_retention_caller_timeout.sql), [UTC reporting](../supabase/migrations/20261005103000_utc_reporting.sql), [operator SQL](../supabase/scripts/retention-operations.sql).

## 6. Deployment History

### Code Changes Versus Production Changes

| Event | Evidence and limits |
| --- | --- |
| September development | Migration history evolves V2, prompt contract, content filtering, aggregate cache, telemetry and cadence. It is source history, not an applied-migration ledger. |
| October 5 local implementation | 29-file commit `ebbdece381cffe701b77da2dc0bcfeed5347915e`, authored October 5 at 22:34:56 +02:00; cost controls and safety repair. |
| October 5 publication | User approved commit/push/site deployment. Push advanced `main` from `b5bf7f8` to `ebbdece`; GitHub `main` independently confirmed at that SHA October 6. |
| October 5 Pages attempt | Run 37371894972 failed; build and report jobs canceled, deploy skipped. Annotation: "The job was not acquired by Runner of type hosted even after multiple attempts". This was not an application compile failure. |
| October 6 Pages retry | User approved rerunning that exact run/commit. Accepted at 15:11:30 UTC; last checked queued at 15:27:26 UTC. Old five-minute polling script still served. A push and a queued workflow are not successful deployment. |
| October 5 Edge deployments | Operator reported updating both functions in the web editor. Hosted files flattened shared helpers to `costControls.ts` and `workerLease.ts` alongside `index.ts`, using `./` imports; repository uses `../_shared/`. Full deployed parity not independently verified. |
| October 5 SQL deployment | Operator manually applied functionality migrations and checked objects. Retention-index migration partial. No live migration ledger. Record future catalog reconciliation explicitly. |
| October 5 kill switch | Operator set `LLM_PROCESSING_ENABLED=disabled`. Authenticated HTTP 200 with zero selected/completed/failed and `skipped: processing disabled` verified only the disabled path. |
| October 5 retention and storage | Explicitly approved automatic retention and bounded cleanup. Expired-parent backlog fell from 29,492 to three in the final check. Legacy truncate with `RESTRICT` and V2-only full vacuum reported successful. Database 585 -> 475 MB; V2 approximately 370 -> 260 MB. |
| October 6 operational check | Private SQL confirmed 18 successful runs per active job, zero legacy rows, protected audit counters, 428 MB database. Public reads confirmed current ingestion and reporting. |

Manual production state not encoded as a repeatable deployment: Edge web-editor layout, secret values, Vault contents, possible gateway flags, exact installed index subset, SQL function deployment versions, approved job activations, cleanup execution, legacy truncation, compaction and the decision to proceed without backup/staging. The source migrations deliberately retain conservative disabled retention defaults and do not encode today's operator-approved enabled state.

### Migration Inventory Reviewed

All **40** migration files were reviewed. This inventory is a navigation aid, **not an execution order or proof of application**. Links point to the original files; later definitions supersede earlier ones.

| Migration | Purpose / current interpretation |
| --- | --- |
| [20260902090000_scheduled_bluesky_search.sql](../supabase/migrations/20260902090000_scheduled_bluesky_search.sql) | Raw access/index changes; despite the name, does not create ingestion cron. |
| [20260902122000_add_original_language.sql](../supabase/migrations/20260902122000_add_original_language.sql) | Raw language column. |
| [20260902150000_legacy_baseline_bluesky_posts.sql](../supabase/migrations/20260902150000_legacy_baseline_bluesky_posts.sql) | Local reconstructed raw fixture; never replay on production. |
| [20260902200000_legacy_baseline_post_analyses.sql](../supabase/migrations/20260902200000_legacy_baseline_post_analyses.sql) | Local legacy fixture/RPCs; never replay on production. |
| [20260902210000_post_analyses_v2.sql](../supabase/migrations/20260902210000_post_analyses_v2.sql) | V2 storage, constraints and validation view. |
| [20260903090000_grant_service_role_bluesky_posts.sql](../supabase/migrations/20260903090000_grant_service_role_bluesky_posts.sql) | Historical raw privileges; fenced migration later restricts writes. |
| [20260903100000_scheduled_analyse_posts.sql](../supabase/migrations/20260903100000_scheduled_analyse_posts.sql) | Original analysis cron, wrong project URL later repaired. |
| [20260903110000_note_required_ingestion_secret_vault_entry.sql](../supabase/migrations/20260903110000_note_required_ingestion_secret_vault_entry.sql) | Documents manually provisioned Vault secret, not secret creation. |
| [20260903123451_completed_post_analyses_v2_view.sql](../supabase/migrations/20260903123451_completed_post_analyses_v2_view.sql) | Public completed-analysis view, later expanded/windowed. |
| [20260903140000_increase_analyse_posts_throughput.sql](../supabase/migrations/20260903140000_increase_analyse_posts_throughput.sql) | Historical five-minute analysis and 240-second pg_net wait. |
| [20260903143000_select_unanalysed_posts_function.sql](../supabase/migrations/20260903143000_select_unanalysed_posts_function.sql) | Initial candidate selector; superseded. |
| [20260904090000_active_prompt_version_contract.sql](../supabase/migrations/20260904090000_active_prompt_version_contract.sql) | Database-authoritative prompt setting/RPC. |
| [20260904091500_dashboard_v2_aggregate_rpc.sql](../supabase/migrations/20260904091500_dashboard_v2_aggregate_rpc.sql) | Original aggregate API. |
| [20260906130000_fix_analyse_posts_project_ref.sql](../supabase/migrations/20260906130000_fix_analyse_posts_project_ref.sql) | Repairs analysis cron target project. |
| [20260906140000_dashboard_v2_include_all_prompt_versions.sql](../supabase/migrations/20260906140000_dashboard_v2_include_all_prompt_versions.sql) | Aggregation across prompt versions. |
| [20260906141500_dashboard_v2_fix_statement_timeout.sql](../supabase/migrations/20260906141500_dashboard_v2_fix_statement_timeout.sql) | Aggregate index and function timeout changes. |
| [20260906143000_data_review_fix_statement_timeout.sql](../supabase/migrations/20260906143000_data_review_fix_statement_timeout.sql) | Public role timeout changes. |
| [20260906194500_prevent_cross_prompt_reanalysis.sql](../supabase/migrations/20260906194500_prevent_cross_prompt_reanalysis.sql) | Global prior-claim exclusion. |
| [20260910120000_post_analyses_content_type.sql](../supabase/migrations/20260910120000_post_analyses_content_type.sql) | Organic/promotional/spam classification; source prompt set to v4. |
| [20260910121500_dashboard_v2_content_type_filter.sql](../supabase/migrations/20260910121500_dashboard_v2_content_type_filter.sql) | Organic-only dashboard. |
| [20260910130000_dashboard_v2_trend_topic_index.sql](../supabase/migrations/20260910130000_dashboard_v2_trend_topic_index.sql) | GIN topic index and query change. |
| [20260914090000_dashboard_v2_cache_tables.sql](../supabase/migrations/20260914090000_dashboard_v2_cache_tables.sql) | Dashboard cache and refresh audit tables. |
| [20260914091500_dashboard_v2_cache_refresh_functions.sql](../supabase/migrations/20260914091500_dashboard_v2_cache_refresh_functions.sql) | Aggregate/trend/refresh/status functions. |
| [20260914093000_dashboard_v2_cache_read_cutover.sql](../supabase/migrations/20260914093000_dashboard_v2_cache_read_cutover.sql) | Seeds cache and cuts over reads; contains a write/refresh. |
| [20260914094500_dashboard_v2_cache_cron.sql](../supabase/migrations/20260914094500_dashboard_v2_cache_cron.sql) | Original five-minute refresh schedule. |
| [20260914100000_bluesky_posts_analysis_tracking.sql](../supabase/migrations/20260914100000_bluesky_posts_analysis_tracking.sql) | Marker/backfill/trigger/index; final selector no longer trusts marker alone. |
| [20260914110000_dashboard_v2_cache_refresh_statement_timeout.sql](../supabase/migrations/20260914110000_dashboard_v2_cache_refresh_statement_timeout.sql) | Refresh function timeout 240 seconds in source. |
| [20260914165500_dashboard_v2_cache_cron_offset.sql](../supabase/migrations/20260914165500_dashboard_v2_cache_cron_offset.sql) | Historical offset five-minute cache cadence. |
| [20260914201500_reclaim_stuck_processing_analyses.sql](../supabase/migrations/20260914201500_reclaim_stuck_processing_analyses.sql) | Historical delete/reset recovery; superseded. |
| [20260914210000_analyse_posts_invocation_log.sql](../supabase/migrations/20260914210000_analyse_posts_invocation_log.sql) | Batch telemetry table/stats view. |
| [20260914213000_analyse_posts_cadence_experiment.sql](../supabase/migrations/20260914213000_analyse_posts_cadence_experiment.sql) | Historical two-minute analysis cadence. |
| [20261005090000_pipeline_cost_controls.sql](../supabase/migrations/20261005090000_pipeline_cost_controls.sql) | Initial run state, content cache and admission/claim controls; later fenced. |
| [20261005091000_retention_indexes.sql](../supabase/migrations/20261005091000_retention_indexes.sql) | Retention/recovery indexes; partial hosted rollout. |
| [20261005092000_retention_cleanup.sql](../supabase/migrations/20261005092000_retention_cleanup.sql) | Initial cleanup/preview/audit; later hardened. |
| [20261005093000_cost_control_schedules.sql](../supabase/migrations/20261005093000_cost_control_schedules.sql) | Final cadence values; installs retention inactive. |
| [20261005094000_recent_sentiment_reporting.sql](../supabase/migrations/20261005094000_recent_sentiment_reporting.sql) | Rolling reporting and lighter refresh computations. |
| [20261005100000_fenced_pipeline.sql](../supabase/migrations/20261005100000_fenced_pipeline.sql) | Final leases, ownership, guarded writes, selector/recovery and grants. |
| [20261005101000_safe_retention.sql](../supabase/migrations/20261005101000_safe_retention.sql) | Final cleanup/preview protections; resets retention setting false. |
| [20261005102000_retention_caller_timeout.sql](../supabase/migrations/20261005102000_retention_caller_timeout.sql) | Caller timeouts/timezone in inactive retention job. |
| [20261005103000_utc_reporting.sql](../supabase/migrations/20261005103000_utc_reporting.sql) | Final UTC 720-hour views and stale-cache rejection. |

## 7. Outstanding Work

### Immediate Follow-Up

1. Confirm the Pages retry conclusion and deployed SHA, then inspect the served script for hourly active-view polling and moving chart window. Do not start another deployment merely because this snapshot says queued; check first. Further external writes need exact approval.
2. Continue a few days of read-only cron, Edge HTTP/log, refresh duration, cleanup backlog and size checks. Ingestion dispatch success alone does not prove HTTP success, and a successful invocation may contain partial search failures.
3. Compare Supabase dashboard quota/billing measurements with the 428 MB PostgreSQL result; confirm headroom without promising continued physical shrinkage.
4. Reconcile missing/invalid indexes and actual deployed definitions/ACLs with the final safety contract. Do not silently create indexes, edit grants or repair a migration ledger.
5. Preserve the analysis/recovery pause. Track how recent the analyzed data is separately from cache generation time.

### Required Before Re-Enabling Analysis

- Restore/verify Azure subscription/resource access, selected model deployment, endpoint compatibility, keys, quotas and an approved spend envelope. The original reason for Azure unavailability was not recorded precisely; do not invent one.
- Privately verify actual Edge secrets, gateway auth, Vault matching, job command target and source parity, including flattened imports. Verify `get_active_prompt_version()` and any legacy `LLM_PROMPT_VERSION` match. Changing a prompt does not automatically reanalyze completed posts.
- Reconcile final fencing/retention/schema permissions, ownership references and candidate/recovery behavior. Analyze incomplete/pending/failed state read-only; do not clear claims or reset fences to force a smoke test.
- Address the outstanding native concurrency/cancellation and enabled hosted-runtime gates below. Passing local mocks or routine cron does not meet these gates. A renewed decision to proceed with an unmet gate must be explicit, scoped, recorded as risk acceptance and never called a pass.
- Obtain exact approval for the enablement changes and paid smoke-test scope; then prove a new uncached analysis is paid for, validated, persisted and visible through reporting. Test schedule dispatch separately from manual invocation.

### Future Improvements (Not Automatic Blockers)

- Add an explicit paused-analysis/latest-analyzed timestamp to the UI, and distinguish illustrative hero quotes from live data.
- Add narrowly scoped provider usage/token/cost and ingestion HTTP-result monitoring; there is no monetary quota in the worker.
- Review refresh query plans and missing indexes to reduce 73-83 second refreshes; do not shorten schedules or raise timeouts as a substitute for evidence.
- Establish repeatable deployment manifests, configuration inventory and a carefully reconciled migration ledger. Do not manufacture applied history from filenames.
- Define separately approved archival policies for indefinitely growing operational/extension logs.
- Evaluate sampling bias, reduced topic coverage and sentiment quality; revisit the PRD's individual-exposure policy versus current public author/post display.
- Add permitted native CI and browser end-to-end/visual checks; no tracked automation currently establishes these gates.

## 8. Re-Enablement Runbook

**This section is a future procedure, not authorization to execute it. Analysis remains disabled today.** Every external write, paid test, secret update, job alteration, recovery invocation or deployment needs approval of its exact scope. Read-only inspection is pre-approved. Use secure operator interfaces; do not ask for secrets in chat or place them in shell history.

### Preconditions

1. Reverify the project ID, deployed worker version, `main` SHA, live schedules, function ACLs, final RPC bodies, current prompt version and pending work. Record timestamps and rollback settings. Keep analysis and recovery jobs inactive throughout preflight.
2. Confirm `LLM_PROCESSING_ENABLED` is disabled before checking the disabled path. A valid authenticated POST must return zero selected/completed/failed and `skipped: processing disabled`; missing/wrong scheduler auth must be rejected. These are hosted tests requiring approval, even though the expected disabled path performs no paid processing.
3. Verify all four required settings: `AZURE_FOUNDRY_ENDPOINT`, `AZURE_FOUNDRY_API_KEY`, `AZURE_FOUNDRY_DEPLOYMENT`, `AZURE_FOUNDRY_MODEL`. The source appends `/openai/v1/chat/completions` to the endpoint. The request `model` is the deployment name; the configured model identity is used for provenance/cache identity. There is no separate API-version parameter or inferred model fallback. Check that the deployed model supports strict JSON schema, `reasoning_effort: minimal` and `max_completion_tokens: 2000`.
4. Confirm the authoritative database prompt is nonempty. If `LLM_PROMPT_VERSION` remains set, it must match exactly or the worker refuses work. An in-place model/prompt behavior change requires deliberately versioning prompt/model identity to prevent stale content reuse. Do not change versions to force blanket reanalysis.
5. Confirm service credentials and matching Vault/Edge ingestion secret; inspect actual gateway settings and analysis cron URL privately. Verify analysis interval is at least ten minutes and batch ceiling five. Do not assume secret defaults, job existence or the old cron command are correct.
6. Confirm `acquire_pipeline_lease`, `renew_pipeline_lease`, `release_pipeline_lease`, `claim_post_analysis_fenced`, `finish_post_analysis`, `select_unanalysed_posts` and final recovery are installed with intended privileges. Old workers must not be active. Preserve lease fences; do not grant back direct writes. Retention must use the final owner-aware implementation if it continues during analysis.
7. Verify database load and index validity/readiness, pending/failed counts and cleanup backlog. Confirm provider budget/quota and failure-response limits. The historical no-backup/live-only choice remains recorded; do not silently impose a new environment, but explicitly resolve any still-unmet safety gate before new paid processing.

### Validation Gates

The last recorded October 5 local pass was **77 Edge tests plus browser logic regressions**, PGlite SQL regressions, strict TypeScript for **14 files**, and lint for **20 files**. These were not rerun merely to create this handover. To reproduce permitted local checks:

```powershell
node supabase/scripts/test-edge-node.mjs
node supabase/scripts/test-cost-controls.mjs
node supabase/scripts/check-types.mjs
git diff --check
```

There is no root package manifest. Node v24 was used for TypeScript execution with the explicit Deno-test adapter. Dependencies are outside the repo under `$env:TEMP/sentimentmap-validation`, overridable with `TEST_DEPS_PATH`; install only if needed:

```powershell
npm install --prefix "$env:TEMP/sentimentmap-validation" --no-audit --no-fund @electric-sql/pglite @supabase/supabase-js@2.117.2 typescript@5.9.3 eslint@9.39.5 typescript-eslint@8.71.0
```

On a permitted machine, run native `deno test --allow-env supabase/functions`, `deno check` on both worker entry points, and `deno lint supabase/functions`. Windows Device Guard/Application Control blocked Deno and native PostgreSQL on the original workstation. **Do not bypass policy, try replacement executables, or install WSL to evade it.**

The separate [test-concurrency-postgres.mjs](../supabase/scripts/test-concurrency-postgres.mjs) requires `pg` installed alongside validation dependencies and a privately configured `SAFETY_TEST_DATABASE_URL` for an **empty loopback database named `sentiment_safety_*`**. It creates disposable fixtures and is not read-only. Never target production. It must prove two-session contention, competing cache claims, killed-backend recovery, stale-fence rejection, retention/live-owner exclusion and real SQLSTATE `57014` cancellation with rollback/retry. PGlite is not this evidence: it did not enforce a tested statement timeout. Native Deno and PostgreSQL tests remain unexecuted in the recorded environment.

Hosted validation must verify actual roles/grants and pg_cron -> pg_net -> Edge -> Foundry behavior. Test wrong auth, disabled gate, missing/mismatched configuration, invalid provider output, provider timeout, lease loss and completion rejection in a permitted isolated environment or bounded specifically approved plan. Do not induce these failures or destructive race/cancellation tests on live data without separate authorization. Existing live hourly successes validate routine operation only.

### Enablement Steps In Order

1. Present exact proposed secret changes, one paid manual request, batch limit and eventual job activations for approval. Recommended canary: `LLM_BATCH_SIZE=1`, analysis interval ten minutes, both analysis/recovery cron jobs still inactive. This canary limit is a proposal, not today's verified configuration.
2. Apply only approved configuration fixes. Recheck source parity/auth/prompt/lease preconditions without resetting interval state. Failed admitted runs consume their cadence slot; wait for legitimate admission instead of bypassing it.
3. Identify one real recent raw post with useful text, no terminal V2 claim and no valid completed content-cache entry for the exact request. Verify eligibility read-only. Explicit failed/complete records cannot be forced through by submitting their URI; choose another eligible post rather than deleting history.
4. After approval, set `LLM_PROCESSING_ENABLED=enabled` while keeping both schedules inactive. Send one authenticated POST to `analyse-posts` with valid JSON `{"post_uri":"<exact eligible AT URI>"}`. Validate the payload before sending: missing/malformed JSON or a missing/non-string URI falls back to the batch path. The canary batch size limits that fallback but is not an authorization substitute.
5. Inspect the response body, not just HTTP status. Require `selected=1`, `completed=1`, `failed=0`, then verify exactly one complete V2 result with expected URI, prompt, provider `azure_foundry`, deployment/model, valid taxonomy/score and new processing time. Inspect cache/result and lease state. Confirm a real uncached provider call from provider/Edge evidence: `completed=1` could otherwise be a cache hit. Manual requests do not create batch invocation-log records.
6. Verify idempotency/ownership in the approved test environment: repeat terminal URI must not cause another provider call; a distinct URI with identical full request may reuse a valid cache; expired/inactive entries are reclaimable; stale owners cannot commit. Successful cache reuse and concurrency must not be inferred from an isolated successful completion.
7. Wait for the normal hourly refresh, or obtain separate approval for one manual refresh. Confirm successful refresh audit, new generation under 90 minutes, Data Review provenance and expected inclusion/exclusion by content type. An organic canary should enter aggregates; promotional/spam belongs in Filtered-away review. A single new post need not produce a visible chart point because of the three-post minimum.
8. Only after the canary passes and activation is approved, enable `analyse-posts-ai-sentiment` at `5-59/10 * * * *` with the approved batch size. Verify multiple actual HTTP responses and persisted outcomes, not cron dispatch status alone. Inspect best-effort batch invocation logs alongside results and provider telemetry; logging failures are swallowed by the worker.
9. Review and approve recovery separately, then activate `reclaim-stuck-processing-analyses` at `52 * * * *` using the final lease-aware function. It makes up to 1,000 stale inactive-owner processing rows pending (minimum age ten minutes), not complete/failed rows. The selector can already reclaim inactive processing without this sweep; enabling recovery is still an explicit operational change.
10. Observe several batches and at least one reporting and retention cycle with analysis running. Before raising the canary batch to the approved normal five, verify no repeated ambiguous calls, ownership failures, audit deletions, quota violations or growing stuck-work backlog. Record the final non-secret configuration and new evidence in this document.

### Success Criteria

- New uncached provider processing is independently evidenced and exactly one valid result is persisted with correct provenance; repeat terminal input does not trigger a new call.
- Configured batch size remains at most five, admission at least ten minutes, sequential provider calls, 20-second provider request bound and fenced writes remain intact. Database requests have a ten-second client bound; a client timeout alone is not proof of server rollback.
- Batch HTTP/body results, database rows and provider activity agree. A 200 containing `skipped`, `failed=1` or busy admission is not the successful canary.
- Approved analysis/recovery schedules are read back correctly; scheduled Edge execution is verified separately from SQL dispatch. Retention does not remove live-owned work or audit history.
- Reporting updates with the intended content type, cache stays within freshness bounds and usage remains within the operator-approved budget. Existing results across prompt versions are not silently backfilled.

### Rollback / Pause

1. With approved incident scope, set `LLM_PROCESSING_ENABLED=disabled` and deactivate `analyse-posts-ai-sentiment` and `reclaim-stuck-processing-analyses`. Verify read-back and disabled-path behavior. Do not assume a secret update or job pause cancels an already-running request; the switch is checked at invocation start.
2. Inspect/drain in-flight workers and lease expiry, persisted claims, provider activity and errors. Keep fences, failed rows, content cache and audit evidence. Do not mass-delete claims, reset counters or retry ambiguous paid attempts blindly.
3. Leave healthy ingestion/reporting/retention unchanged unless an identified fault requires a separately approved pause. If retention itself is implicated, the reviewed `disable_sentiment_retention()` procedure disables its setting/job; this is a write and does not undo committed deletes or cancel an existing transaction.
4. Do not roll back to unfenced workers or restore broad direct-write grants. Any compatibility deployment needs its own reviewed plan. Committed deletions require a backup to restore; no new backup was taken for the accepted October 5 rollout. External charges cannot be rolled back by SQL.
5. Record the incident, exact state, timestamp and unresolved gate before another enablement attempt.

## 9. Known Risks And Evidence Boundaries

### Known Safe Within The Observed/Tested Scope

- Routine hourly collection, refresh and retention operated successfully during the observed October 5-6 window. Public data corroborates insertion and reporting, not merely dispatch.
- Cleanup logs report zero deletion from all three protected audit tables. The legacy table is empty. Rolling reporting and physical expiry agree with the observed cutoff.
- Local tests cover auth/gates, limits, result validation, cache paths, UTC boundaries, ownership checks, atomic completion and retention preservation within their simulated/sequential environments.
- Source confines privileged credentials to server-side execution; public reporting interfaces are read-only for browser roles. This does not certify every hosted ACL.

These are bounded observations, not a blanket production-safety certification.

### Known Unsafe Actions Or Limitations

- Blind migration replay, baseline execution, resetting leases, restoring unfenced grants, blanket reanalysis, unapproved cleanup/index builds or enabling AI before validation can cause data loss, duplicate spending or service disruption.
- Exactly-once provider charging is not guaranteed. A lease protects accepted database writes, not an already-sent external HTTP request.
- Delete commits are irreversible without a restore source. No backup/staging was created for the operator-accepted rollout; rollback cannot recreate removed posts/analyses.
- The public frontend remains old at the last check. The site can look current because its cache refreshes even though analysis is paused. Continued pause will empty the recent analyzed window.
- Source-selected Bluesky data is not globally representative. Hero quotes in [app.js](../app.js) are hardcoded examples, not fetched live; [demo-data.js](../demo-data.js) is not loaded by the page and does not establish real geographic data.
- Data Review exposes public author handles, post text and per-post model results. This conflicts with the PRD's instruction not to expose individuals; no privacy-policy resolution is recorded.

### Unknown / Accepted But Unverified

- Native simultaneous-session races, killed-worker recovery and real cancellation/rollback under the new retention/fencing implementation. The older aggregate timeout is not a retention rollback test.
- Enabled hosted Foundry execution, exact Azure readiness/configuration, paid-call cache savings and provider idempotency. No such guarantee is configured.
- Complete hosted/source parity, actual gateway settings, all live ACLs/function bodies/FK validation, exact deferred indexes and provider/Edge secret overrides.
- Supabase quota/bill measurements, longer-term storage floor, audit-log growth and scale behavior after resuming analysis alongside retention.
- Detailed cancellation and performance gates were skipped for the live-only rollout. The user explicitly declined a new staging environment and backup. Do not erase this decision or treat it as authorization for later destructive tests.

### Documentation Conflicts And Authority

For **live state**, timestamped live catalog/API/results take precedence over source defaults. For **implemented source behavior**, final code and latest function definitions take precedence over prose/comments. For **intent**, product requirements are authoritative but do not prove implementation. This handover incorporates October 6 observations; [history-2026-10-05-production-safety.md](history-2026-10-05-production-safety.md) remains the detailed safety/October 5 operator record. Older material is preserved, not silently rewritten.

| Conflict | Resolution / authoritative evidence |
| --- | --- |
| Existing docs say ingestion/refresh unverified and database 475 MB | October 6 SQL/public reads supersede that snapshot: 18 successes each and 428 MB. |
| Older rollout sections say retention disabled or production untouched | Historical pre-rollout state. Operator later approved live retention; October 6 deletion audits establish execution. Source disabled defaults still apply to new deployments. |
| Cost report says trim audit logs / cache failures permanently suppress / at-most-once calls | Final safety migrations and worker supersede those claims: audits protected, expired/inactive cache reclaimable, ambiguous calls may repeat. |
| Raw `created_at` fallback mentioned in older prose | Live schema has no such column; corrected final SQL uses required `published_at`. |
| README/source comments imply public hourly polling or five-minute cron refresh | Repository frontend is hourly, deployed frontend still five-minute; live database refresh is hourly at minute 58. Separate release surfaces. |
| History describes full archive, legacy/V2 toggle and new keyword enrichment | Current reporting is 720 hours; UI toggle is Organic/Filtered-away V2; new ingestion omits legacy scores. |
| README says database performs no score conversion | Final reporting SQL computes display score; browser also maps review scores from -1..1 to 0..100. |
| PRD/README promise map, mood shifts or broad filtering | Current HTML/JS implement none of those capabilities. PRD and demo fixture are intended/historical scope. |
| Cost report earlier tests list 70 tests / 12 TS / 16 linted files | Later October 5 safety record reports 77 tests / 14 TS / 20 linted files. Neither is a fresh run during this handover. |
| Source history sets active prompt v4 | Read live `get_active_prompt_version()` before action; exact live value is unknown. Aggregate includes multiple versions regardless of returned active-version metadata. |

## 10. Future Agent Instructions

### Read These Files First

1. This document, especially snapshot dates, production warnings and re-enablement gates.
2. [history-2026-10-05-production-safety.md](history-2026-10-05-production-safety.md): live rollout record, fencing design and validation gaps; distinguish historical sections.
3. [history-2026-10-16-readme.md](history-2026-10-16-readme.md): endpoints, function setup and taxonomy; apply the conflicts above.
4. [history-2026-10-05-cost-optimization.md](history-2026-10-05-cost-optimization.md): rationale, defaults, estimates and historical audit; its opening safety supersession is essential.
5. [workerLease.ts](../supabase/functions/_shared/workerLease.ts), [costControls.ts](../supabase/functions/_shared/costControls.ts), [analysis worker](../supabase/functions/analyse-posts/index.ts), [ingestion worker](../supabase/functions/ingest-bluesky-search/index.ts), [supabase/config.toml](../supabase/config.toml).
6. Final [fencing](../supabase/migrations/20261005100000_fenced_pipeline.sql), [retention](../supabase/migrations/20261005101000_safe_retention.sql), [caller-timeout](../supabase/migrations/20261005102000_retention_caller_timeout.sql), [UTC reporting](../supabase/migrations/20261005103000_utc_reporting.sql) definitions and [operator SQL](../supabase/scripts/retention-operations.sql).
7. [app.js](../app.js), [index.html](../index.html), [styles.css](../styles.css) for implemented UI; [product-prd.md](product-prd.md), [history-2026-09-10-content-type-plan.md](history-2026-09-10-content-type-plan.md), [history-2026-10-16-evolution-snapshot.md](history-2026-10-16-evolution-snapshot.md) for intent/history, not deployment proof.
8. Validation runners in section 8 and neighboring tests before changing behavior. [inspect_legacy_analysis_schema.sql](../supabase/scripts/inspect_legacy_analysis_schema.sql) is a catalog aid, not a repair script.

### Do Not Do These Things

- Do not execute historical migrations, baselines, `db push`, `db reset`, truncation, compaction, recovery, cache refresh or retention just to inspect state. Function calls using `SELECT` can still write.
- Do not enable analysis/recovery or make a paid provider call without exact approval and validation. Do not assume Azure works, the model is unchanged, a prompt matches or JWT verification matches the local file.
- Do not treat source files, a commit, a successful push, a cron activation or a queued Pages run as proof of a successful deployment/execution.
- Do not assume a migration ledger exists; do not create fake applied history. Do not blindly recreate named jobs or replay the old wrong-project analysis URL.
- Do not change RLS, restore broad worker grants, remove FKs, reset `pipeline_run_state`, clear audit history, mass-delete failed claims or bypass the admission budget.
- Do not disable retention to conceal aging analysis, backfill old posts, change the 720-hour policy or promise exactly-once external calls without a separately approved design.
- Do not expose passwords, tokens, Vault decrypted values, service-role keys, provider secrets or raw credential-bearing job commands in chat or version control. Browser publishable configuration is not a server credential.
- Do not bypass operating-system policy to execute Deno/PostgreSQL. Do not use production for the destructive native test runner.
- Do not interpret previously accepted live-only/no-backup risk as blanket approval for new writes. Relevant reads are pre-approved; local implementation edits require task scope; external writes require exact proposed changes and explicit approval.

## Resume Checklist

Use the ordered checklist below as the single return-to-project procedure. It consolidates the former first-actions guidance; [section 8](#8-re-enablement-runbook) remains the detailed authority for validation, enablement and rollback. **Returning to the project does not require restarting analysis.** Stop at inspection unless resumption is explicitly requested and its gates are met.

## Returning After A Long Break

1. [ ] **Orient without changing state.** Read the snapshot and risk sections; inspect `git status`, HEAD and recent commits. Preserve unrelated user changes. Verify access to `ChristianFogtdal/GlobalSentiment` and Supabase project `bsnzcspfrmlihwxqkjyv` privately; do not assume old authentication remains valid. If database access is unavailable, ask the operator for the read-only query results below, never secrets.
2. [ ] **Verify the website release.** Check Pages run `37371894972` and any newer deployments, deployed SHA and remote `main`; compare the served script with source for hourly active-view polling and the moving chart window. Record the result rather than automatically rerunning the old queued deployment.
3. [ ] **Verify collection.** Read `ingest-bluesky-ai-coding-posts` schedule/state and recent runs, correlate Edge/pg_net HTTP evidence with recent `bluesky_posts.fetched_at` batches, and inspect partial-search failures. The recorded baseline is hourly at minute 00, with 3-25 inserted posts per batch, not a guaranteed yield.
4. [ ] **Verify retention.** Read the setting/job at minute 48, recent `retention_cleanup_log` counts and `preview_sentiment_retention()`. Compare expiry backlog across consecutive runs; confirm all three audit-deletion counters stay zero. Do not invoke cleanup, recovery or compaction as a diagnostic.
5. [ ] **Verify reporting separately from analysis.** Check the minute-58 refresh job, success/durations and cache generation age against the 90-minute guard. Read latest completed processing time separately: a fresh cache over old analyses is not fresh AI output.
6. [ ] **Verify storage and quota.** Remeasure database/raw/V2 sizes and compare with the dated 428/128/260 MB snapshot. Check Supabase quota/billing independently; freed rows do not guarantee smaller relation files or platform headroom.
7. [ ] **Verify Azure and configuration read-only.** Check subscription/resource access, deployment, supported request format, quotas and budget; privately check required secret presence/authentication, prompt agreement and both disabled jobs. Inspect actual indexes, constraint validity, ACLs and final RPC definitions, not just migration names. Do not share full credential-bearing cron commands.
8. [ ] **Resolve prerequisites and obtain exact approval.** Follow section 8's native/hosted validation gates. Explain discrepancies and any accepted remaining risk; present the precise configuration/test changes and rollback plan. Keep analysis/recovery paused while unmet gates remain unresolved. Readiness checks do not authorize a paid request.
9. [ ] **Run one approved manual analysis, then verify it.** Use the section 8 batch-one canary and an exact eligible `post_uri`, with both schedules still inactive. Confirm an uncached provider call, response body, exactly one persisted valid result/provenance and reporting inclusion after refresh. Do not proceed on HTTP 200 alone or delete claims to force eligibility.
10. [ ] **Enable only approved schedules and monitor.** After the canary and required checks pass, enable analysis at `5-59/10 * * * *` with the approved batch limit; review recovery at `52 * * * *` separately. Monitor several batches plus reporting/retention cycles, provider spending, ownership errors and stuck work. Use the pause procedure on failure; record dated evidence and final non-secret settings here, never substitute defaults for unknowns.

### Read-Only Starting Queries

Run in the intended Supabase project's SQL Editor or a trusted authenticated connection. These do not trigger workers, refreshes, recovery or deletion. Larger counts/previews can still consume resources; keep results bounded and use ordinary read timeout policies. Inspect a single selected query at a time if the editor returns only the last result set.

```sql
select now() as observed_at,
       pg_size_pretty(pg_database_size(current_database())) as database_size,
       pg_size_pretty(pg_total_relation_size('public.bluesky_posts')) as raw_size,
       pg_size_pretty(pg_total_relation_size('public.post_analyses_v2')) as v2_size;

select jobname, schedule, active from cron.job order by jobname;

select jobs.jobname, runs.status, count(*) as runs,
       max(runs.start_time) as latest_run
from cron.job_run_details runs
join cron.job jobs on jobs.jobid = runs.jobid
where runs.start_time >= now() - interval '24 hours'
group by jobs.jobname, runs.status order by jobs.jobname, runs.status;

select key, value from public.app_settings
where key in ('active_prompt_version', 'retention_enabled');

select * from public.preview_sentiment_retention();
select started_at, cutoff, removed from public.retention_cleanup_log
order by started_at desc limit 24;
select started_at, duration_ms, success, error_message
from public.dashboard_v2_cache_refresh_log order by started_at desc limit 24;

select generated_at from public.dashboard_v2_cache
order by generation desc limit 3;
select published_at, fetched_at from public.bluesky_posts
order by fetched_at desc limit 5;
select processed_at from public.post_analyses_v2
where status = 'complete' order by processed_at desc nulls last limit 1;
select count(*) as legacy_rows from public.post_analyses;
```

Ingestion cron results record SQL dispatch, not necessarily the asynchronously executed HTTP result. Correlate bounded pg_net/Edge execution evidence and persisted rows before declaring health. Inspect any error text for secrets before sharing it. For analysis, combine provider telemetry and exact persisted outcomes: batch invocation logging is best-effort and omits manual single-post requests.

### Review And Maintenance Record

This handover reviewed all 40 migrations; both Edge workers and shared helpers; all function tests; all seven operational/validation scripts; Supabase configuration; frontend HTML/CSS/JS and unused demo fixture; ignore configuration; and all six pre-existing root Markdown documents. No application code, existing docs, migrations, configuration, secret values or production state were changed for this task. Local source and remote `main` were checked at the recorded SHA. Prior test results are explicitly historical; only documentation integrity is checked for this new file.

The final documentation refinement added the dated snapshot, eight-bullet Start Here, central settings reference and ordered resume checklist. Numeric defaults were moved rather than duplicated; enabled-service dependencies remain in section 2. Detailed operational/migration warnings and all known-risk sections remain intact. Quota status and a deployed production SHA remain explicitly unverified. No new live checks or external writes were performed during this refinement.

When updating: retain the distinction between **source**, **reported action**, **observed live result** and **unknown**; include timestamps and source revision; archive superseded evidence clearly; do not let a newer narrative override contradictory implementation or catalog results without investigation.