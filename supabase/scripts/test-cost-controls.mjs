import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { testProductionSafety } from './test-production-safety.mjs';

const require = createRequire(join(process.env.TEST_DEPS_PATH || join(tmpdir(), 'sentimentmap-validation'), 'package.json'));
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite();
const migration = async (name) => db.exec(await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8'));
const scalar = async (sql) => Object.values((await db.query(sql)).rows[0])[0];

try {
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  for (const name of [
    '20260902150000_legacy_baseline_bluesky_posts',
    '20260902200000_legacy_baseline_post_analyses',
    '20260902210000_post_analyses_v2',
    '20260903090000_grant_service_role_bluesky_posts',
    '20260904090000_active_prompt_version_contract',
    '20260910120000_post_analyses_content_type',
    '20260914090000_dashboard_v2_cache_tables',
    '20260914100000_bluesky_posts_analysis_tracking',
    '20260914210000_analyse_posts_invocation_log',
  ]) await migration(name);
  await migration('20261005090000_pipeline_cost_controls');
  await migration('20261005090000_pipeline_cost_controls');
  assert.equal(await scalar("select public.begin_pipeline_run('bluesky_ingestion',3600)"), true);
  assert.equal(await scalar("select public.begin_pipeline_run('bluesky_ingestion',3600)"), false);
  await db.exec("update public.pipeline_run_state set started_at=date_trunc('hour',now())-interval '5 minutes' where pipeline='bluesky_ingestion'");
  assert.equal(await scalar("select public.begin_pipeline_run('bluesky_ingestion',3600)"), true);
  const version = await scalar('select public.get_active_prompt_version()');
  await db.exec(`insert into public.bluesky_posts(uri,author_handle,post_text,published_at,source_url) values
    ('first','tester','AI is useful',now(),'https://example.com/first'), ('copy','tester','AI is useful',now(),'https://example.com/copy'),
    ('old','tester','Old AI opinion',now()-interval '31 days','https://example.com/old');`);
  assert.equal(await scalar("select count(*)::int from information_schema.columns where table_schema='public' and table_name='bluesky_posts' and column_name='created_at'"), 0);
  assert.equal(await scalar("select fetched_at is not null from public.bluesky_posts where uri='first'"), true);
  await assert.rejects(db.exec("insert into public.bluesky_posts(uri,author_handle,post_text,published_at,source_url) values('no-date','tester','AI missing date',null,'https://example.com/no-date')"), (error) => error.code === '23502');
  await assert.rejects(db.exec("insert into public.bluesky_posts(uri,author_handle,post_text,published_at) values('no-url','tester','AI missing source',now())"), (error) => error.code === '23502');
  const claim = (uri, key = 'a'.repeat(64)) => db.query(
    'select public.claim_post_analysis($1,$2,$3)', [uri, version, key],
  ).then((result) => result.rows[0].claim_post_analysis);
  assert.equal(await claim('old'), 'skipped');
  assert.equal(await claim('first'), 'claimed');
  assert.equal(await claim('first'), 'skipped');
  assert.equal(await claim('copy'), 'skipped');
  await db.exec(`update public.post_analyses_v2 set status='complete', provider='azure_foundry',
    deployment='test',model='test',sentiment='positive',sentiment_score=0.5,
    confidence=0.8,content_type='organic',processed_at=now() where post_uri='first';`);
  assert.equal(await claim('copy'), 'cached');
  assert.equal(await scalar("select sentiment_score::float8 from public.post_analyses_v2 where post_uri='copy'"), 0.5);
  assert.equal(await scalar("select count(*)::int from public.analysis_content_cache"), 1);
  assert.equal(await scalar("select has_function_privilege('anon','public.claim_post_analysis(text,text,text,text)','execute')"), false);
  await db.exec("insert into public.bluesky_posts(uri,author_handle,post_text,published_at,source_url) values ('first','other','Changed duplicate',now(),'https://example.com/first') on conflict(uri) do nothing");
  assert.equal(await scalar("select post_text from public.bluesky_posts where uri='first'"), 'AI is useful');
  await assert.rejects(db.query("insert into public.post_analyses_v2(post_uri,prompt_version) values ('first',$1)", [version]), (error) => error.code === '23505');
  await db.exec(`insert into public.bluesky_posts(uri,author_handle,post_text,published_at,source_url) values
    ('abandoned','tester','AI abandoned opinion',now(),'https://example.com/abandoned'),('failed-copy','tester','AI abandoned opinion',now(),'https://example.com/failed-copy');`);
  assert.equal(await claim('abandoned', 'e'.repeat(64)), 'claimed');
  await db.exec("update public.post_analyses_v2 set updated_at=now()-interval '11 minutes' where post_uri='abandoned'");
  assert.equal(await scalar('select public.reclaim_stuck_processing_analyses()'), 1);
  assert.equal(await scalar('select public.reclaim_stuck_processing_analyses()'), 0);
  assert.equal(await claim('abandoned', 'e'.repeat(64)), 'skipped');
  assert.equal(await claim('failed-copy', 'e'.repeat(64)), 'filtered');
  assert.equal(await scalar("select status from public.analysis_content_cache where cache_key=repeat('e',64)"), 'failed');
  console.log('PostgreSQL checks passed: repeat migration, run admission, expiry, unique claims, in-flight cache exclusion, result reuse, grants');
  for (const name of ['20261005091000_retention_indexes', '20261005092000_retention_cleanup']) {
    await migration(name);
    await migration(name);
  }
  assert.equal((await scalar('select public.cleanup_sentiment_history()')).status, 'disabled');
  await db.exec('begin');
  await db.exec(`
    update public.app_settings set value='true' where key='retention_enabled';
    insert into public.bluesky_posts(uri,author_handle,post_text,published_at,fetched_at,source_url) values
      ('boundary','tester','AI boundary opinion',now()-interval '30 days',now(),'https://example.com/boundary'),
      ('expired','tester','AI expired opinion',now()-interval '30 days 1 millisecond',now(),'https://example.com/expired'),
      ('recent-old-fetch','tester','AI recent opinion',now(),now()-interval '31 days','https://example.com/recent'),
      ('expired-new-fetch','tester','AI old opinion',now()-interval '31 days',now(),'https://example.com/expired-fetch');
    insert into public.post_analyses_v2(post_uri,prompt_version,status) values
      ('boundary','v1','failed'),('expired','v1','failed'),('expired','v2','failed');
    insert into public.post_analyses(post_uri,model,prompt_version,created_at) values
      ('boundary','mock','v1',now()-interval '60 days'),('expired','mock','v1',now()),
      ('orphan','mock','v1',now()-interval '31 days');
    insert into public.dashboard_v2_cache(payload,generated_at) values ('{"protected":true}',now()-interval '60 days');
    insert into public.analyse_posts_invocation_log(started_at,batch_size) values
      (now()-interval '31 days',5),(now()-interval '30 days',5);
    insert into public.dashboard_v2_cache_refresh_log(started_at,finished_at,duration_ms,success) values
      (now()-interval '31 days',now(),1,true),(now()-interval '30 days',now(),1,true);
    insert into public.retention_cleanup_log(started_at,cutoff,removed) values
      (now()-interval '31 days',now(),'{}');
    insert into public.analysis_content_cache(cache_key,status,created_at) values
      (repeat('b',64),'failed',now()-interval '31 days'),
      (repeat('c',64),'failed',now()-interval '30 days');
  `);
  const settingsBefore = await db.query('select * from public.app_settings order by key');
  const preview = (await db.query('select * from public.preview_sentiment_retention()')).rows;
  assert.equal(Number(preview.find((row) => row.table_name === 'bluesky_posts').rows_to_delete), 3);
  assert.equal(Number(preview.find((row) => row.table_name === 'post_analyses_v2').rows_to_delete), 2);
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const removed = await scalar('select public.cleanup_sentiment_history(1)');
    assert(Object.entries(removed).every(([table, count]) => count <= (table === 'post_analyses' ? 2 : 1)));
  }
  assert.equal(await scalar("select count(*)::int from public.bluesky_posts where uri in ('boundary','recent-old-fetch','first','copy')"), 4);
  assert.equal(await scalar("select count(*)::int from public.bluesky_posts where uri in ('expired','old','expired-new-fetch')"), 0);
  assert.equal(await scalar("select count(*)::int from public.post_analyses where post_uri='boundary'"), 1);
  assert.equal(await scalar("select count(*)::int from public.post_analyses_v2 where post_uri='boundary'"), 1);
  assert.equal(await scalar('select count(*)::int from public.analyse_posts_invocation_log'), 2);
  assert.equal(await scalar('select count(*)::int from public.dashboard_v2_cache_refresh_log'), 2);
  assert.equal(await scalar("select count(*)::int from public.retention_cleanup_log where started_at < now()-interval '30 days'"), 1);
  assert.equal(await scalar("select count(*)::int from public.analysis_content_cache where cache_key=repeat('c',64)"), 1);
  assert.equal(await scalar('select count(*)::int from public.dashboard_v2_cache'), 1);
  assert.deepEqual((await db.query('select * from public.app_settings order by key')).rows, settingsBefore.rows);
  const final = await scalar('select public.cleanup_sentiment_history(1)');
  assert(Object.values(final).every((count) => count === 0));
  assert.equal(await scalar("select has_function_privilege('anon','public.cleanup_sentiment_history(integer)','execute')"), false);
  await db.exec('commit');
  console.log('Retention checks passed: live raw schema, required dates/source, fetched_at default, publication cutoff independent of fetch time, bounded deletion, audit preservation, retry safety');
  await migration('20261005094000_recent_sentiment_reporting');
  await migration('20261005094000_recent_sentiment_reporting');
  await db.exec(`insert into public.bluesky_posts(uri,author_handle,post_text,published_at,source_url) values
    ('expired-report','tester','Old opinion',now()-interval '31 days','https://example.com/expired-report');
    insert into public.post_analyses_v2(post_uri,prompt_version,status,provider,deployment,model,sentiment_score)
    values ('expired-report','v1','complete','test','test','test',-1);`);
  const aggregate = await scalar('select public.compute_dashboard_v2_aggregate()');
  assert.equal(aggregate.totals.count, 2);
  assert.equal(aggregate.totals.avg_score, 75);
  assert.equal(aggregate.recent.length, 2);
  assert.equal(aggregate.trend[0].score, null);
  assert.equal(aggregate.trend[0].count, 2);
  assert.equal((await scalar('select public.get_dashboard_v2_trend(null)')).trend[0].count, 2);
  assert.deepEqual(await scalar('select public.compute_top_topic_trends()'), {});
  assert.equal((await scalar('select public.refresh_dashboard_v2_cache()')).status, 'refreshed');
  assert.equal(await scalar('select source_row_count::int from public.dashboard_v2_cache_refresh_log order by id desc limit 1'), 2);
  assert.equal(await scalar("select count(*)::int from public.dashboard_v2_cache where payload->>'protected'='true'"), 1);
  console.log('Reporting checks passed: expired raw data excluded before deletion, score contract, bounded recent feed, low-sample suppression, repeated migration');
  await assert.rejects(migration('20261005093000_cost_control_schedules'), /pg_cron is required/);
  console.log('Scheduler capability check passed: migration refuses to proceed when pg_cron is absent (hosted dispatch remains untested).');
  await testProductionSafety(db);
} catch (error) {
  console.error(error.message, error.detail ?? '', error.where ?? '');
  process.exitCode = 1;
} finally {
  await db.close();
}