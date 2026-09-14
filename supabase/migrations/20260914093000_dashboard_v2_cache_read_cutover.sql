-- Seed generation 1 when migrations are applied in one ordered deployment.
-- Operators can still deploy the additive migrations separately, seed and
-- validate manually, then apply this cutover; an existing seed is preserved.

do $$
begin
    if not exists (select 1 from public.dashboard_v2_cache) then
        perform public.refresh_dashboard_v2_cache();
    end if;

    if not exists (select 1 from public.dashboard_v2_cache) then
        raise exception
            'dashboard_v2_cache could not be seeded; refusing dashboard read cutover';
    end if;
end;
$$;

create or replace function public.get_dashboard_v2()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select payload
    from public.dashboard_v2_cache
    where payload is not null
    order by generation desc
    limit 1;
$$;

revoke all on function public.get_dashboard_v2() from public;
grant execute on function public.get_dashboard_v2() to anon;
grant execute on function public.get_dashboard_v2() to authenticated;
grant execute on function public.get_dashboard_v2() to service_role;
