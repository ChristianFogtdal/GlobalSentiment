do $$
declare target_id bigint;
begin
    if not exists(select 1 from pg_extension where extname='pg_cron') then raise exception 'pg_cron is required'; end if;
    select jobid into target_id from cron.job where jobname='sentiment-retention-cleanup';
    if target_id is null then raise exception 'Retention job is missing'; end if;
    perform cron.alter_job(target_id,active:=false,command:=
        'SET statement_timeout = ''60s''; SET lock_timeout = ''2s''; SET timezone = ''UTC''; SELECT public.cleanup_sentiment_history(1000);');
end;
$$;