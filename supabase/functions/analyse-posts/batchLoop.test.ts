import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildAnalysisCacheKey, buildFoundryRequest, claimAndProcess, processClaimedPost } from './index.ts';
import { contentKey } from '../_shared/costControls.ts';

// Minimal in-memory mock of the subset of the Supabase JS client surface
// that claimAndProcess/processClaimedPost use: .from(table).insert(...),
// .from(table).update(...).eq(...).eq(...). Good enough to exercise the
// claim-then-process-then-persist control flow without a live database.
function createMockSupabase(options: { claimShouldFail?: (postUri: string) => boolean } = {}) {
  const rows: Array<Record<string, unknown>> = [];
  const claimShouldFail = options.claimShouldFail ?? (() => false);

  const client = {
    rpc(name: string, args: { p_post_uri: string; p_prompt_version: string; p_skip_reason: string | null; p_result?: Record<string, unknown>; p_error?: string }) {
      if (name === 'renew_pipeline_lease') return Promise.resolve({ data: true, error: null });
      if (name === 'finish_post_analysis') {
        const row = rows.find((entry) => entry.post_uri === args.p_post_uri && entry.status === 'processing');
        if (row) Object.assign(row, args.p_result, { status: args.p_error ? 'failed' : 'complete' });
        return Promise.resolve({ data: row ? 1 : 0, error: null });
      }
      if (claimShouldFail(args.p_post_uri) || rows.some((row) => row.post_uri === args.p_post_uri)) {
        return Promise.resolve({ data: 'skipped', error: null });
      }
      rows.push({ post_uri: args.p_post_uri, prompt_version: args.p_prompt_version, status: args.p_skip_reason ? 'failed' : 'processing' });
      return Promise.resolve({ data: args.p_skip_reason ? 'filtered' : 'claimed', error: null });
    },
    from(table: string) {
      assertEquals(table, 'post_analyses_v2');
      return {
        insert(row: Record<string, unknown>) {
          const postUri = row.post_uri as string;
          if (claimShouldFail(postUri) || rows.some((existing) => existing.post_uri === postUri)) {
            return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint' } });
          }
          rows.push({ ...row });
          return Promise.resolve({ error: null });
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(_col1: string, val1: unknown) {
              return {
                eq(_col2: string, val2: unknown) {
                  const row = rows.find((r) => r.post_uri === val1 && r.prompt_version === val2);
                  if (row) Object.assign(row, patch);
                  return Promise.resolve({ error: null });
                },
              };
            },
          };
        },
      };
    },
    __rows: rows,
    // deno-lint-ignore no-explicit-any
  } as any;
  return client;
}

const baseConfig = {
  endpoint: 'https://example.openai.azure.com',
  apiKey: 'test-key',
  deployment: 'test-deployment',
  model: 'test-model',
  promptVersion: 'v1',
  lease: { pipeline: 'analysis' as const, owner: '11111111-1111-4111-8111-111111111111', fence: 1, deadline: Number.MAX_SAFE_INTEGER },
};

function mockFetchSuccess() {
  const analysis = {
    sentiment: 'positive',
    sentiment_score: 0.5,
    emotions: [{ name: 'excitement', intensity: 0.7 }],
    topics: [{ name: 'Productivity', relevance: 0.6 }],
    tools_mentioned: ['Copilot'],
    ai_tooling_stance: 'positive',
    confidence: 0.8,
    rationale: 'Grounded rationale text about the post.',
    content_type: 'organic',
    content_type_reason: 'Independent commentary about a coding tool.',
  };
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }), { status: 200 }),
    )) as typeof fetch;
}

function mockFetchFailure() {
  return (() => Promise.resolve(new Response('server error', { status: 500 }))) as typeof fetch;
}

Deno.test('claimAndProcess persists a completed result on Foundry success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchSuccess();
  try {
    const supabase = createMockSupabase();
    const result = await claimAndProcess(supabase, baseConfig, {
      uri: 'at://post/1', post_text: 'hello world', original_language: 'en',
    });
    assert(result);
    assertEquals(result!.outcome, 'completed');
    const row = supabase.__rows.find((r: Record<string, unknown>) => r.post_uri === 'at://post/1');
    assertEquals(row.status, 'complete');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('claimAndProcess marks a row failed on Foundry error but does not throw', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchFailure();
  try {
    const supabase = createMockSupabase();
    const result = await claimAndProcess(supabase, baseConfig, {
      uri: 'at://post/2', post_text: 'hello world', original_language: 'en',
    });
    assert(result);
    assertEquals(result!.outcome, 'failed');
    const row = supabase.__rows.find((r: Record<string, unknown>) => r.post_uri === 'at://post/2');
    assertEquals(row.status, 'failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('claimAndProcess returns null when the (post_uri, prompt_version) slot is already claimed', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchSuccess();
  try {
    const supabase = createMockSupabase({ claimShouldFail: (uri) => uri === 'at://post/3' });
    const result = await claimAndProcess(supabase, baseConfig, {
      uri: 'at://post/3', post_text: 'hello world', original_language: 'en',
    });
    assertEquals(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('a batch loop continues past an individual failed post to complete the rest', async () => {
  const originalFetch = globalThis.fetch;
  const posts = [
    { uri: 'at://post/a', post_text: 'first AI opinion', original_language: 'en' },
    { uri: 'at://post/b', post_text: 'second (will fail)', original_language: 'en' },
    { uri: 'at://post/c', post_text: 'third AI opinion', original_language: 'en' },
  ];
  // Fail only the second Foundry call, succeed the first and third.
  let callIndex = 0;
  globalThis.fetch = (() => {
    callIndex += 1;
    if (callIndex === 2) return Promise.resolve(new Response('server error', { status: 500 }));
    const analysis = {
      sentiment: 'neutral', sentiment_score: 0, emotions: [{ name: 'neutral', intensity: 0.5 }],
      topics: [{ name: 'Capabilities', relevance: 0.5 }], tools_mentioned: [], ai_tooling_stance: 'not_applicable', confidence: 0.7,
      rationale: 'Grounded rationale.', content_type: 'organic', content_type_reason: 'Neutral factual post.',
    };
    return Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }), { status: 200 }),
    );
  }) as typeof fetch;

  try {
    const supabase = createMockSupabase();
    let completed = 0;
    let failed = 0;
    for (const post of posts) {
      const result = await claimAndProcess(supabase, baseConfig, post);
      if (!result) continue;
      if (result.outcome === 'completed') completed += 1;
      else if (result.outcome === 'failed') failed += 1;
    }
    // The loop must not abort after the failure in the middle: both the
    // preceding and following posts should still complete.
    assertEquals(completed, 2);
    assertEquals(failed, 1);
    assertEquals(supabase.__rows.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('cache hits, in-flight duplicates and filtered content never call Foundry', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Provider must not be called'); };
  try {
    for (const status of ['cached', 'skipped', 'filtered']) {
      const client = { rpc: () => Promise.resolve({ data: status, error: null }) };
      const result = await claimAndProcess(client as unknown as Parameters<typeof claimAndProcess>[0], baseConfig, {
        uri: 'at://cached', post_text: 'AI tools improve my workflow', original_language: 'en',
      });
      assertEquals(result?.outcome ?? null, status === 'cached' ? 'completed' : status === 'filtered' ? 'skipped' : null);
    }
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('claim database errors are reported rather than treated as duplicate success', async () => {
  const client = { rpc: () => Promise.resolve({ data: null, error: { message: 'database unavailable' } }) };
  const result = await claimAndProcess(client as unknown as Parameters<typeof claimAndProcess>[0], baseConfig, {
    uri: 'at://failure', post_text: 'AI tools improve my workflow', original_language: 'en',
  });
  assertEquals(result, { outcome: 'failed', post_uri: 'at://failure', error: 'database unavailable' });
});

Deno.test('zero-row completion after deletion or ownership change never reports success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchSuccess();
  try {
    const client = { rpc: (name: string) => Promise.resolve({ data: name === 'renew_pipeline_lease' ? true : 0, error: null }) };
    const result = await processClaimedPost(client as unknown as Parameters<typeof processClaimedPost>[0], baseConfig, {
      uri: 'at://deleted', post_text: 'AI opinion about capabilities', original_language: 'en',
    });
    assertEquals(result.outcome, 'failed');
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('expired or replaced worker lease prevents another provider call', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error('Must not call provider'); };
  try {
    const client = { rpc: () => Promise.resolve({ data: false, error: null }) };
    const result = await processClaimedPost(client as unknown as Parameters<typeof processClaimedPost>[0], baseConfig, {
      uri: 'at://stale', post_text: 'AI opinion about capabilities', original_language: 'en',
    });
    assertEquals(result.outcome, 'failed');
    assertEquals(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

Deno.test('cache key includes the entire transmitted request and explicit model contract', async () => {
  const post = { uri: 'at://hash', post_text: 'AI tools improve my workflow', original_language: 'en' };
  const request = buildFoundryRequest(baseConfig.deployment, post.post_text, post.original_language);
  const parts = [baseConfig.endpoint, baseConfig.deployment, baseConfig.model, baseConfig.promptVersion];
  const key = await buildAnalysisCacheKey(baseConfig, post);
  assertEquals(key, await contentKey([...parts, JSON.stringify(request)]));
  assertEquals(key, await buildAnalysisCacheKey({ ...baseConfig, endpoint: `${baseConfig.endpoint}/` }, post));
  request.messages[0].content = 'Changed system contract';
  assert(key !== await contentKey([...parts, JSON.stringify(request)]));
  assert(key !== await buildAnalysisCacheKey({ ...baseConfig, model: 'new-revision' }, post));
  assert(key !== await buildAnalysisCacheKey({ ...baseConfig, promptVersion: 'v2' }, post));
});
