import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateAnalysisResponse, callFoundry } from './index.ts';

function validAnalysis(overrides: Record<string, unknown> = {}) {
  return {
    sentiment: 'positive',
    sentiment_score: 0.6,
    emotions: [{ name: 'excitement', intensity: 0.8 }],
    topics: [{ name: 'productivity', relevance: 0.7 }],
    tools_mentioned: ['Copilot'],
    ai_tooling_stance: 'positive',
    confidence: 0.9,
    rationale: 'The post expresses enthusiasm about AI coding tools improving productivity.',
    ...overrides,
  };
}

Deno.test('accepts a fully valid response', () => {
  const result = validateAnalysisResponse(validAnalysis());
  assert(result.ok);
  if (result.ok) {
    assertEquals(result.value.sentiment, 'positive');
    assertEquals(result.value.sentiment_score, 0.6);
    assertEquals(result.value.emotions, [{ name: 'excitement', intensity: 0.8 }]);
    assertEquals(result.value.tools_mentioned, ['Copilot']);
  }
});

Deno.test('rejects an invalid sentiment enum value', () => {
  const result = validateAnalysisResponse(validAnalysis({ sentiment: 'ecstatic' }));
  assert(!result.ok);
});

Deno.test('rejects an invalid nested emotion intensity out of range', () => {
  const result = validateAnalysisResponse(validAnalysis({
    emotions: [{ name: 'excitement', intensity: 1.5 }],
  }));
  assert(!result.ok);
});

Deno.test('rejects an invalid emotion name outside the fixed taxonomy', () => {
  const result = validateAnalysisResponse(validAnalysis({
    emotions: [{ name: 'joy', intensity: 0.5 }],
  }));
  assert(!result.ok);
});

Deno.test('rejects sentiment_score outside [-1, 1]', () => {
  const result = validateAnalysisResponse(validAnalysis({ sentiment_score: 1.2 }));
  assert(!result.ok);
});

Deno.test('rejects malformed JSON payload (non-object)', () => {
  const result = validateAnalysisResponse('not an object');
  assert(!result.ok);
});

Deno.test('rejects null payload', () => {
  const result = validateAnalysisResponse(null);
  assert(!result.ok);
});

Deno.test('rejects missing required fields', () => {
  const analysis = validAnalysis();
  delete (analysis as Record<string, unknown>).confidence;
  const result = validateAnalysisResponse(analysis);
  assert(!result.ok);
});

Deno.test('rejects invalid tool list entries', () => {
  const result = validateAnalysisResponse(validAnalysis({
    tools_mentioned: ['Copilot', 123],
  }));
  assert(!result.ok);
});

Deno.test('rejects a tool name exceeding the max length', () => {
  const result = validateAnalysisResponse(validAnalysis({
    tools_mentioned: ['x'.repeat(200)],
  }));
  assert(!result.ok);
});

Deno.test('rejects rationale exceeding the max response size', () => {
  const result = validateAnalysisResponse(validAnalysis({
    rationale: 'x'.repeat(1000),
  }));
  assert(!result.ok);
});

Deno.test('rejects an empty rationale', () => {
  const result = validateAnalysisResponse(validAnalysis({ rationale: '   ' }));
  assert(!result.ok);
});

Deno.test('rejects an invalid ai_tooling_stance', () => {
  const result = validateAnalysisResponse(validAnalysis({ ai_tooling_stance: 'excited' }));
  assert(!result.ok);
});

Deno.test('rejects confidence outside [0, 1]', () => {
  const result = validateAnalysisResponse(validAnalysis({ confidence: 1.01 }));
  assert(!result.ok);
});

Deno.test('rejects topics array exceeding max size', () => {
  const topics = Array.from({ length: 11 }, (_, index) => ({ name: `topic-${index}`, relevance: 0.5 }));
  const result = validateAnalysisResponse(validAnalysis({ topics }));
  assert(!result.ok);
});

Deno.test('rejects an empty emotions array', () => {
  const result = validateAnalysisResponse(validAnalysis({ emotions: [] }));
  assert(!result.ok);
});

Deno.test('accepts topics/tools_mentioned empty arrays (not required to be non-empty)', () => {
  const result = validateAnalysisResponse(validAnalysis({ topics: [], tools_mentioned: [] }));
  assert(result.ok);
});

Deno.test('callFoundry surfaces malformed JSON from a mocked Foundry response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: '{not valid json' } }] }), { status: 200 }),
    )) as typeof fetch;
  try {
    const result = await callFoundry({
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'test-key',
      deployment: 'test-deployment',
      model: 'test-model',
      postText: 'hello world',
      originalLanguage: 'en',
    });
    assert(!result.ok);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('callFoundry surfaces a non-2xx Foundry response as a bounded error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response('server error', { status: 500 }))) as typeof fetch;
  try {
    const result = await callFoundry({
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'test-key',
      deployment: 'test-deployment',
      model: 'test-model',
      postText: 'hello world',
      originalLanguage: null,
    });
    assert(!result.ok);
    if (!result.ok) {
      assert(result.error.includes('500'));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test('callFoundry parses a valid mocked structured-output response', async () => {
  const originalFetch = globalThis.fetch;
  const mockAnalysis = validAnalysis();
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(mockAnalysis) } }] }), { status: 200 }),
    )) as typeof fetch;
  try {
    const result = await callFoundry({
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'test-key',
      deployment: 'test-deployment',
      model: 'test-model',
      postText: 'hello world',
      originalLanguage: 'en',
    });
    assert(result.ok);
    if (result.ok) {
      const validated = validateAnalysisResponse(result.raw);
      assert(validated.ok);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
