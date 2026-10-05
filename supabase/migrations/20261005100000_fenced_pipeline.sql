alter table public.pipeline_run_state
    add column if not exists owner_token uuid,
    add column if not exists fence bigint not null default 0,
    add column if not exists lease_until timestamptz;
alter table public.post_analyses_v2
    add column if not exists worker_token uuid,
    add column if not exists worker_fence bigint;
alter table public.analysis_content_cache add column if not exists owner_analysis_id bigint;

update public.post_analyses_v2 pa set analysis_cache_key = null
where analysis_cache_key is not null and not exists (
    select 1 from public.analysis_content_cache cache where cache.cache_key = pa.analysis_cache_key
);
do $$
begin
    if not exists (select 1 from pg_constraint where conrelid = 'public.analysis_content_cache'::regclass and conname = 'analysis_cache_owner_fk') then
        alter table public.analysis_content_cache add constraint analysis_cache_owner_fk
            foreign key (owner_analysis_id) references public.post_analyses_v2(id) on delete set null;
    end if;
    if not exists (select 1 from pg_constraint where conrelid = 'public.post_analyses_v2'::regclass and conname = 'analysis_cache_key_fk') then
        alter table public.post_analyses_v2 add constraint analysis_cache_key_fk
            foreign key (analysis_cache_key) references public.analysis_content_cache(cache_key) on delete set null;
    end if;
    if not exists (select 1 from pg_constraint where conrelid = 'public.post_analyses'::regclass and conname = 'legacy_analysis_post_fk') then
        alter table public.post_analyses add constraint legacy_analysis_post_fk
            foreign key (post_uri) references public.bluesky_posts(uri) not valid;
    end if;
end;
$$;
create index if not exists analysis_cache_owner_idx on public.analysis_content_cache(owner_analysis_id);
create index if not exists analysis_cache_key_idx on public.post_analyses_v2(analysis_cache_key);

update public.post_analyses_v2 set status='pending',error_message=null,updated_at=now()
where status='failed' and error_message='Cached attempt failed; automatic retry disabled';

create or replace function public.pipeline_lease_valid(p_pipeline text, p_owner uuid, p_fence bigint)
returns boolean language sql volatile
set search_path = pg_catalog, public
as $$
    select exists (select 1 from public.pipeline_run_state where pipeline = p_pipeline
        and owner_token = p_owner and fence = p_fence and lease_until > clock_timestamp());
$$;

create or replace function public.acquire_pipeline_lease(p_pipeline text, p_interval_seconds integer, p_owner uuid)
returns bigint language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
    minimum_interval integer;
    acquired_fence bigint;
begin
    perform pg_advisory_xact_lock(78123901);
    minimum_interval := case p_pipeline when 'bluesky_ingestion' then 3600 when 'analysis' then 600 end;
    if p_owner is null or minimum_interval is null or p_interval_seconds is null
       or p_interval_seconds < minimum_interval or p_interval_seconds > 86400 then
        raise exception 'Invalid pipeline lease request';
    end if;
    insert into public.pipeline_run_state(pipeline, started_at, owner_token, fence, lease_until)
    values (p_pipeline, clock_timestamp(), p_owner, 1, clock_timestamp() + interval '180 seconds')
    on conflict (pipeline) do update set started_at = excluded.started_at, owner_token = excluded.owner_token,
        fence = pipeline_run_state.fence + 1, lease_until = excluded.lease_until
    where (pipeline_run_state.lease_until is null or pipeline_run_state.lease_until <= clock_timestamp())
      and pipeline_run_state.started_at < date_bin(make_interval(secs => p_interval_seconds), clock_timestamp(), '2000-01-01T00:00:00Z'::timestamptz)
    returning fence into acquired_fence;
    return acquired_fence;
end;
$$;

create or replace function public.renew_pipeline_lease(p_pipeline text, p_owner uuid, p_fence bigint)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare affected integer;
begin
    perform pg_advisory_xact_lock(78123901);
    update public.pipeline_run_state set lease_until = clock_timestamp() + interval '180 seconds'
    where pipeline = p_pipeline and owner_token = p_owner and fence = p_fence and lease_until > clock_timestamp();
    get diagnostics affected = row_count;
    return affected = 1;
end;
$$;

create or replace function public.release_pipeline_lease(p_pipeline text, p_owner uuid, p_fence bigint)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare affected integer;
begin
    perform pg_advisory_xact_lock(78123901);
    update public.pipeline_run_state set lease_until = null, owner_token = null
    where pipeline = p_pipeline and owner_token = p_owner and fence = p_fence;
    get diagnostics affected = row_count;
    return affected = 1;
end;
$$;

create or replace function public.release_deleted_cache_owner()
returns trigger language plpgsql
set search_path = pg_catalog, public
as $$
begin
    if new.owner_analysis_id is null and new.status = 'processing' then
        new.status := 'failed';
        new.result := null;
        new.error_message := 'Owner removed; cache miss is retryable';
        new.updated_at := clock_timestamp();
    end if;
    return new;
end;
$$;
drop trigger if exists analysis_cache_owner_removed on public.analysis_content_cache;
create trigger analysis_cache_owner_removed before update of owner_analysis_id on public.analysis_content_cache
for each row execute function public.release_deleted_cache_owner();
drop trigger if exists post_analyses_v2_persist_cache on public.post_analyses_v2;

create or replace function public.claim_post_analysis_fenced(
    p_post_uri text, p_prompt_version text, p_cache_key text, p_owner uuid, p_fence bigint,
    p_skip_reason text default null
)
returns text language plpgsql security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
    source public.bluesky_posts%rowtype;
    existing public.post_analyses_v2%rowtype;
    cached public.analysis_content_cache%rowtype;
    cached_result public.post_analyses_v2%rowtype;
    analysis_id bigint;
    affected integer;
begin
    perform pg_advisory_xact_lock(78123901);
    if not public.pipeline_lease_valid('analysis',p_owner,p_fence) then raise exception 'Worker lease lost'; end if;
    if p_prompt_version is distinct from public.get_active_prompt_version() then raise exception 'Active prompt version changed'; end if;
    select * into source from public.bluesky_posts where uri = p_post_uri for update;
     if not found or source.published_at < now()-interval '720 hours'
         or source.published_at > now() then return 'skipped'; end if;
    select * into existing from public.post_analyses_v2 where post_uri = p_post_uri
    order by (status = 'complete') desc, id desc limit 1 for update;
    if found and (existing.status in ('complete','failed') or
        (existing.status = 'processing' and public.pipeline_lease_valid('analysis',existing.worker_token,existing.worker_fence))) then
        return 'skipped';
    end if;
    if p_skip_reason is not null then
        if existing.id is null then
            insert into public.post_analyses_v2(post_uri,prompt_version,status,error_message)
            values(p_post_uri,p_prompt_version,'failed',left(p_skip_reason,500));
        else
            update public.post_analyses_v2 set status='failed',error_message=left(p_skip_reason,500),updated_at=now() where id=existing.id;
        end if;
        return 'filtered';
    end if;
    if p_cache_key is null or p_cache_key !~ '^[0-9a-f]{64}$' then raise exception 'Invalid content key'; end if;
    select * into cached from public.analysis_content_cache where cache_key=p_cache_key for update;
    if found and cached.status='processing' and exists (
        select 1 from public.post_analyses_v2 owner where owner.id=cached.owner_analysis_id
        and owner.status='processing' and public.pipeline_lease_valid('analysis',owner.worker_token,owner.worker_fence)
    ) then return 'skipped'; end if;

    if existing.id is null then
        insert into public.post_analyses_v2(post_uri,prompt_version,status,worker_token,worker_fence)
        values(p_post_uri,p_prompt_version,'processing',p_owner,p_fence) returning id into analysis_id;
    else
        analysis_id := existing.id;
        update public.post_analyses_v2 set prompt_version=p_prompt_version,status='processing',worker_token=p_owner,
            worker_fence=p_fence,error_message=null,updated_at=now(),analysis_cache_key=null where id=analysis_id;
    end if;

    if cached.status='complete' and cached.created_at >= now()-interval '720 hours' then
        select * into cached_result from jsonb_populate_record(null::public.post_analyses_v2,cached.result);
        update public.post_analyses_v2 set status='complete',provider=cached_result.provider,
            deployment=cached_result.deployment,model=cached_result.model,sentiment=cached_result.sentiment,
            sentiment_score=cached_result.sentiment_score,emotions=cached_result.emotions,topics=cached_result.topics,
            tools_mentioned=cached_result.tools_mentioned,ai_tooling_stance=cached_result.ai_tooling_stance,
            confidence=cached_result.confidence,rationale=cached_result.rationale,content_type=cached_result.content_type,
            content_type_reason=cached_result.content_type_reason,processed_at=now(),updated_at=now(),analysis_cache_key=p_cache_key
        where id=analysis_id and status='processing' and worker_token=p_owner and worker_fence=p_fence;
        get diagnostics affected=row_count;
        if affected <> 1 then raise exception 'Cached result was not persisted'; end if;
        return 'cached';
    end if;

    if cached.owner_analysis_id is not null and cached.owner_analysis_id <> analysis_id then
        update public.post_analyses_v2 set status='pending',worker_token=null,worker_fence=null,updated_at=now()
        where id=cached.owner_analysis_id and status='processing';
    end if;
    insert into public.analysis_content_cache(cache_key,status,owner_analysis_id,created_at,updated_at)
    values(p_cache_key,'processing',analysis_id,now(),now())
    on conflict(cache_key) do update set status='processing',owner_analysis_id=excluded.owner_analysis_id,
        result=null,error_message=null,created_at=excluded.created_at,updated_at=excluded.updated_at;
    update public.post_analyses_v2 set analysis_cache_key=p_cache_key where id=analysis_id;
    return 'claimed';
end;
$$;

create or replace function public.finish_post_analysis(
    p_post_uri text,p_prompt_version text,p_owner uuid,p_fence bigint,p_result jsonb,p_error text default null
)
returns integer language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
    target public.post_analyses_v2%rowtype;
    validated public.post_analyses_v2%rowtype;
    affected integer;
begin
    perform pg_advisory_xact_lock(78123901);
    if not public.pipeline_lease_valid('analysis',p_owner,p_fence) then return 0; end if;
    select * into target from public.post_analyses_v2 where post_uri=p_post_uri and prompt_version=p_prompt_version
        and status='processing' and worker_token=p_owner and worker_fence=p_fence for update;
    if not found then return 0; end if;
    if not exists(select 1 from public.analysis_content_cache where cache_key=target.analysis_cache_key
        and owner_analysis_id=target.id and status='processing') then return 0; end if;
    if p_error is null then
        if p_result is null or jsonb_typeof(p_result) <> 'object' then raise exception 'Missing analysis result'; end if;
        select * into validated from jsonb_populate_record(null::public.post_analyses_v2,p_result);
        update public.post_analyses_v2 set status='complete',provider=validated.provider,deployment=validated.deployment,
            model=validated.model,sentiment=validated.sentiment,sentiment_score=validated.sentiment_score,
            emotions=validated.emotions,topics=validated.topics,tools_mentioned=validated.tools_mentioned,
            ai_tooling_stance=validated.ai_tooling_stance,confidence=validated.confidence,rationale=validated.rationale,
            content_type=validated.content_type,content_type_reason=validated.content_type_reason,
            error_message=null,processed_at=now(),updated_at=now() where id=target.id and status='processing';
    else
        update public.post_analyses_v2 set status='failed',error_message=left(p_error,500),updated_at=now()
        where id=target.id and status='processing';
    end if;
    get diagnostics affected=row_count;
    if affected <> 1 then raise exception 'Analysis was not persisted'; end if;
    update public.analysis_content_cache set status=case when p_error is null then 'complete' else 'failed' end,
        result=case when p_error is null then p_result else null end,error_message=left(p_error,500),updated_at=now()
    where cache_key=target.analysis_cache_key and owner_analysis_id=target.id and status='processing';
    get diagnostics affected=row_count;
    if affected <> 1 then raise exception 'Cache result was not persisted'; end if;
    return 1;
end;
$$;

create or replace function public.ingest_posts_fenced(p_owner uuid,p_fence bigint,p_rows jsonb)
returns integer language plpgsql security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare affected integer;
begin
    perform pg_advisory_xact_lock(78123901);
    if not public.pipeline_lease_valid('bluesky_ingestion',p_owner,p_fence) then raise exception 'Worker lease lost'; end if;
    if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows)>100 then raise exception 'Invalid ingestion batch'; end if;
    insert into public.bluesky_posts(uri,author_handle,post_text,original_language,published_at,source_url)
    select uri,author_handle,post_text,original_language,published_at,source_url
    from jsonb_populate_recordset(null::public.bluesky_posts,p_rows)
    where published_at>=now()-interval '720 hours' and published_at<=clock_timestamp()
    on conflict(uri) do nothing;
    get diagnostics affected=row_count;
    return affected;
end;
$$;

create or replace function public.select_unanalysed_posts(p_prompt_version text,p_limit integer)
returns table(uri text,post_text text,original_language text) language sql stable
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
    select bp.uri,bp.post_text,bp.original_language from public.bluesky_posts bp
        where bp.published_at>=now()-interval '720 hours'
            and bp.published_at<=now()
      and not exists(select 1 from public.post_analyses_v2 pa where pa.post_uri=bp.uri and
        (pa.status in ('complete','failed') or (pa.status='processing' and
          public.pipeline_lease_valid('analysis',pa.worker_token,pa.worker_fence))))
    order by bp.published_at desc,bp.uri limit least(greatest(p_limit,0),20);
$$;

create or replace function public.reclaim_stuck_processing_analyses(p_stuck_after interval default interval '10 minutes')
returns integer language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare affected integer;
begin
    perform pg_advisory_xact_lock(78123901);
    if p_stuck_after is null or p_stuck_after<interval '10 minutes' then raise exception 'Invalid recovery threshold'; end if;
    update public.post_analyses_v2 set status='pending',worker_token=null,worker_fence=null,updated_at=now()
    where id in(select id from public.post_analyses_v2 pa where status='processing'
      and not public.pipeline_lease_valid('analysis',pa.worker_token,pa.worker_fence)
      and updated_at<now()-p_stuck_after order by updated_at limit 1000);
    get diagnostics affected=row_count;
    return affected;
end;
$$;

revoke insert,update,delete,truncate on public.bluesky_posts,public.post_analyses_v2,
    public.analysis_content_cache,public.pipeline_run_state from public,anon,authenticated,service_role;
revoke all on function public.begin_pipeline_run(text,integer) from service_role;
revoke all on function public.claim_post_analysis(text,text,text,text) from service_role;
revoke all on function public.pipeline_lease_valid(text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.pipeline_lease_valid(text,uuid,bigint) to service_role;
revoke all on function public.release_deleted_cache_owner() from public,anon,authenticated;
revoke all on function public.acquire_pipeline_lease(text,integer,uuid) from public,anon,authenticated;
revoke all on function public.renew_pipeline_lease(text,uuid,bigint) from public,anon,authenticated;
revoke all on function public.release_pipeline_lease(text,uuid,bigint) from public,anon,authenticated;
revoke all on function public.claim_post_analysis_fenced(text,text,text,uuid,bigint,text) from public,anon,authenticated;
revoke all on function public.finish_post_analysis(text,text,uuid,bigint,jsonb,text) from public,anon,authenticated;
revoke all on function public.ingest_posts_fenced(uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.acquire_pipeline_lease(text,integer,uuid),public.renew_pipeline_lease(text,uuid,bigint),
    public.release_pipeline_lease(text,uuid,bigint),public.claim_post_analysis_fenced(text,text,text,uuid,bigint,text),
    public.finish_post_analysis(text,text,uuid,bigint,jsonb,text),public.ingest_posts_fenced(uuid,bigint,jsonb) to service_role;