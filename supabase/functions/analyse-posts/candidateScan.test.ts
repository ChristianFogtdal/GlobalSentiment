import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { runBatch } from './index.ts';

// Mock covering the query surface runBatch uses: an rpc() call to
// select_unanalysed_posts for candidate selection, plus the claim/persist
// writes against post_analyses_v2. Candidate filtering now happens in the
// database, so the mock rpc applies the same anti-join semantics.
function createMockSupabase(postCount: number, analysedUris: Set<string>) {
  const posts = Array.from({ length: postCount }, (_, index) => ({
    uri: `at://post/${index}`,
    post_text: `post ${index}`,
    original_language: 'en',
  }));
  const rows: Array<Record<string, unknown>> = [...analysedUris].map((uri) => ({
    post_uri: uri, prompt_version: 'v1', status: 'complete',
  }));
  let lastLimit: number | null = null;

  const client = {
    rpc(fn: string, args: { p_prompt_version: string; p_limit: number }) {
      assertEquals(fn, 'select_unanalysed_posts');
      lastLimit = args.p_limit;
      const eligible = posts.filter((post) => !rows.some(
        (row) => row.post_uri === post.uri && row.prompt_version === args.p_prompt_version,
      ));
      return Promise.resolve({ data: eligible.slice(0, args.p_limit), error: null });
    },
    from(table: string) {
      assertEquals(table, 'post_analyses_v2');
      return {
        insert(row: Record<string, unknown>) {
          if (rows.some((existing) => existing.post_uri === row.post_uri)) {
            return Promise.resolve({ error: { message: 'duplicate key' } });
          }
          rows.push({ ...row });
          return Promise.resolve({ error: null });
        },
        update(patch: Record<string, unknown>) {
          return {
            eq: (_c1: string, uri: unknown) => ({
              eq: (_c2: string, version: unknown) => {
                const row = rows.find((r) => r.post_uri === uri && r.prompt_version === version);
                if (row) Object.assign(row, patch);
                return Promise.resolve({ error: null });
              },
            }),
          };
        },
      };
    },
    __rows: rows,
    __lastLimit: () => lastLimit,
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
    sentiment: 'neutral', sentiment_score: 0, emotions: [{ name: 'neutral', intensity: 0.5 }],
    topics: [], tools_mentioned: [], ai_tooling_stance: 'not_applicable', confidence: 0.7,
    rationale: 'Grounded rationale text.',
  };
  return (() => Promise.resolve(
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }), { status: 200 }),
  )) as typeof fetch;
}

Deno.test('runBatch fills a batch from the oldest unanalysed posts', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchSuccess();
  try {
    const supabase = createMockSupabase(500, new Set());
    const result = await runBatch(supabase, baseConfig, 10);
    assert(!('error' in result));
    assertEquals(result.selected, 10);
    assertEquals(result.completed, 10);
    assertEquals(result.results[0].post_uri, 'at://post/0');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('runBatch keeps working when the analysed backlog is very large', async () => {
  // Regression: earlier implementations scanned bluesky_posts from offset 0
  // and skipped analysed rows client-side, bounded by a fixed scan limit.
  // Once the analysed backlog exceeded that bound, every run selected 0 posts
  // and the pipeline stalled. Selection is now filtered in the database, so a
  // backlog far larger than any previous bound must still yield a full batch.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchSuccess();
  try {
    const analysed = new Set(Array.from({ length: 6000 }, (_, i) => `at://post/${i}`));
    const supabase = createMockSupabase(6100, analysed);
    const result = await runBatch(supabase, baseConfig, 10);
    assert(!('error' in result));
    assertEquals(result.selected, 10);
    assertEquals(result.completed, 10);
    const fresh = result.results.map((entry) => entry.post_uri);
    assert(fresh.every((uri) => !analysed.has(uri)), 'must not reprocess already-analysed posts');
    assertEquals(fresh[0], 'at://post/6000');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('runBatch selects nothing when every post is already analysed', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchSuccess();
  try {
    const analysed = new Set(Array.from({ length: 120 }, (_, i) => `at://post/${i}`));
    const supabase = createMockSupabase(120, analysed);
    const result = await runBatch(supabase, baseConfig, 10);
    assert(!('error' in result));
    assertEquals(result.selected, 0);
    assertEquals(result.scanned, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('runBatch over-fetches candidates so concurrent claims do not shorten the batch', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetchSuccess();
  try {
    const supabase = createMockSupabase(500, new Set());
    // Pre-claim the first 5 candidates to simulate a concurrent invocation
    // taking them between selection and claiming.
    for (let i = 0; i < 5; i += 1) {
      supabase.__rows.push({ post_uri: `at://post/${i}`, prompt_version: 'v1', status: 'processing' });
    }
    const result = await runBatch(supabase, baseConfig, 10);
    assert(!('error' in result));
    // The over-fetch must supply enough spare candidates to still fill the batch.
    assertEquals(result.selected, 10);
    assert(supabase.__lastLimit()! > 10, 'must request more candidates than the batch size');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('runBatch surfaces a candidate selection error instead of silently selecting nothing', async () => {
  const supabase = {
    rpc: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
    // deno-lint-ignore no-explicit-any
  } as any;
  const result = await runBatch(supabase, baseConfig, 10);
  assertEquals(result, { error: 'boom' });
});
