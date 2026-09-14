-- Per-invocation telemetry for analyse-posts, added ahead of the planned
-- cron cadence increase (*/5 -> */2 minutes) so overlap between concurrent
-- invocations, real (not theoretical) throughput, and silent kills by the
-- edge runtime's IDLE_TIMEOUT (504) / WORKER_RESOURCE_LIMIT (546) can all be
-- measured directly instead of inferred.
--
-- Rows are inserted at the start of a scheduled batch invocation and updated
-- once runBatch() returns. If an invocation is killed mid-run (504/546), the
-- process is torn down before the update can execute, so finished_at stays
-- null forever - this is the "abandoned invocation" signal referenced below.
-- error_message therefore captures errors the function itself could catch
-- (Foundry/DB failures); it can never capture a 504/546, since those kill the
-- isolate before any code runs to record them. Abandonment is the proxy for
-- that case.
create table public.analyse_posts_invocation_log (
    id bigint generated always as identity primary key,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    batch_size integer not null,
    selected integer,
    completed integer,
    failed integer,
    error_message text
);

create index analyse_posts_invocation_log_started_at_idx
    on public.analyse_posts_invocation_log (started_at desc);

-- Supports the overlap ("concurrent invocation count") query pattern:
-- count invocations whose [started_at, finished_at] range intersects
-- another invocation's range.
create index analyse_posts_invocation_log_finished_at_idx
    on public.analyse_posts_invocation_log (finished_at);

alter table public.analyse_posts_invocation_log enable row level security;

revoke all on table public.analyse_posts_invocation_log from anon, authenticated;
grant all on table public.analyse_posts_invocation_log to service_role;
grant usage, select on sequence public.analyse_posts_invocation_log_id_seq to service_role;

-- Convenience view for the metrics requested alongside the cadence
-- experiment: invocation duration, completion rate, and whether an
-- invocation was ever "closed out" (abandoned = started but never finished,
-- and old enough that it is not just still in-flight).
--
-- overlapping_count: how many other invocations' [started_at, finished_at)
-- ranges intersected this one's - the direct concurrent-invocation signal.
-- In-flight (finished_at is null) invocations are treated as ongoing until
-- now() for overlap purposes, since we cannot know their true end time.
create or replace view public.analyse_posts_invocation_stats as
select
    l.id,
    l.started_at,
    l.finished_at,
    l.batch_size,
    l.selected,
    l.completed,
    l.failed,
    l.error_message,
    extract(epoch from (coalesce(l.finished_at, now()) - l.started_at)) as duration_seconds,
    (l.finished_at is null and l.started_at < now() - interval '3 minutes') as abandoned,
    case when l.selected > 0 then round(l.completed::numeric / l.selected, 4) end as completion_rate,
    (
        select count(*)
        from public.analyse_posts_invocation_log o
        where o.id <> l.id
          and o.started_at < coalesce(l.finished_at, now())
          and coalesce(o.finished_at, now()) > l.started_at
    ) as overlapping_count
from public.analyse_posts_invocation_log l;

revoke all on public.analyse_posts_invocation_stats from anon, authenticated;
grant select on public.analyse_posts_invocation_stats to service_role;
