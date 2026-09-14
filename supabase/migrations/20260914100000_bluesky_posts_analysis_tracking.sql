-- ============================================================================
-- Fix: select_unanalysed_posts() anti-join scan cost, confirmed via
-- EXPLAIN ANALYZE in production (2026-09-14):
--
--   Nested Loop Anti Join ... actual time=12903.422..12963.632 rows=500
--   Buffers: shared hit=384772
--
-- 86,218 of ~93K bluesky_posts rows were scanned (oldest-first) before 500
-- unanalysed candidates were found, because the backlog has drained: nearly
-- every old post already has a post_analyses_v2 row, and the anti-join has
-- no way to skip already-analysed rows without walking past them one by
-- one. This is exactly the failure mode
-- 20260906194500_prevent_cross_prompt_reanalysis.sql's own docstring
-- anticipated ("once the backlog is drained ... every run would page past
-- every analysed row"); it has now been reached in production and was
-- observed causing the analyse-posts Edge Function to hit its wall-clock
-- timeout (546) on every invocation, stalling the entire analysis pipeline.
--
-- Fix: track analysis status directly on bluesky_posts instead of deriving
-- it via a join every call. has_v2_analysis is set true exactly once, by an
-- AFTER INSERT trigger on post_analyses_v2 (fired the moment a post is
-- claimed via its unique-constraint insert with status='processing'), which
-- preserves select_unanalysed_posts()'s existing "eligibility is global to
-- any existing row regardless of status" semantics -- this is a performance
-- rewrite only, not a behavior change. A partial index on
-- (published_at) where has_v2_analysis = false then makes the lookup a
-- direct, bounded index scan over only the unanalysed rows rather than a
-- join that must visit every analysed row.
-- ============================================================================

alter table public.bluesky_posts
    add column if not exists has_v2_analysis boolean not null default false;

-- One-time backfill: mark every post that already has any post_analyses_v2
-- row (any status) as analysed, matching the existing global-eligibility
-- semantics exactly.
update public.bluesky_posts bp
set has_v2_analysis = true
where has_v2_analysis = false
  and exists (
      select 1 from public.post_analyses_v2 v2 where v2.post_uri = bp.uri
  );

create or replace function public.mark_bluesky_post_analysed()
returns trigger
language plpgsql
as $$
begin
    update public.bluesky_posts
    set has_v2_analysis = true
    where uri = new.post_uri
      and has_v2_analysis = false;
    return new;
end;
$$;

drop trigger if exists post_analyses_v2_mark_analysed on public.post_analyses_v2;
create trigger post_analyses_v2_mark_analysed
    after insert on public.post_analyses_v2
    for each row
    execute function public.mark_bluesky_post_analysed();

-- Partial index: only rows still needing analysis. As the analysed backlog
-- grows this index shrinks accordingly, so lookup cost stays proportional to
-- the remaining backlog, not to the total table size.
create index if not exists bluesky_posts_unanalysed_published_at_idx
    on public.bluesky_posts (published_at asc)
    where has_v2_analysis = false;

-- Same signature/behavior as before (p_prompt_version is still accepted but
-- unused -- eligibility remains global, not per-prompt-version), rewritten
-- to scan only unanalysed rows via the new partial index instead of
-- anti-joining against post_analyses_v2.
create or replace function public.select_unanalysed_posts(
    p_prompt_version text,
    p_limit integer
)
returns table (
    uri text,
    post_text text,
    original_language text
)
language sql
stable
as $$
    select bp.uri, bp.post_text, bp.original_language
    from public.bluesky_posts bp
    where bp.has_v2_analysis = false
    order by bp.published_at asc
    limit greatest(p_limit, 0)
$$;

revoke all on function public.select_unanalysed_posts(text, integer) from public;
revoke all on function public.select_unanalysed_posts(text, integer) from anon;
revoke all on function public.select_unanalysed_posts(text, integer) from authenticated;
grant execute on function public.select_unanalysed_posts(text, integer) to service_role;

-- Verify (should return in low milliseconds, not seconds):
--   explain (analyze, buffers) select * from public.select_unanalysed_posts('v4', 500);
--   select count(*) from public.bluesky_posts where has_v2_analysis = false;
--   -- Should equal the anti-join count from before this migration:
--   select count(*) from public.bluesky_posts bp
--     where not exists (select 1 from public.post_analyses_v2 v2 where v2.post_uri = bp.uri);
