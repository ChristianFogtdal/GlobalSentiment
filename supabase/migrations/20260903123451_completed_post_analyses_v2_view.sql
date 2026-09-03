-- ============================================================================
-- Anon-readable V2 dashboard view: public.completed_post_analyses_v2
--
-- Purpose: allow the dashboard's "Data review" tab to optionally read real
-- Foundry-analyzed V2 results for manual validation, without granting any
-- access to the underlying post_analyses_v2 table (which remains
-- service_role only) or to post_analyses_v2_dev_validation.
--
-- This mirrors the exact join/where-clause pattern of the legacy
-- completed_post_analyses view (see
-- 20260902200000_legacy_baseline_post_analyses.sql), selecting from
-- post_analyses_v2 instead of post_analyses.
--
-- Scope/exclusions: only status = 'complete' rows are exposed (via the
-- WHERE clause). Internal/queue-only fields (status, error_message,
-- locked_until, retry_count, id) are intentionally excluded from the
-- exposed column list, even though the WHERE clause already limits rows to
-- 'complete'.
--
-- This migration is purely additive: it does not alter post_analyses_v2,
-- post_analyses_v2_dev_validation, or any legacy object. It does not grant
-- any additional privileges on the post_analyses_v2 base table itself.
-- ============================================================================

create or replace view public.completed_post_analyses_v2 as
select
    v2.post_uri,
    v2.sentiment,
    v2.sentiment_score,
    v2.emotions,
    v2.topics,
    v2.tools_mentioned,
    v2.ai_tooling_stance,
    v2.confidence,
    v2.rationale,
    v2.provider,
    v2.deployment,
    v2.model,
    v2.prompt_version,
    v2.created_at,
    v2.processed_at,
    bp.post_text,
    bp.author_handle,
    bp.original_language,
    bp.published_at,
    bp.source_url
from public.post_analyses_v2 v2
join public.bluesky_posts bp on v2.post_uri = bp.uri
where v2.status = 'complete';

grant select on public.completed_post_analyses_v2 to anon;
grant select on public.completed_post_analyses_v2 to authenticated;

-- Explicitly re-affirm the base table and dev-validation view remain
-- restricted to service_role only. No-op if already correct; guards
-- against this migration accidentally being interpreted as widening
-- access beyond the new view above.
revoke all on public.post_analyses_v2 from anon;
revoke all on public.post_analyses_v2 from authenticated;
revoke all on public.post_analyses_v2_dev_validation from anon;
revoke all on public.post_analyses_v2_dev_validation from authenticated;
