# SentimentMap: Thought Process and Evolution

## Purpose of this overview

This document reconstructs the project's reasoning from the product requirements, implementation notes, migrations, and current code. It describes the decisions visible in those artifacts, rather than claiming access to undocumented intent.

## The founding idea: explain public mood

SentimentMap began as **Global Mood Intelligence**: a dashboard intended to answer three connected questions:

1. How are people feeling now?
2. What topics and emotions are associated with that mood?
3. Where and when is the mood changing?

The original PRD deliberately rejected a score-only sentiment dashboard. Its central product principle was "explain, do not only score": users should be able to move from an overall score into emotions, topics, geography, representative source material, and a qualified explanation. This makes the target users journalists, researchers, communications teams, event organisers, and curious observers who need evidence, not merely a classification.

The initial design expressed that idea through six layers: overall mood, emotion breakdown, hot topics, an AI explanation, mood-shift detection, and a country-level map. Shared filters and explicit confidence, sample-size, source, and limitation information were part of the product from the start. The responsible-AI position was also built in: analysis is aggregate, sources are public, uncertainty is visible, and detected associations are not presented as proof of causation.

## Evolution of the implementation

### 1. Dashboard-first prototype

The first practical step was a static, desktop-first dashboard backed by demo data. This made the intended experience concrete: an overall score, emotion and topic views, a generated summary, supporting signals, and drill-down controls. The prototype used deterministic keyword rules to classify posts in the browser. That was useful for demonstrating the product quickly, but it could not reliably interpret nuance, sarcasm, or varied language, and recalculated results on every view.

The prototype established an important design choice that remains: the dashboard should work from a structured analysis archive rather than asking users to inspect an unfiltered social stream.

### 2. Separate collection from presentation

The next step introduced Supabase as a persistent archive and Bluesky as the public data source. A scheduled ingestion function searches a fixed set of AI-related terms, retains the post's AT URI as its identity, and upserts records into `bluesky_posts`. This narrowed the operational focus from all global conversation to AI-related public conversation, including AI coding, products, research, safety, regulation, jobs, and social impact.

Deduplication, source links, publication times, and original-language tags were added because the project values verifiability and because repeated searches should not distort apparent conversation volume. The browser now reads the archive through Supabase rather than calling Bluesky directly, and the Data review view lets users inspect the underlying posts and analysis fields.

### 3. Move analysis off the browser

The project then moved toward persisted, server-side analysis. The architectural rationale was sound: provider credentials stay out of the browser, one result can be reused by all viewers, analysis has an audit trail, and validation can prevent malformed results from reaching the UI.

The legacy keyword pipeline remains available for comparison, but the current implementation uses the Foundry V2 path for its public dashboard:

- The live dashboard aggregates all completed rows from `post_analyses_v2` through server-side RPCs.
- The scheduled `ingest-bluesky-search` function currently assigns its legacy fields with deterministic keyword rules when it archives a post.
- Data Review can switch between legacy and V2 completed-analysis views.

This keeps the user-facing application archive-backed while retaining the legacy output for comparison and audit.

### 4. Add a guarded Azure Foundry proof slice

The newest implementation is an additive `analyse-posts` Edge Function and the isolated `post_analyses_v2` schema:

- It is scheduled for server-side invocation and is disabled unless `LLM_PROCESSING_ENABLED=enabled`.
- Each invocation sequentially analyzes up to the configured, capped batch size.
- A unique `(post_uri, prompt_version)` constraint is claimed before the billable provider call, preventing duplicate analysis for the same prompt version.
- Azure Foundry is asked for schema-constrained JSON containing sentiment, a $[-1, 1]$ score, emotions, topics, named AI tools, stance, confidence, and rationale.
- The response is validated in code and stored with provider, deployment, model, prompt version, status, and timestamps.
- The V2 base table remains service-role-only; its completed results are exposed through a narrow public review view and server-side dashboard aggregate RPCs.

This provides dashboard metrics from validated model output while preserving original-language metadata, provenance, and a fixed emotion taxonomy for audit and future evaluation.

## The decision logic behind the changes

| Concern | Early response | Current direction |
| --- | --- | --- |
| Explainability | Display a score with topics and emotions | Keep source evidence, rationale, confidence, and qualified summaries alongside aggregates |
| Speed of demonstration | Static data and keyword heuristics | Use server-side V2 aggregates while retaining legacy review data |
| Accuracy and nuance | Deterministic word matching | Use Azure Foundry structured output validated against a constrained contract |
| Trust and auditability | Immediate client-side calculation | Persist provenance, prompt version, model details, statuses, and source links server-side |
| Cost and operational risk | No external model calls | Sequential, uniquely claimed Foundry calls with a configured batch cap |
| Privacy and access control | Aggregate public-content framing | Keep model credentials and V2 base data server-only; expose only completed rows and aggregate data |

## Current product state

Today, SentimentMap is an **archive-backed AI-conversation dashboard using completed Azure Foundry V2 analyses for its public aggregates**.

The dashboard aggregates an overall AI-sentiment score, topics, emotions, and a topic-filtered hourly trend. Data Review provides server-side search, pagination, source switching, and per-row provenance. Dashboard and V2 Data Review include all completed prompt versions; each V2 review row identifies its own prompt version.

The original PRD remains broader than the deployed UI. The current interface does not implement the planned geographic map, country drill-down, automated mood-shift detection, or a model-generated explanation. Those are product goals, not present capabilities.

## What the next evolution should prove

The next milestone is strengthening the quality and operational controls around the V2 metrics:

1. Build a representative human-labelled evaluation set, including multilingual, ambiguous, sarcastic, and mixed-sentiment posts.
2. Measure the V2 output against agreed thresholds for sentiment, emotion, topic, stance, and confidence calibration.
3. Decide how a $[-1, 1]$ V2 sentiment score maps to the dashboard's $[0, 100]$ mood scale, and document that mapping as a stable methodology.
4. Define retention and retirement criteria for the legacy analysis path, including failure handling and reprocessing rules.
5. Evaluate future additions such as explanations, change detection, and geographic analysis against those controls.

This order protects the original promise of the project: useful, inspectable insight rather than confident-looking but unverified sentiment scores.

## Evidence used

- `global-mood-intelligence-prd.md`: product vision, six-layer scope, principles, responsible-AI constraints, and MVP.
- `index.html` and `app.js`: the current dashboard features and its dependency on V2 dashboard aggregate RPCs.
- `supabase/functions/ingest-bluesky-search/index.ts`: scheduled Bluesky collection and deterministic legacy enrichment.
- `supabase/functions/analyse-posts/index.ts` and its tests: the scheduled Azure Foundry V2 worker and response-contract tests.
- `supabase/migrations/20260902210000_post_analyses_v2.sql`: isolated V2 storage, access control, provenance, and uniqueness guarantees.
- `README.md`: current operational boundaries, dashboard scope, and V2 access rules.

Some older root-level implementation reports describe a previous integrated LLM architecture. They are useful historical evidence of intent, but current code and the latest SentimentMap README take precedence for the present-state description above.