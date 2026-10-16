# Current project status

**Snapshot consolidated: 2026-10-16. No new production checks were performed for
this documentation update.** Observations below are dated, not permanent
configuration. Full evidence, including the pre-existing uncommitted October 16
record, is preserved in the [operations history](docs/history-2026-10-16-operations.md).

## Operating decision and recorded schedules

**Keep AI analysis and recovery disabled.** Collection, retention and dashboard
refresh are operating at reduced hourly cadence in the latest observed window.
New raw posts are not enriched while analysis is paused; fresh cache generations
recompute older analyses, which progressively expire.

Operator read-back around **10:30 UTC**, corroborated by the **11:09:12 UTC**
scheduled-cycle verification on October 16:

| Job | Schedule | Active |
| --- | --- | --- |
| `ingest-bluesky-ai-coding-posts` | `0 * * * *` | true |
| `sentiment-retention-cleanup` | `48 * * * *` | true |
| `dashboard-v2-cache-refresh-safety-net` | `58 * * * *` | true |
| `analyse-posts-ai-sentiment` | `5-59/10 * * * *` | **false** |
| `reclaim-stuck-processing-analyses` | `52 * * * *` | **false** |

`LLM_PROCESSING_ENABLED=disabled` was operator-reported and its disabled response
verified October 5; the secret was not reread for this update. On October 16,
operator SQL observed `retention_enabled=true` and active prompt `v4`.
See [configuration authority](docs/operations.md#configuration-authority) before
interpreting these observations as source defaults or changing them.

## Storage maintenance completed

Both separately approved October 16 compactions are complete and verified.
Raw-post reclamation: **52,224,000 bytes**; V2-analysis reclamation:
**113,254,400 bytes**. Row counts were preserved during each maintenance window
and all main-table indexes were valid/ready afterward.

**Latest verified cluster size: 299,948,853 bytes (299.95 decimal MB), at
2026-10-16 11:09:12 UTC.** Against the recorded 500 MB quota this is approximately
**60.0% used, with 200.05 MB headroom**. This is a cluster SQL measurement, not
a newly refreshed Supabase quota panel or a current physical-free-disk reading.

The first restored cycle verified retention at 10:48 UTC (86 raw/V2 rows each
removed; protected audit deletion counters zero), refresh at 10:58 UTC
(32,930 ms), and ingestion at 11:00 UTC (19 persisted posts). Public dashboard,
Data Review and raw-post APIs returned HTTP 200 at 11:08:33 UTC. The database
was writable; no invalid/unready main-table indexes were reported.

**Storage work is closed.** Continue reduced intake, 720-hour retention and
routine autovacuum. No further compaction or log purge is recommended or approved
by this documentation work. Detailed before/after measurements, WAL evidence,
remaining-table assessment and verification limits are in the
[October 16 record](docs/history-2026-10-16-operations.md#current-state-october-16-compactions-completed).

## Deployment and known constraints

- **Observed October 16:** Pages build for `6a24ff355dfa9cdc4b97f17b5c72466a6bd9e313`
  succeeded October 6 at 15:43:10 UTC; served JavaScript matched the assessed local
  source after line-ending normalization and used hourly polling.
- **Reported October 5:** both Edge Functions and functionality SQL were deployed
  manually. Full hosted/source parity, gateway settings, secret overrides, ACLs,
  constraint validation and the exact deferred-index subset remain unverified.
- The live migration ledger was absent in October 5 catalog results. Historical
  migrations are not a clean bootstrap chain; never replay/reset them blindly.
- Native Deno, real PostgreSQL concurrency/cancellation and the enabled hosted
  Azure path remain unverified. Routine successful jobs are not those tests.
- Previous live-only/no-new-backup risk acceptance is historical, not standing
  permission for new writes. Fencing does not guarantee exactly-once provider
  charging. Protected application audit history can continue growing.
- The frontend does not explicitly indicate the AI pause. Public author/post
  display versus the PRD's individual-exposure policy remains unresolved.

## Next approved work

The approved scope is **documentation organisation only**: establish authority,
preserve evidence and validate links, anchors and documentation-only changes.
No runtime restructuring, deployment, SQL change, provider test or AI/recovery
enablement is approved by this phase.

After this phase, choose any code-organisation work separately. Ordinary
read-only health monitoring may continue; use the
[operations guide](docs/operations.md#read-only-health-checks).
Azure readiness and any paid re-enablement remain a separate approval-gated task.
