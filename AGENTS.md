# Repository instructions

## Mandatory reading order

Before proposing or changing code:

1. Read [README.md](README.md) and [CURRENT_PROJECT_STATUS.md](CURRENT_PROJECT_STATUS.md).
2. Read [architecture](docs/architecture.md) and [operations](docs/operations.md),
   including evidence labels, configuration authority and approval gates.
3. Read [database](docs/database.md) before pipeline, SQL or reporting work.
4. Read [development](docs/development.md), affected source and relevant tests.
5. Consult [product intent](docs/product-prd.md) or
   [dated history](docs/operations.md#historical-evidence) only as needed.
   Historical recommendations are not current operational instructions.

Inspect current documentation and `git status` before editing. Preserve existing
user changes and untracked files. Update the current guide that owns any changed
contract; do not duplicate operational snapshots across documents.

## Approval and safety boundaries

- AI analysis and stuck-analysis recovery must remain disabled unless their
  exact enablement is explicitly approved. Do not make a paid test call merely
  to verify a refactor.
- Obtain explicit approval before production writes, SQL changes, schedule
  changes, deployments or paid-provider calls. General implementation approval
  is not implicit production approval. Record scope and verification evidence.
- `SELECT` can invoke mutating functions: refresh, cleanup, recovery, lease and
  claim RPCs are not read-only diagnostics. Inspect function effects first.
- Do not replay, squash, reorder or rewrite historical migrations. Do not run
  blanket database push/reset or manufacture a migration ledger. Baselines are
  local fixtures and the recorded live ledger was absent.
- Preserve leases/fences, ownership FKs, guarded RPCs, audit history and retention
  protections. Do not restore unfenced grants, clear claims or reset state to
  force a test. Do not shorten retention or repeat compaction as cleanup.
- Never expose secrets, decrypted Vault values or credential-bearing cron commands
  in documentation, logs or chat. A browser publishable key is not a private key.
- Local files, successful cron dispatch and HTTP 200 alone do not prove deployed
  parity, persisted ingestion or successful analysis.
- Respect OS execution policy. Never bypass blocked Deno/PostgreSQL execution.
  Earlier acceptance of live-only/no-backup risk is not blanket authorization.

## Existing validation

Run only checks appropriate to the approved change:

```powershell
node supabase\scripts\test-edge-node.mjs
node supabase\scripts\test-cost-controls.mjs
node supabase\scripts\check-types.mjs
git diff --check
```

The Node runner adapts Deno tests and includes browser logic checks. PGlite runs
disposable SQL, not real multi-session/cancellation or pg_cron/pg_net validation.
Type checking supplies Deno declarations locally; lint uses selected correctness
rules. Dependencies and native commands are in
[development](docs/development.md#validation).

Native Deno checks and the PostgreSQL concurrency runner require a permitted
machine. The latter writes fixtures and terminates a test backend; use only an
empty disposable loopback `sentiment_safety_*` database, never production.
Documentation-only work needs link/anchor, reference and scope checks, not
provider calls or application/database test execution.
