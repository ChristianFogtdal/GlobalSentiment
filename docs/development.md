# Development

**Source-defined guide reviewed 2026-10-16.** Historical test results and deployment
reports are labeled below; this documentation update did not rerun runtime tests
or deploy anything. Read [agent instructions](../AGENTS.md), [architecture](architecture.md)
and [current status](../CURRENT_PROJECT_STATUS.md) before implementation.

## Repository layout

- Root HTML/CSS/JavaScript: static browser application; no framework/build step.
- [Edge functions](../supabase/functions): TypeScript workers with Deno-style tests
  and shared controls/lease helpers.
- [Migrations](../supabase/migrations): 40 historical SQL files, not a clean replay
  chain. [Database guide](database.md) indexes current definitions.
- [Scripts](../supabase/scripts): existing validation runners and operational SQL.
- [Documentation](../README.md#documentation): current guides, intent and dated history.

There is no root package manifest, checked-in dependency lockfile, tracked CI
workflow or repeatable unified deployment manifest. The
[local environment example](../supabase/.env.example) is ignored, incomplete and
not available in a clean clone. Use the [configuration inventory](operations.md#configuration-authority);
never add private values to a tracked file.

## Local frontend

Serve the repository root with an existing static server. For example:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

This example requires an available Python installation; it is not a repository
dependency. Use another already available static server if necessary.
Open `http://localhost:4173`. Serve only for local development, not as production
hosting, and stop the server when finished.

The browser uses its configured public Supabase APIs, so local serving is not an
offline fixture or an isolated database. Do not infer that a local page permits
production writes. The unused demo file is not a supported demo-mode switch.

## Validation

Run the smallest existing checks covering an approved change. Do not install
dependencies until a chosen check reports they are missing.

| Command | Coverage / effects |
| --- | --- |
| `node supabase\scripts\test-edge-node.mjs` | Deno-test adapter, mocked Edge calls and browser VM logic checks; not native Edge Runtime |
| `node supabase\scripts\test-cost-controls.mjs` | In-memory PGlite SQL fixtures, selected migration reapplication and production-safety regressions; writes disposable state |
| `node supabase\scripts\check-types.mjs` | Strict TypeScript with locally supplied Deno declarations; selected ESLint correctness rules |
| `git diff --check` | Whitespace errors in unstaged changes; also use `git diff --cached --check` for staged changes |

Node v24 was used in the historical local run; the adapter requires Node support
for TypeScript loading and `node:module` registration hooks. Do not claim an
untested older Node version is supported.

Runners resolve dependencies from `$env:TEMP\sentimentmap-validation`, overridable
with `TEST_DEPS_PATH`. The recorded installation recipe is:

```powershell
npm install --prefix "$env:TEMP\sentimentmap-validation" --no-audit --no-fund @electric-sql/pglite @supabase/supabase-js@2.117.2 typescript@5.9.3 eslint@9.39.5 typescript-eslint@8.71.0
```

This is the historical recipe, not a lockfile: PGlite is unpinned and remote
worker imports use a Supabase major version. Strict source/hosted/dependency
parity is not established. Keep the recorded TypeScript 5.9.3 pin for this
compiler-API runner. Do not silently upgrade tooling during unrelated work.

### Native checks on a permitted machine

```powershell
deno test --allow-env supabase\functions
deno check supabase\functions\analyse-posts\index.ts supabase\functions\ingest-bluesky-search\index.ts
deno lint supabase\functions
```

These commands are documented, not a claim that they pass. Device Guard/
Application Control blocked native Deno and PostgreSQL on the recorded
workstation; do not bypass policy or install alternate execution environments
to evade it.

The [PostgreSQL concurrency runner](../supabase/scripts/test-concurrency-postgres.mjs)
needs `pg` alongside validation dependencies, plus a privately configured
`SAFETY_TEST_DATABASE_URL`. Install that dependency only if needed for an approved
test. The runner accepts a loopback address and an empty database named
`sentiment_safety_*`.

```powershell
node supabase\scripts\test-concurrency-postgres.mjs
```

It creates fixture objects/roles, mutates rows, terminates its test backend and
forces cancellation. It is **not read-only** and must never target production
or a shared application database. Use a disposable test instance and account for
its created fixtures afterward; the runner closes connections, not the database.

### Validation limitations

**Historical October 5 evidence:** 77 Edge tests plus browser regressions,
PGlite SQL, strict TypeScript for 14 files and correctness lint for 20 files
were reported passing. These are dated results, not fresh validation.

PGlite does not establish simultaneous-session ownership or functioning statement
cancellation; the recorded timeout probe did not enforce the requested timer.
It lacks hosted pg_cron/pg_net dispatch. Native race, killed-backend recovery,
SQLSTATE `57014` cancellation/rollback and actual hosted-role/runtime behavior
remain unverified. Routine production success does not close these gaps.

Mocks also do not establish full handler/provider behavior. Score-conversion
tests currently cover a test-only helper rather than importing the browser
implementation. Test names/mock batches reflecting older behavior are not
authoritative production limits. Check exact contracts, request shapes and
measurable bounds when extending coverage.

## Behavior-preserving changes

- Keep provider calls sequential, batch/admission limits unchanged and ownership
  in fenced RPCs. Preserve exact serialized request/cache identity when extracting
  the pure analysis contract.
- Verify browser active-view/hourly/hidden-tab behavior, review query/filter and
  stale-response semantics, chart gaps, score mapping and empty/error states.
- CSS grouping must preserve cascade order; visual checks cover desktop, narrow
  layouts and reduced motion.
- Do not refactor historical migrations to remove copied definitions. Current
  SQL paths have differing aggregation semantics; changes need separate approval.
- Keep changes small. No framework, generic service layer or new test framework
  is required for the proposed organisation work.

## Deployment surfaces

1. **Frontend:** GitHub Pages was observed serving the assessed source on October
   16; see status for the dated commit/build evidence. No tracked workflow exists,
   but a push may still trigger platform hosting. Do not assume pushes are inert.
2. **Edge:** October 5 web-editor deployment was reported with shared helpers
   flattened beside each entry point and relative imports adjusted. Repository
   workers retain shared-directory imports. New extractions require deployment
   parity planning; local edits do not update hosted functions.
3. **Database:** manually applied SQL without a recorded migration ledger.
   Inspect actual objects/ACLs/indexes before an approved change.
4. **Secrets/schedules/provider:** independent configuration authorities described
   in [operations](operations.md#configuration-authority).

No automatic deployment, index repair, migration replay or paid smoke test is part
of local validation. Require exact approval and use
[production gates](operations.md#approval-gated-production-work).

## Documentation verification

For documentation-only changes:

- Resolve all local Markdown file links and heading fragments, including duplicate
  heading slugs; distinguish local integrity from external-site availability.
- Search for moved filenames; repair links/path references while retaining
  explicitly identified original paths as provenance.
- Search active guidance for stale job states, retention/recovery semantics,
  enablement, reporting/map claims and storage status.
- Keep superseded statements inside labeled history, not silently rewritten.
- Check staged and unstaged diffs plus untracked files. Compare pre-existing
  non-documentation files to the starting snapshot; preserve user changes.
- Do not run production queries/provider calls merely to validate documentation.
