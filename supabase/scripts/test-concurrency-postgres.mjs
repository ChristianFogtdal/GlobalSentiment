import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const address = process.env.SAFETY_TEST_DATABASE_URL;
if (!address) throw new Error('Set SAFETY_TEST_DATABASE_URL to an empty local sentiment_safety_* PostgreSQL database');
const parsed = new URL(address);
if (!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname) || !parsed.pathname.startsWith('/sentiment_safety_')) {
  throw new Error('Refusing non-local or non-test database');
}
const require = createRequire(join(process.env.TEST_DEPS_PATH || join(tmpdir(),'sentimentmap-validation'),'package.json'));
const { Client } = require('pg');
const admin = new Client({ connectionString: address });
const first = new Client({ connectionString: address });
const second = new Client({ connectionString: address });
const clients = [first, second, admin];
const scalar = async (client, sql, params = []) => Object.values((await client.query(sql,params)).rows[0])[0];
const apply = async (name) => admin.query(await readFile(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8'));
try {
  await Promise.all([admin.connect(),first.connect(),second.connect()]);
  assert.equal(Number(await scalar(admin,"select count(*) from pg_class where relnamespace='public'::regnamespace and relkind in ('r','p','v','m')")), 0, 'Database must be empty');
  await admin.query("do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if; if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if; end $$");
  for (const name of [
    '20260902150000_legacy_baseline_bluesky_posts','20260902200000_legacy_baseline_post_analyses',
    '20260902210000_post_analyses_v2','20260904090000_active_prompt_version_contract',
    '20260910120000_post_analyses_content_type','20260914090000_dashboard_v2_cache_tables',
    '20260914100000_bluesky_posts_analysis_tracking','20260914210000_analyse_posts_invocation_log',
    '20261005090000_pipeline_cost_controls','20261005091000_retention_indexes',
    '20261005092000_retention_cleanup','20261005094000_recent_sentiment_reporting',
    '20261005100000_fenced_pipeline','20261005101000_safe_retention','20261005103000_utc_reporting',
  ]) await apply(name);
  const owner = randomUUID();
  const competitor = randomUUID();
  const fence = await scalar(first,"select public.acquire_pipeline_lease('analysis',600,$1)",[owner]);
  await first.query('begin; select pg_advisory_xact_lock(78123901)');
  await second.query("set lock_timeout='50ms'");
  await assert.rejects(second.query("select public.acquire_pipeline_lease('analysis',600,$1)",[competitor]), (error) => error.code === '55P03');
  await first.query('commit');
  await second.query("set lock_timeout='2s'");
  assert.equal(await scalar(second,"select public.acquire_pipeline_lease('analysis',600,$1)",[competitor]), null);
  await admin.query("insert into public.bluesky_posts(uri,author_handle,post_text,published_at,source_url) values('race-one','test','AI duplicated input',now(),'https://example.com/race-one'),('race-two','test','AI duplicated input',now(),'https://example.com/race-two')");
  const key = 'a'.repeat(64);
  const claim = (client,uri,token=owner,epoch=fence) => scalar(client,'select public.claim_post_analysis_fenced($1,public.get_active_prompt_version(),$2,$3,$4)',[uri,key,token,epoch]);
  const outcomes = await Promise.all([claim(first,'race-one'),claim(second,'race-two')]);
  assert.deepEqual([...outcomes].sort(), ['claimed','skipped']);
  const winner = outcomes[0] === 'claimed' ? 'race-one' : 'race-two';
  const loser = outcomes[0] === 'claimed' ? 'race-two' : 'race-one';
  await first.query('begin; select pg_advisory_xact_lock(78123901)');
  await admin.query("update public.app_settings set value='true' where key='retention_enabled'");
  await second.query("set statement_timeout='60s'; set lock_timeout='2s'");
  assert.equal((await scalar(second,'select public.cleanup_sentiment_history()')).status,'already_running');
  await first.query('rollback');
  await admin.query("update public.pipeline_run_state set lease_until=clock_timestamp()-interval '1 second',started_at=now()-interval '1 hour' where pipeline='analysis'");
  const nextFence = await scalar(second,"select public.acquire_pipeline_lease('analysis',600,$1)",[competitor]);
  assert(Number(nextFence)>Number(fence));
  assert.equal(await claim(second,winner,competitor,nextFence),'claimed');
  const result = { provider:'azure_foundry',deployment:'test',model:'test',sentiment:'neutral',sentiment_score:0,
    confidence:0.8,emotions:[],topics:[],tools_mentioned:[],rationale:'Test',ai_tooling_stance:'not_applicable',content_type:'organic',content_type_reason:'Test' };
  const finish = (client,token,epoch) => scalar(client,'select public.finish_post_analysis($1,public.get_active_prompt_version(),$2,$3,$4)',[winner,token,epoch,result]);
  assert.equal(await finish(first,owner,fence),0);
  assert.equal(await finish(second,competitor,nextFence),1);
  assert.equal(await claim(first,loser,competitor,nextFence),'cached');
  console.log('Real PostgreSQL races passed: lock contention, duplicate claims, retention exclusion, crash-expiry takeover, stale fencing, cached loser');

  const crashed = new Client({ connectionString: address });
  clients.push(crashed);
  crashed.on('error', () => {});
  await crashed.connect();
  const crashOwner = randomUUID();
  const crashFence = await scalar(crashed,"select public.acquire_pipeline_lease('bluesky_ingestion',3600,$1)",[crashOwner]);
  await crashed.query('begin; select pg_advisory_xact_lock(78123901)');
  const disconnected = new Promise((resolve) => crashed.once('end',resolve));
  await admin.query('select pg_terminate_backend($1)',[crashed.processID]);
  await disconnected;
  await second.query("begin; set local lock_timeout='50ms'; select pg_advisory_xact_lock(78123901); rollback");
  assert.equal(await scalar(second,"select public.acquire_pipeline_lease('bluesky_ingestion',3600,$1)",[competitor]),null);
  await admin.query("update public.pipeline_run_state set lease_until=clock_timestamp()-interval '1 second',started_at=now()-interval '2 hours' where pipeline='bluesky_ingestion'");
  const ingestionFence = await scalar(second,"select public.acquire_pipeline_lease('bluesky_ingestion',3600,$1)",[competitor]);
  assert(Number(ingestionFence)>Number(crashFence));
  await assert.rejects(second.query('select public.ingest_posts_fenced($1,$2,$3)',[crashOwner,crashFence,JSON.stringify([])]),/Worker lease lost/);
  assert.equal(await scalar(second,'select public.ingest_posts_fenced($1,$2,$3)',[competitor,ingestionFence,JSON.stringify([])]),0);
  console.log('Real process-loss recovery passed: backend terminated, transaction lock released, persistent lease respected, expiry takeover and stale ingestion denial');

  await admin.query("insert into public.bluesky_posts(uri,author_handle,post_text,published_at,source_url) values('timeout-preserve','test','Old raw data',now()-interval '721 hours','https://example.com/timeout-preserve')");
  await admin.query(`create function public.test_slow_audit_insert() returns trigger language plpgsql as $$
    begin perform sum(num) from generate_series(1,100000000) num; return new; end $$;
    create trigger test_slow_audit_insert before insert on public.retention_cleanup_log
    for each row execute function public.test_slow_audit_insert();`);
  await second.query("set statement_timeout='30ms'; set lock_timeout='2s'");
  const started = performance.now();
  await assert.rejects(second.query('select public.cleanup_sentiment_history()'), (error) => error.code === '57014');
  assert(performance.now()-started < 5000, 'Timeout must terminate the long-running cleanup');
  await second.query("set statement_timeout='60s'");
  assert.equal(Number(await scalar(admin,"select count(*) from public.bluesky_posts where uri='timeout-preserve'")),1);
  await admin.query('drop trigger test_slow_audit_insert on public.retention_cleanup_log; drop function public.test_slow_audit_insert()');
  const removed = await scalar(second,'select public.cleanup_sentiment_history()');
  assert(removed.bluesky_posts>=1);
  console.log('Real PostgreSQL timeout passed: SQLSTATE 57014, bounded runtime, full deletion rollback, successful retry');
} finally {
  await Promise.allSettled(clients.map((client) => client.end()));
}