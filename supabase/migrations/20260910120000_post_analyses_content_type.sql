-- ============================================================================
-- Content-type classification: organic / promotional / spam
--
-- Adds a lightweight content_type + content_type_reason classification to
-- post_analyses_v2, produced by the same Foundry call as sentiment/topics
-- (see supabase/functions/analyse-posts/index.ts), so promotional/spam noise
-- can be excluded from dashboard analytics while every post remains stored.
--
-- Both columns are nullable with no default: historical rows analysed before
-- this change stay content_type = NULL. Dashboard aggregates treat NULL as
-- organic (coalesce(content_type, 'organic') = 'organic'), so no backfill or
-- reprocessing of the existing backlog is required or performed here.
--
-- The active prompt version is bumped to 'v4' (not 'v2') because the Foundry
-- response contract (required JSON fields) changed. 'v1' and 'v2' were
-- already-used prompt_version values with 29,955+ pre-existing rows under a
-- different, older prompt contract (predating this content_type change), so
-- reusing 'v2' here would have collided with unrelated historical data.
-- Note: select_unanalysed_posts()
-- (20260906194500_prevent_cross_prompt_reanalysis.sql) makes analysis
-- eligibility global per post_uri regardless of prompt_version, so this does
-- NOT retroactively re-analyse already-analysed posts; content_type only
-- populates for posts analysed for the first time from now on.
-- ============================================================================

alter table public.post_analyses_v2
    add column if not exists content_type text,
    add column if not exists content_type_reason text;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'post_analyses_v2_content_type_check'
    ) then
        alter table public.post_analyses_v2
            add constraint post_analyses_v2_content_type_check
            check (content_type is null or content_type in ('organic', 'promotional', 'spam'));
    end if;
end;
$$;

update public.app_settings
set value = 'v4', updated_at = now()
where key = 'active_prompt_version';

-- Data Review (completed_post_analyses_v2) keeps showing every row
-- regardless of content_type; it just gains the two new columns so a future
-- UI filter is possible without another migration.
--
-- Postgres requires CREATE OR REPLACE VIEW to keep existing columns in their
-- original position (renaming/reordering requires DROP + CREATE, which would
-- also drop the anon/authenticated grants); the two new columns are
-- therefore appended at the end of the SELECT list rather than placed next
-- to the related rationale/confidence columns.
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
    bp.source_url,
    v2.content_type,
    v2.content_type_reason
from public.post_analyses_v2 v2
join public.bluesky_posts bp on v2.post_uri = bp.uri
where v2.status = 'complete';

grant select on public.completed_post_analyses_v2 to anon;
grant select on public.completed_post_analyses_v2 to authenticated;

-- Verify:
--   select column_name from information_schema.columns where table_name = 'post_analyses_v2' and column_name like 'content_type%';
--   select value from public.app_settings where key = 'active_prompt_version'; -- expect 'v4'
--   select content_type, content_type_reason from public.completed_post_analyses_v2 limit 5;
