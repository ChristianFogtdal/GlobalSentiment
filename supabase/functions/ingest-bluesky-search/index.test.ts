import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { handleRequest, prepareRows } from './index.ts';
import { collectionLimits, contentKey, hasUsefulText, isRecent, RETENTION_MS, searchPlan } from '../_shared/costControls.ts';

const now = Date.parse('2026-10-05T12:00:00Z');
const makePost = (uri: string, text = 'AI tools improve my workflow', publishedAt = new Date(now).toISOString()) => ({
  uri, author: { handle: 'test.bsky.social' }, record: { text, createdAt: publishedAt, langs: ['en'] },
});

Deno.test('collection preserves the 30-day boundary and rejects old, future and invalid timestamps', () => {
  const boundary = new Date(now - RETENTION_MS).toISOString();
  assert(isRecent(boundary, now));
  assert(!isRecent(new Date(now - RETENTION_MS - 1).toISOString(), now));
  assert(!isRecent(new Date(now + 1).toISOString(), now));
  assert(!isRecent('invalid', now));
  assert(!isRecent(undefined, now));
  assert(!isRecent('2026-10-05T12:00:00', now));
  assert(isRecent('2026-10-05T23:00:00+11:00', now));
  assertEquals(prepareRows([makePost('boundary', undefined, boundary)], 25, now).length, 1);
});

Deno.test('collection deduplicates by stable URI without updating unchanged records', () => {
  const rows = prepareRows([makePost('at://one'), makePost('at://one', 'Different text should not overwrite'), makePost('at://two')], 25, now);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].post_text, 'AI tools improve my workflow');
  assert(!('rule_evidence' in rows[0]));
});

Deno.test('collection limits are bounded and rotate through the entire search vocabulary', () => {
  const limits = collectionLimits(() => undefined);
  const terms = Array.from({ length: 58 }, (_, index) => `term ${index}`);
  const seen = new Set<string>();
  for (let hour = 0; hour < 58; hour += 1) {
    const plan = searchPlan(terms, limits, now + hour * 3600_000);
    assertEquals(plan.length, 5);
    assertEquals(plan.reduce((sum, entry) => sum + entry.limit, 0), 25);
    plan.forEach((entry) => seen.add(entry.term));
  }
  assertEquals(seen.size, 58);
  const high = collectionLimits(() => '1000000');
  assertEquals(high.postsPerRun, 100);
  assert(searchPlan(terms, high, now).reduce((sum, entry) => sum + entry.limit, 0) <= 100);
  const low = collectionLimits((key) => key === 'INGEST_POSTS_PER_SOURCE' ? '2' : undefined);
  assertEquals(searchPlan(terms, low, now).reduce((sum, entry) => sum + entry.limit, 0), 2);
  assertEquals(collectionLimits(() => '1garbage').postsPerRun, 25);
  assertEquals(collectionLimits(() => '0').intervalMinutes, 60);
  assertEquals(prepareRows(Array.from({ length: 60 }, (_, index) => makePost(`at://${index}`)), 25, now).length, 25);
});

Deno.test('content filtering is language-neutral and excludes empty, tiny, numeric and link-only content', () => {
  for (const text of ['', 'AI', '1234567890', 'https://example.com/long-url']) assert(!hasUsefulText(text));
  assert(hasUsefulText('AI is useful'));
  assert(hasUsefulText('人工智能工具正在改变工作方式'));
});

Deno.test('content hashes preserve text, language, prompt and model distinctions', async () => {
  const key = await contentKey(['model', 'v1', 'en', 'AI is useful']);
  assertEquals(key.length, 64);
  assertEquals(key, await contentKey(['model', 'v1', 'en', 'AI is useful']));
  for (const parts of [
    ['model', 'v2', 'en', 'AI is useful'], ['other', 'v1', 'en', 'AI is useful'],
    ['model', 'v1', 'fr', 'AI is useful'], ['model', 'v1', 'en', 'AI is NOT useful'],
  ]) assert(key !== await contentKey(parts));
});

Deno.test('ingestion denies unauthenticated requests before any external call', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network must not be called'); };
  try {
    const response = await handleRequest(new Request('https://example.com', { method: 'POST' }));
    assertEquals(response.status, 401);
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('shared admission prevents another ingestion run before authentication or search', async () => {
  const values: Record<string, string> = {
    INGESTION_SECRET: 'test-secret', BLUESKY_HANDLE: 'test', BLUESKY_APP_PASSWORD: 'test-password',
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  };
  const original = Object.fromEntries(Object.keys(values).map((name) => [name, Deno.env.get(name)]));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    assert(String(input).includes('/rpc/acquire_pipeline_lease'));
    requests += 1;
    return Promise.resolve(new Response('null', { headers: { 'Content-Type': 'application/json' } }));
  }) as typeof fetch;
  try {
    Object.entries(values).forEach(([name, value]) => Deno.env.set(name, value));
    const response = await handleRequest(new Request('https://example.com', { method: 'POST', headers: { 'x-ingestion-secret': 'test-secret' } }));
    assertEquals(response.status, 200);
    assertEquals(requests, 1);
    assertEquals((await response.json()).skipped, 'worker busy or interval not elapsed');
  } finally {
    globalThis.fetch = originalFetch;
    Object.entries(original).forEach(([name, value]) => value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value));
  }
});