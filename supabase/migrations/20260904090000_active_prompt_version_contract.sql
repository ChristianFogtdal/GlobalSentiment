-- ============================================================================
-- Authoritative active prompt version contract
--
-- Single source of truth for "which V2 prompt_version is currently active".
-- Both the analyse-posts worker and the dashboard resolve this same value at
-- runtime instead of each holding an independent, possibly-diverging
-- configuration value (previously: LLM_PROMPT_VERSION as a Supabase Edge
-- Function secret, with no equivalent on the dashboard side).
--
-- Design: a tiny single-row settings table (public.app_settings) plus a
-- SECURITY DEFINER read-only RPC (public.get_active_prompt_version()) that
-- returns just the text value. The table itself stays locked down (no
-- anon/authenticated access, not even SELECT) so that only the narrow RPC
-- surface is exposed; the RPC is safe to expose broadly since it returns a
-- single non-sensitive string.
--
-- Deployment order (see plan step 1):
--   1. Update the single row in public.app_settings deliberately.
--   2. Deploy compatible worker/dashboard code.
--   3. Verify both resolve the same version (get_active_prompt_version())
--      before enabling processing.
-- ============================================================================

create table if not exists public.app_settings (
    key text primary key,
    value text not null,
    updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;

-- No anon/authenticated access to the raw settings table; only the narrow
-- get_active_prompt_version() RPC below is exposed.
revoke all on public.app_settings from anon;
revoke all on public.app_settings from authenticated;

drop policy if exists "app_settings_service_role_full" on public.app_settings;
create policy "app_settings_service_role_full"
    on public.app_settings
    for all
    to service_role
    using (true)
    with check (true);

grant all on public.app_settings to service_role;

-- Seed the active prompt version if it does not already exist. Adjust the
-- value here (or via a follow-up UPDATE) whenever the active prompt version
-- changes; do not re-seed on every migration run.
insert into public.app_settings (key, value)
values ('active_prompt_version', 'v1')
on conflict (key) do nothing;

-- Read-only accessor for the single active prompt version value. Defined
-- SECURITY DEFINER so callers do not need direct table grants; the function
-- body only ever returns a single non-sensitive text value for a fixed key,
-- so widening its execute grant does not expose the rest of app_settings.
create or replace function public.get_active_prompt_version()
returns text
language sql
stable
security definer
set search_path = public
as $$
    select value from public.app_settings where key = 'active_prompt_version'
$$;

revoke all on function public.get_active_prompt_version() from public;
grant execute on function public.get_active_prompt_version() to anon;
grant execute on function public.get_active_prompt_version() to authenticated;
grant execute on function public.get_active_prompt_version() to service_role;

-- Verify:
--   select public.get_active_prompt_version();
