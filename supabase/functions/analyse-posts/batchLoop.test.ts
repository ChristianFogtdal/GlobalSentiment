import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { claimAndProcess } from './index.ts';

// Minimal in-memory mock of the subset of the Supabase JS client surface
// that claimAndProcess/processClaimedPost use: .from(table).insert(...),
// .from(table).update(...).eq(...).eq(...). Good enough to exercise the
// claim-then-process-then-persist control flow without a live database.
function createMockSupabase(options: { claimShouldFail?: (postUri: string) => boolean } = {}) {
  const rows: Array<Record<string, unknown>> = [];
  const claimShouldFail = options.claimShouldFail ?? (() => false);

  const client = {
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
};

function mockFetchSuccess() {
  const analysis = {
    sentiment: 'positive',
    sentiment_score: 0.5,
    emotions: [{ name: 'excitement', intensity: 0.7 }],
    topics: [{ name: 'productivity', relevance: 0.6 }],
    tools_mentioned: ['Copilot'],
    ai_tooling_stance: 'positive',
    confidence: 0.8,
    rationale: 'Grounded rationale text about the post.',
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
    { uri: 'at://post/a', post_text: 'first', original_language: 'en' },
    { uri: 'at://post/b', post_text: 'second (will fail)', original_language: 'en' },
    { uri: 'at://post/c', post_text: 'third', original_language: 'en' },
  ];
  // Fail only the second Foundry call, succeed the first and third.
  let callIndex = 0;
  globalThis.fetch = (() => {
    callIndex += 1;
    if (callIndex === 2) return Promise.resolve(new Response('server error', { status: 500 }));
    const analysis = {
      sentiment: 'neutral', sentiment_score: 0, emotions: [{ name: 'neutral', intensity: 0.5 }],
      topics: [], tools_mentioned: [], ai_tooling_stance: 'not_applicable', confidence: 0.7,
      rationale: 'Grounded rationale.',
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
