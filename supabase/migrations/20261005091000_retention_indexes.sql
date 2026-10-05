create index if not exists bluesky_posts_retention_at_idx
    on public.bluesky_posts (published_at);
create index if not exists bluesky_posts_recent_unanalysed_idx
    on public.bluesky_posts (published_at desc, uri)
    where has_v2_analysis = false;
create index if not exists analysis_content_cache_created_at_idx
    on public.analysis_content_cache (created_at);
create index if not exists post_analyses_v2_processing_updated_idx
    on public.post_analyses_v2 (updated_at) where status = 'processing';
create index if not exists analyse_posts_invocation_log_started_at_idx
    on public.analyse_posts_invocation_log (started_at desc);
create index if not exists dashboard_v2_cache_refresh_log_started_at_idx
    on public.dashboard_v2_cache_refresh_log (started_at desc);