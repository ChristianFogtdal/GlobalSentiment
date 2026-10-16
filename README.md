# Global AI Pulse / SentimentMap

A static dashboard of sentiment in term-selected public Bluesky discussion
about AI. It is not a representative measure of worldwide public opinion.

## Implemented, disabled and deferred

- **Implemented:** scheduled Bluesky collection, persistent source posts,
  rolling 720-hour retention/reporting, cached sentiment totals, topics,
  emotions, topic-filtered hourly trends, and searchable/paginated V2 Data Review.
- **Disabled by operating decision:** Azure Foundry analysis and stuck-analysis
  recovery. Keep both disabled unless explicitly approved. Collection, retention
  and cache refresh can continue without Azure. A fresh cache is not evidence
  of newly analyzed posts; existing analyzed data will age out.
- **Deferred:** geographic maps/country inference, mood-shift detection,
  model-generated explanations and cross-dashboard time/emotion/geography filters.
  Landing-page conversation examples are hardcoded, not a live feed.

The browser reads Supabase reporting APIs; it does not invoke collection or
analysis. Server-side TypeScript Edge Functions and PostgreSQL own the pipeline.
The frontend is plain HTML/CSS/JavaScript, with no framework or build step.

## Documentation

| Start here | Purpose |
| --- | --- |
| [Current project status](CURRENT_PROJECT_STATUS.md) | Dated production snapshot, storage closure and approved next work |
| [Agent instructions](AGENTS.md) | Mandatory reading and change/approval boundaries |
| [Architecture](docs/architecture.md) | Implemented components, APIs and reporting behavior |
| [Database](docs/database.md) | Tables, ownership, retention and effective SQL definitions |
| [Operations](docs/operations.md) | Configuration authority, jobs, health checks and approval gates |
| [Development](docs/development.md) | Local serving, validation and deployment limitations |
| [Product PRD](docs/product-prd.md) | Product intent, not a statement of delivered features |

Current guides distinguish **source-defined**, **observed**, **reported**,
**historical** and **unknown/unverified** information. For live state, use dated
evidence in the status document; source defaults are not hosted configuration.
Historical documents are indexed in [operations](docs/operations.md#historical-evidence).

## Working locally

Serve this directory using a static web server; see
[development](docs/development.md#local-frontend).
Local serving still reads the configured public Supabase APIs. It does not
create an isolated database or deploy changes.

Do not replay historical migrations or use database reset/push to discover state.
The live migration ledger was absent in the recorded catalog; reconstructed
baselines are local fixtures. Production writes, SQL changes, schedule changes,
deployments and paid-provider calls require explicit approval.
