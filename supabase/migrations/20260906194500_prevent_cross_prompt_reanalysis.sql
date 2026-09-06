-- Keep prompt-version history for audit, but automatically analyze a post only
-- once. Changing the active prompt version must not restart the backlog.
--
-- The unused p_prompt_version parameter is retained for compatibility with the
-- deployed Edge Function RPC call; eligibility is intentionally global.
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
    )
    order by bp.published_at asc
    limit greatest(p_limit, 0)
$$;

revoke all on function public.select_unanalysed_posts(text, integer) from public;
revoke all on function public.select_unanalysed_posts(text, integer) from anon;
revoke all on function public.select_unanalysed_posts(text, integer) from authenticated;
grant execute on function public.select_unanalysed_posts(text, integer) to service_role;
