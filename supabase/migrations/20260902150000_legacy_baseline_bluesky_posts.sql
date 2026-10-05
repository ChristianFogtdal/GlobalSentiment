-- ============================================================================
-- Local test baseline: public.bluesky_posts
--
-- Unlike post_analyses / completed_post_analyses, no CREATE TABLE for
-- bluesky_posts exists in any tracked migration -- it predates version
-- control for this project and was created directly against the hosted
-- database. This migration reconstructs its structure from observed
-- usage across the codebase:
--   - supabase/functions/ingest-bluesky-search/index.ts (upserted columns)
--   - supabase/migrations/20260902090000_scheduled_bluesky_search.sql
--     (existing index / RLS statements referencing this table)
--   - supabase/migrations/20260902122000_add_original_language.sql
--     (original_language column added later)
--   - the completed_post_analyses view definition (post_text, author_handle,
--     original_language, published_at, source_url)
--
-- Corrected from user-provided live catalog results on 2026-10-05:
-- published_at and source_url are required; fetched_at defaults to now();
-- there is no created_at column. This file is for disposable local fixtures.
-- It must NEVER be replayed against the hosted/production project.
-- ============================================================================

create table if not exists public.bluesky_posts (
    uri text primary key,
    author_handle text not null,
    post_text text not null,
    published_at timestamptz not null,
    fetched_at timestamptz not null default now(),
    source_url text not null,
    -- Legacy rule-based scoring fields populated by ingest-bluesky-search's
    -- analysePost(); unrelated to the Foundry-based V2 pipeline.
    sentiment_score smallint,
    sentiment_label text,
    mood text,
    emotion text,
    topic text,
    rule_evidence text,
    original_language text,
    has_v2_analysis boolean not null default false,
    constraint bluesky_posts_sentiment_score_check check (sentiment_score >= 0 and sentiment_score <= 100)
);

create index if not exists bluesky_posts_published_at_idx
on public.bluesky_posts (published_at desc);

alter table public.bluesky_posts enable row level security;

revoke insert on table public.bluesky_posts from anon;
drop policy if exists "Anyone can insert unique Bluesky posts" on public.bluesky_posts;

drop policy if exists "Allow anon read bluesky_posts" on public.bluesky_posts;
create policy "Allow anon read bluesky_posts"
    on public.bluesky_posts
    for select
    to anon
    using (true);

drop policy if exists "bluesky_posts_service_role_full" on public.bluesky_posts;
create policy "bluesky_posts_service_role_full"
    on public.bluesky_posts
    for all
    to service_role
    using (true)
    with check (true);
