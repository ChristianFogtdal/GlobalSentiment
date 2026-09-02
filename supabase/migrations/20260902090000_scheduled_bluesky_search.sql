revoke insert on table public.bluesky_posts from anon;
drop policy if exists "Anyone can insert unique Bluesky posts" on public.bluesky_posts;

create index if not exists bluesky_posts_published_at_idx
on public.bluesky_posts (published_at desc);
