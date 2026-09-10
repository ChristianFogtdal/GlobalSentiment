# Plan: Content-type classification (organic/promotional/spam)

## Steps

### Phase 1: Schema (migrations, new file e.g. 20260910xxxxxx_post_analyses_content_type.sql)
1. ALTER TABLE public.post_analyses_v2 ADD COLUMN content_type text, ADD COLUMN content_type_reason text.
   - CHECK constraint: content_type in ('organic','promotional','spam') OR NULL.
   - content_type_reason: no hard DB length cap needed (app validates), but keep short.
2. Bump public.app_settings active_prompt_version value from 'v1' to 'v2' (update ... on conflict do update, same pattern as 20260904090000_active_prompt_version_contract.sql).
3. Update completed_post_analyses_v2 view (create or replace) to add v2.content_type, v2.content_type_reason to the exposed column list (Data Review keeps showing ALL rows, just gains the two new columns for future filtering - no WHERE change here).

### Phase 2: LLM prompt + validation (supabase/functions/analyse-posts/index.ts) - depends on Phase 1 column names being final
4. Add `export const ALLOWED_CONTENT_TYPES = ['organic', 'promotional', 'spam'] as const;` and a `MAX_CONTENT_TYPE_REASON_LENGTH` const (recommend 200).
5. Extend `RESPONSE_JSON_SCHEMA.schema.properties` with `content_type: { type: 'string', enum: ALLOWED_CONTENT_TYPES }` and `content_type_reason: { type: 'string', maxLength: MAX_CONTENT_TYPE_REASON_LENGTH }`; add both to `required`. The schema-level `maxLength` is the primary safeguard so the provider itself is constrained.
6. Extend `ValidatedAnalysis` interface + `validateAnalysisResponse()` to validate/parse content_type (enum check) and content_type_reason. For content_type_reason, do NOT reject-and-fail the whole analysis solely for exceeding length: safely truncate to MAX_CONTENT_TYPE_REASON_LENGTH (same defensive posture as bounded `error_message` truncation elsewhere in this function) rather than returning `{ ok: false }`; still reject if missing/empty/not a string. This ensures an overlong reason can never cause the entire post analysis to fail.
7. Extend `buildPrompt()` with a new classification section instructing the model to classify content_type using the user's category definitions:
   - organic: opinions, discussions, reactions, commentary, analysis, community conversation, news discussion.
   - promotional: product marketing, launch marketing, webinars, newsletters, conferences/events, recruiting/hiring, "sign up now" style content, company promotion.
   - spam: obvious engagement farming, repetitive content, automated low-quality posting, affiliate-link style content.
   - Require exactly one content_type value + a short content_type_reason (1 sentence).
   - Classification must be based on the post's primary intent, not mere presence of a company/product/model name: a post that discusses or evaluates an AI product/company (e.g. "Claude's new update is impressive") is organic commentary, not promotional, unless the post's actual purpose is to market/advertise/announce-with-a-call-to-action on behalf of that product/company.
   - When intent is genuinely ambiguous between organic and promotional/spam, default to organic - the classifier must not over-filter legitimate AI discussion just because it mentions a product, company, or model.
8. Update the `.update(...)` calls in `claimAndProcess`/`processClaimedPost` (writes to post_analyses_v2) to also persist `content_type` and `content_type_reason` from the validated response.
9. Update existing test mock payloads (index.test.ts, batchLoop.test.ts, candidateScan.test.ts, promptVersionResolution.test.ts, batchSize.test.ts) wherever a full valid LLM response object is constructed, to include content_type + content_type_reason, otherwise validateAnalysisResponse will start rejecting previously-valid fixtures.

### Phase 3: Dashboard exclusion (get_dashboard_v2 RPC) - depends on Phase 1
10. New migration: create or replace public.get_dashboard_v2() (and get_dashboard_v2_trend() if it also scopes `scoped`), copying the complete, latest function bodies verbatim from 20260906140000_dashboard_v2_include_all_prompt_versions.sql (including the statement-timeout fix from 20260906141500_dashboard_v2_fix_statement_timeout.sql if that touched these functions) and changing ONLY the `scoped` CTE's WHERE clause: add `and coalesce(v2.content_type, 'organic') = 'organic'` alongside the existing `where v2.status = 'complete'`. No other logic, column, or clause in these functions should be altered. This makes promotional/spam posts invisible to dashboard aggregates while historical NULL rows still count as organic (no data loss for old posts).

## Relevant files
- `supabase/functions/analyse-posts/index.ts` - ALLOWED_CONTENT_TYPES, RESPONSE_JSON_SCHEMA, buildPrompt(), validateAnalysisResponse(), ValidatedAnalysis, claimAndProcess/processClaimedPost update() calls
- `supabase/migrations/20260902210000_post_analyses_v2.sql` - reference for existing column/constraint style to mirror in new migration
- `supabase/migrations/20260904090000_active_prompt_version_contract.sql` - reference for app_settings upsert pattern
- `supabase/migrations/20260903123451_completed_post_analyses_v2_view.sql` - view to extend with new columns
- `supabase/migrations/20260906140000_dashboard_v2_include_all_prompt_versions.sql` - latest version of get_dashboard_v2()/get_dashboard_v2_trend() to replace with content_type filter
- `supabase/functions/analyse-posts/index.test.ts`, `batchLoop.test.ts`, `candidateScan.test.ts`, `batchSize.test.ts`, `promptVersionResolution.test.ts` - update mock LLM response fixtures

## Verification
1. `deno test` in supabase/functions/analyse-posts (or project's configured test command) - all suites green after fixture updates.
2. Manually invoke analyse-posts against sample post texts covering each intended bucket and confirm the returned content_type matches expectation:
   - organic opinion (e.g. "I think Claude's new update is genuinely impressive for coding tasks.") -> organic
   - neutral/factual announcement (e.g. "OpenAI released GPT-6 Astra today.") -> organic
   - product/launch marketing (e.g. "Introducing our new AI assistant - try it free today!") -> promotional
   - event/webinar promotion (e.g. "Join our free webinar on generative AI next Tuesday, register now.") -> promotional
   - recruiting/hiring (e.g. "We're hiring AI engineers - apply now!") -> promotional
   - engagement farming (e.g. "Like and reshare if you love AI!!! Follow for more!!!") -> spam
   - affiliate-link spam (e.g. repetitive post pushing an affiliate link with no commentary) -> spam
   - ambiguous post (e.g. mentions a product/company in passing without clear promotional or organic signal) -> organic (per the ambiguous-defaults-to-organic rule)
3. Query `select public.get_dashboard_v2()` before/after migration - totals.total_count should be unchanged except for the reduction attributable to rows that actually received a 'promotional' or 'spam' content_type; historical rows with content_type IS NULL remain included and continue to count exactly as before.
4. Query `select * from public.completed_post_analyses_v2 limit 5` - confirm content_type/content_type_reason columns present (null for legacy rows, populated for new v2-prompt rows).

## Decisions
- content_type/content_type_reason are nullable, no default - historical rows stay NULL.
- Dashboard treats NULL as 'organic' via coalesce - avoids hiding all historical data and avoids mandatory reprocessing cost.
- prompt_version bumped v1 -> v2 for audit/versioning consistency, but IMPORTANT: `select_unanalysed_posts()` (20260906194500_prevent_cross_prompt_reanalysis.sql) makes eligibility GLOBAL per post_uri regardless of prompt_version - bumping the version does NOT trigger re-analysis of the existing backlog. content_type will only populate going forward for newly-ingested, first-time-analyzed posts.
- No backfill of historical data in this pass (recommended default, matches "avoid overengineering"). Backfilling would require a separate explicit follow-up (e.g. a one-off admin action to reset selected post_analyses_v2 rows to allow re-claiming), deliberately out of scope here.
- Data Review/archive view stays unfiltered by content_type (shows everything) but exposes the new columns so a future UI filter is possible without another migration.

## Further Considerations
1. Backfill historical posts later? Recommend: no for now; revisit as a separate task if promotional noise in old data turns out to matter for historical trend charts.
2. Add a content_type filter/toggle in the Data Review tab UI (app.js) now or later? Recommend: later/optional - not required by current requirements, avoids scope creep this pass.

## Implementation status (2026-09-10): DONE, with one caveat
- Phase 1: `supabase/migrations/20260910120000_post_analyses_content_type.sql` - adds nullable content_type/content_type_reason + CHECK constraint, bumps active_prompt_version to 'v2', extends completed_post_analyses_v2 view with the two new columns (Data Review still shows every row, unfiltered).
- Phase 2: `supabase/functions/analyse-posts/index.ts` - ALLOWED_CONTENT_TYPES, MAX_CONTENT_TYPE_REASON_LENGTH, ValidatedAnalysis/validateAnalysisResponse (enum-checked content_type; content_type_reason truncated to 200 chars rather than failing on overlength), RESPONSE_JSON_SCHEMA (both fields required, schema-level maxLength as primary guard), buildPrompt() classification section (primary-intent rule, ambiguous-defaults-to-organic rule), processClaimedPost persistence. Test fixtures updated in index.test.ts (+ new content_type validation tests), batchLoop.test.ts, candidateScan.test.ts.
- Phase 3: `supabase/migrations/20260910121500_dashboard_v2_content_type_filter.sql` - get_dashboard_v2()/get_dashboard_v2_trend() recreated with full latest bodies (statement_timeout restored explicitly), only the `scoped` CTE WHERE clause changed to add `coalesce(v2.content_type,'organic')='organic'`.
- app.js: NOT modified. Confirmed the Data Review query (REVIEW_V2_SELECT, app.js line ~266) uses an explicit column list against completed_post_analyses_v2, unaffected by the new columns - Data Review continues to work exactly as before.
- CAVEAT: Deno is not installed in this environment, so `deno test` could not be executed to confirm the suite passes. Static analysis (get_errors) found no TypeScript errors, and all mock fixtures were manually updated to match the new required schema fields. Recommend running `deno test supabase/functions/analyse-posts/` in CI/locally before deploying.
- Not done (explicitly out of scope per this pass): historical backfill, Data Review content_type filter/toggle UI.

