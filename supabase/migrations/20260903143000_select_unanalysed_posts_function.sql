-- ============================================================================
-- Adds public.select_unanalysed_posts(): server-side selection of the oldest
-- posts that have no post_analyses_v2 row for a given prompt version.
--
-- Problem this replaces: analyse-posts previously paged through
-- bluesky_posts from offset 0 on every invocation, skipping already-analysed
-- rows client-side. That approach has two defects:
--
--   1. It was bounded by MAX_CANDIDATE_SCAN (5000) to keep a single
--      invocation from walking the whole table. Once the oldest 5000 posts
--      were analysed, every run would scan 5000 analysed rows, hit the bound,
--      and select nothing -- silently stalling the pipeline exactly as the
--      original 50-row head window did.
--   2. Even unbounded, the work per invocation grows with the table: once the
--      backlog is drained the only unanalysed posts are the newest, so every
--      run would page past every analysed row to reach them.
--
-- Filtering in the database instead makes selection O(batch) rather than
-- O(table): the anti-join below uses the existing
-- post_analyses_v2_post_uri_idx and bluesky_posts_published_at_idx, returns
-- only rows that still need work, and needs no scan bound at all.
--
-- Security: defined as SECURITY INVOKER (the default) and granted only to
-- service_role, matching the existing restriction on post_analyses_v2. This
-- exposes no data to anon/authenticated.
-- ============================================================================

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
    where not exists (
        select 1
        from public.post_analyses_v2 v2
        where v2.post_uri = bp.uri
          and v2.prompt_version = p_prompt_version
    )
    order by bp.published_at asc
    limit greatest(p_limit, 0)
$$;

-- Supports the anti-join lookup on (post_uri, prompt_version). The existing
-- unique constraint already covers this pair, but that constraint's index is
-- what the planner uses here, so no additional index is required.

revoke all on function public.select_unanalysed_posts(text, integer) from public;
revoke all on function public.select_unanalysed_posts(text, integer) from anon;
revoke all on function public.select_unanalysed_posts(text, integer) from authenticated;
grant execute on function public.select_unanalysed_posts(text, integer) to service_role;

-- Verify (expects the count of posts still awaiting analysis, oldest first):
--   select count(*) from public.select_unanalysed_posts('<prompt version>', 1000000);
