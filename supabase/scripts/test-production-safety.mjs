import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function testProductionSafety(db) {
  const sql = await readFile(new URL('../migrations/20261005100000_fenced_pipeline.sql', import.meta.url), 'utf8');
  await db.exec(sql);
  await db.exec(sql);
  const scalar = async (query, values = []) => Object.values((await db.query(query, values)).rows[0])[0];
  const owner = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  await db.exec("delete from public.pipeline_run_state where pipeline='analysis'");
  const fence = await scalar("select public.acquire_pipeline_lease('analysis',600,$1)", [owner]);
  assert.equal(Number(fence), 1);
  assert.equal(await scalar("select public.acquire_pipeline_lease('analysis',600,$1)", [other]), null);
  const key = 'f'.repeat(64);
  await db.exec("insert into public.bluesky_posts(uri,author_handle,post_text,published_at,source_url) values('safety-expired','test','AI safety test',now(),'https://example.com/safety-expired'),('safety-copy','test','AI safety test',now(),'https://example.com/safety-copy')");
  await db.query("insert into public.analysis_content_cache(cache_key,status,result,created_at) values($1,'complete','{}',now()-interval '721 hours')", [key]);
  const claim = (uri, token = owner, epoch = fence) => scalar('select public.claim_post_analysis_fenced($1,public.get_active_prompt_version(),$2,$3,$4)', [uri,key,token,epoch]);
  assert.equal(await claim('safety-expired'), 'claimed');
  assert.equal(await claim('safety-copy'), 'skipped');
  const result = {provider:'azure_foundry',deployment:'test',model:'test',sentiment:'neutral',sentiment_score:0,
    confidence:0.8,emotions:[],topics:[],tools_mentioned:[],ai_tooling_stance:'not_applicable',
    rationale:'Test',content_type:'organic',content_type_reason:'Test'};
  const finish = (uri, token = owner, epoch = fence) => scalar('select public.finish_post_analysis($1,public.get_active_prompt_version(),$2,$3,$4)', [uri,token,epoch,result]);
  assert.equal(await finish('safety-expired',other), 0);
  assert.equal(await finish('missing'), 0);
  assert.equal(await finish('safety-expired'), 1);
  assert.equal(await finish('safety-expired'), 0);
  assert.equal(await claim('safety-copy'), 'cached');
  await db.exec("update public.pipeline_run_state set lease_until=clock_timestamp()-interval '1 second',started_at=now()-interval '1 hour' where pipeline='analysis'");
  const newerFence = await scalar("select public.acquire_pipeline_lease('analysis',600,$1)", [other]);
  assert.equal(Number(newerFence), 2);
  assert.equal(await scalar("select public.renew_pipeline_lease('analysis',$1,$2)", [owner,fence]), false);
  assert.equal(await scalar("select public.release_pipeline_lease('analysis',$1,$2)", [owner,fence]), false);
  assert.equal(await finish('safety-copy'), 0);
  assert.equal(await scalar("select has_table_privilege('service_role','public.post_analyses_v2','update')"), false);
  await assert.rejects(db.exec("insert into public.post_analyses(post_uri,model,prompt_version) values('missing-parent','test','test')"), (error) => error.code === '23503');
  console.log('Safety regressions passed: repeat migration, exclusive admission, expired success is a miss, cache reuse, exact completion count, stale fencing, crash takeover, legacy FK, direct-write denial');
  const retention = await readFile(new URL('../migrations/20261005101000_safe_retention.sql', import.meta.url), 'utf8');
  await db.exec(retention);
  await db.exec(retention);
  await db.exec("update public.app_settings set value='true' where key='retention_enabled'");
  await assert.rejects(db.query('select public.cleanup_sentiment_history()'), /Set caller statement_timeout/);
  await db.exec("set statement_timeout='60s'; set lock_timeout='2s'; begin;");
  await db.exec(`insert into public.bluesky_posts(uri,author_handle,post_text,published_at,source_url) values
    ('owner-to-retain','test','AI running input',now(),'https://example.com/owner'),('copy-after-retention','test','AI running input',now(),'https://example.com/copy'),
    ('utc-boundary','test','AI cutoff input',now()-interval '720 hours','https://example.com/boundary');`);
  const liveKey = 'd'.repeat(64);
  const liveClaim = (uri) => scalar('select public.claim_post_analysis_fenced($1,public.get_active_prompt_version(),$2,$3,$4)', [uri,liveKey,other,newerFence]);
  assert.equal(await liveClaim('owner-to-retain'), 'claimed');
  await db.exec("update public.bluesky_posts set published_at=now()-interval '721 hours' where uri='owner-to-retain'");
  const auditBefore = await scalar('select count(*)::int from public.retention_cleanup_log');
  await scalar('select public.cleanup_sentiment_history()');
  assert.equal(await scalar("select count(*)::int from public.bluesky_posts where uri='owner-to-retain'"), 1);
  await db.exec("update public.pipeline_run_state set lease_until=clock_timestamp()-interval '1 second',started_at=now()-interval '1 hour' where pipeline='analysis'");
  await scalar('select public.cleanup_sentiment_history()');
  assert.equal(await scalar("select count(*)::int from public.bluesky_posts where uri='owner-to-retain'"), 0);
  assert.equal(await scalar("select owner_analysis_id from public.analysis_content_cache where cache_key=$1", [liveKey]), null);
  assert.equal(await scalar("select status from public.analysis_content_cache where cache_key=$1", [liveKey]), 'failed');
  const recoveredFence = await scalar("select public.acquire_pipeline_lease('analysis',600,$1)", [owner]);
  assert.equal(await scalar('select public.claim_post_analysis_fenced($1,public.get_active_prompt_version(),$2,$3,$4)', ['copy-after-retention',liveKey,owner,recoveredFence]), 'claimed');
  assert.equal(await scalar("select count(*)::int from public.bluesky_posts where uri='utc-boundary'"), 1);
  assert.equal(await scalar('select count(*)::int from public.retention_cleanup_log'), auditBefore + 2);
  for (const timezone of ['UTC','Australia/Sydney','America/New_York']) {
    await db.query("select set_config('TimeZone',$1,false)", [timezone]);
    for (const instant of ['2026-10-05T12:00:00+11:00','2026-04-06T12:00:00+10:00']) {
      assert.equal(Number(await scalar("select extract(epoch from($1::timestamptz-($1::timestamptz-interval '720 hours')))/3600", [instant])), 720);
    }
    await scalar('select public.cleanup_sentiment_history()');
    assert.equal(await scalar("select count(*)::int from public.bluesky_posts where uri='utc-boundary'"), 1);
  }
  await db.exec('create table public.protected_reference(id integer,post_uri text references public.bluesky_posts(uri) on delete cascade)');
  await db.exec('savepoint unsafe_reference');
  await assert.rejects(db.query('select public.cleanup_sentiment_history()'), /Unreviewed incoming foreign key/);
  await db.exec('rollback to savepoint unsafe_reference; drop table public.protected_reference; commit;');
  console.log('Retention safety regressions passed: caller timeout guard, live-owner preservation, FK ownership release, post-retention recovery, audit preservation, UTC/DST exact boundary, protected cascade refusal');
  const reporting = await readFile(new URL('../migrations/20261005103000_utc_reporting.sql', import.meta.url), 'utf8');
  await db.exec(reporting);
  await db.exec(reporting);
  await assert.rejects(db.exec("update public.bluesky_posts set published_at=null where uri='safety-copy'"), (error) => error.code === '23502');
  await db.exec("update public.bluesky_posts set fetched_at=now()-interval '721 hours' where uri='safety-copy'");
  assert.equal(await scalar("select count(*)::int from public.recent_sentiment_reporting where post_uri='safety-copy'"), 1);
  assert.equal(await scalar("select count(*)::int from public.completed_post_analyses_v2 where post_uri='safety-copy' and published_at>=now()-interval '720 hours'"), 1);
  await db.exec("insert into public.dashboard_v2_cache(generated_at,payload,trend_by_topic) values(now()-interval '90 days','{}','{\"Reliability\":[]}')");
  await assert.rejects(db.query('select public.get_dashboard_v2()'), /unavailable or stale/);
  await assert.rejects(db.query("select public.get_dashboard_v2_trend('Reliability')"), /unavailable or stale/);
  assert.equal((await scalar('select public.refresh_dashboard_v2_cache()')).status, 'refreshed');
  assert((await scalar('select public.get_dashboard_v2()')).totals.count > 0);
  console.log('Reporting regressions passed: required publication timestamp shared by review/dashboard, fetch age ignored, repeat migration, stale generation rejection, fresh-generation recovery');
  await db.exec("insert into public.bluesky_posts(uri,author_handle,post_text,published_at,source_url) values('expired-processing','test','AI stale processing',now(),'https://example.com/expired-processing'),('deleted-processing','test','AI deletion race',now(),'https://example.com/deleted-processing'),('changed-processing','test','AI replacement race',now(),'https://example.com/changed-processing'),('suppressed-processing','test','AI zero-row update',now(),'https://example.com/suppressed-processing')");
  const safetyClaim = (uri, cacheKey) => scalar('select public.claim_post_analysis_fenced($1,public.get_active_prompt_version(),$2,$3,$4)', [uri,cacheKey,owner,recoveredFence]);
  const safetyFinish = (uri) => scalar('select public.finish_post_analysis($1,public.get_active_prompt_version(),$2,$3,$4)', [uri,owner,recoveredFence,result]);
  const processingKey = '1'.repeat(64);
  await db.query("insert into public.analysis_content_cache(cache_key,status,created_at) values($1,'processing',now()-interval '721 hours')", [processingKey]);
  assert.equal(await safetyClaim('expired-processing',processingKey), 'claimed');
  assert.equal(await safetyFinish('expired-processing'), 1);
  assert.equal(await safetyClaim('deleted-processing','2'.repeat(64)), 'claimed');
  await db.exec("delete from public.post_analyses_v2 where post_uri='deleted-processing'");
  assert.equal(await safetyFinish('deleted-processing'), 0);
  assert.equal(await safetyClaim('changed-processing','3'.repeat(64)), 'claimed');
  await db.query("update public.post_analyses_v2 set worker_token=$1,worker_fence=999 where post_uri='changed-processing'", [other]);
  assert.equal(await safetyFinish('changed-processing'), 0);
  assert.equal(await safetyClaim('suppressed-processing','4'.repeat(64)), 'claimed');
  await db.exec(`create function public.test_suppress_completion() returns trigger language plpgsql as $$
    begin if new.post_uri='suppressed-processing' and new.status='complete' then return null; end if; return new; end $$;
    create trigger test_suppress_completion before update on public.post_analyses_v2 for each row execute function public.test_suppress_completion();`);
  await assert.rejects(safetyFinish('suppressed-processing'), /Analysis was not persisted/);
  assert.equal(await scalar("select status from public.post_analyses_v2 where post_uri='suppressed-processing'"), 'processing');
  assert.equal(await scalar("select status from public.analysis_content_cache where cache_key=$1", ['4'.repeat(64)]), 'processing');
  await db.exec('drop trigger test_suppress_completion on public.post_analyses_v2; drop function public.test_suppress_completion()');
  console.log('Adversarial completion regressions passed: expired processing is a miss, deleted row, replaced owner, suppressed UPDATE, atomic rollback of cache/result');
  await db.exec("insert into public.bluesky_posts(uri,author_handle,post_text,published_at,source_url) select 'head-copy-'||num,'test','AI orphaned ownership input',now()-num*interval '1 millisecond','https://example.com/head-copy-'||num from generate_series(1,10) num");
  const orphanKey = '6'.repeat(64);
  await db.query("insert into public.analysis_content_cache(cache_key,status,created_at) values($1,'processing',now()-interval '1 hour')", [orphanKey]);
  for (let index = 1; index <= 10; index += 1) {
    const uri = `head-copy-${index}`;
    assert.equal(await safetyClaim(uri,orphanKey),index === 1 ? 'claimed' : 'cached');
    if (index === 1) assert.equal(await safetyFinish(uri),1);
  }
  assert.equal(await scalar("select count(*)::int from public.select_unanalysed_posts(public.get_active_prompt_version(),20) where uri like 'head-copy-%'"),0);
  console.log('Original starvation reproduction passed: ten head-of-queue copies recover orphaned ownership and all complete without blocking selection');
  await db.exec("delete from public.pipeline_run_state where pipeline='bluesky_ingestion'");
  const ingestionFence = await scalar("select public.acquire_pipeline_lease('bluesky_ingestion',3600,$1)", [owner]);
  const incoming = [{ uri:'live-schema-ingestion',author_handle:'test',post_text:'AI ingestion uses database defaults',
    published_at:new Date().toISOString(),source_url:'https://example.com/ingestion',original_language:'en' }];
  assert.equal(await scalar('select public.ingest_posts_fenced($1,$2,$3)', [owner,ingestionFence,JSON.stringify(incoming)]), 1);
  assert.equal(await scalar("select fetched_at is not null and source_url='https://example.com/ingestion' from public.bluesky_posts where uri='live-schema-ingestion'"), true);
  assert.equal(await scalar('select public.ingest_posts_fenced($1,$2,$3)', [owner,ingestionFence,JSON.stringify(incoming)]), 0);
  console.log('Fenced ingestion live-schema regression passed: fetched_at omitted/defaulted, required source/publication supplied, duplicate insert ignored');
}