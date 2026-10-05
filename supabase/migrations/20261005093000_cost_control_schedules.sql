do $$
declare
    target record;
    cleanup_job bigint;
begin
    if not exists (select 1 from pg_extension where extname = 'pg_cron') then
        raise exception 'pg_cron is required; no schedules were changed';
    end if;
    for target in
        select * from (values
            ('ingest-bluesky-ai-coding-posts', '0 * * * *'),
            ('analyse-posts-ai-sentiment', '5-59/10 * * * *'),
            ('dashboard-v2-cache-refresh-safety-net', '58 * * * *'),
            ('reclaim-stuck-processing-analyses', '52 * * * *')
        ) desired(job_name, job_schedule)
    loop
        if exists (select 1 from cron.job where jobname = target.job_name) then
            perform cron.alter_job(jobid, schedule := target.job_schedule)
            from cron.job where jobname = target.job_name;
        else
            raise warning 'Missing job %; provision its approved command before enabling collection', target.job_name;
        end if;
    end loop;

    if not exists (select 1 from cron.job where jobname = 'sentiment-retention-cleanup') then
        cleanup_job := cron.schedule('sentiment-retention-cleanup', '48 * * * *',
            'select public.cleanup_sentiment_history(1000);');
        perform cron.alter_job(cleanup_job, active := false);
    end if;
end;
$$;

create or replace function public.disable_sentiment_retention()
returns void language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
    update public.app_settings set value = 'false', updated_at = now() where key = 'retention_enabled';
    perform cron.alter_job(jobid, active := false) from cron.job where jobname = 'sentiment-retention-cleanup';
end;
$$;
revoke all on function public.disable_sentiment_retention() from public, anon, authenticated;
grant execute on function public.disable_sentiment_retention() to service_role;