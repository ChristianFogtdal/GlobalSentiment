-- Precomputed dashboard generations and refresh history.

create table public.dashboard_v2_cache (
    generation bigint generated always as identity primary key,
    payload jsonb not null,
    trend_by_topic jsonb not null default '{}'::jsonb,
    generated_at timestamptz not null default now()
);

create index dashboard_v2_cache_generated_at_idx
    on public.dashboard_v2_cache (generated_at desc);

alter table public.dashboard_v2_cache enable row level security;

revoke all on table public.dashboard_v2_cache from anon, authenticated;
grant all on table public.dashboard_v2_cache to service_role;
grant usage, select on sequence public.dashboard_v2_cache_generation_seq to service_role;

create table public.dashboard_v2_cache_refresh_log (
    id bigint generated always as identity primary key,
    started_at timestamptz not null,
    finished_at timestamptz not null,
    duration_ms bigint not null,
    success boolean not null,
    error_message text,
    source_row_count bigint,
    source_max_processed_at timestamptz,
    payload_bytes integer
);

create index dashboard_v2_cache_refresh_log_started_at_idx
    on public.dashboard_v2_cache_refresh_log (started_at desc);

alter table public.dashboard_v2_cache_refresh_log enable row level security;

revoke all on table public.dashboard_v2_cache_refresh_log from anon, authenticated;
grant all on table public.dashboard_v2_cache_refresh_log to service_role;
grant usage, select on sequence public.dashboard_v2_cache_refresh_log_id_seq to service_role;
