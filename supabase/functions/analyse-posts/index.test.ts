import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  ALLOWED_CONTENT_TYPES,
  ALLOWED_EMOTIONS,
  ALLOWED_TOPICS,
  buildPrompt,
  callFoundry,
  validateAnalysisResponse,
} from './index.ts';

function validAnalysis(overrides: Record<string, unknown> = {}) {
  return {
    sentiment: 'positive',
    sentiment_score: 0.6,
    emotions: [{ name: 'excitement', intensity: 0.8 }],
    topics: [{ name: 'Productivity', relevance: 0.7 }],
    tools_mentioned: ['Copilot'],
    ai_tooling_stance: 'positive',
    confidence: 0.9,
    rationale: 'The post expresses enthusiasm about AI coding tools improving productivity.',
    content_type: 'organic',
    content_type_reason: 'Independent commentary praising a coding tool.',
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

Deno.test('accepts every allowed content_type', () => {
  for (const contentType of ALLOWED_CONTENT_TYPES) {
    assert(validateAnalysisResponse(validAnalysis({ content_type: contentType })).ok);
  }
});

Deno.test('rejects an invalid content_type enum value', () => {
  const result = validateAnalysisResponse(validAnalysis({ content_type: 'sponsored' }));
  assert(!result.ok);
});

Deno.test('rejects a missing or empty content_type_reason', () => {
  assert(!validateAnalysisResponse(validAnalysis({ content_type_reason: '' })).ok);
  assert(!validateAnalysisResponse(validAnalysis({ content_type_reason: '   ' })).ok);
  const withoutReason = validAnalysis();
  delete (withoutReason as Record<string, unknown>).content_type_reason;
  assert(!validateAnalysisResponse(withoutReason).ok);
});

Deno.test('truncates an overlong content_type_reason instead of failing the analysis', () => {
  const result = validateAnalysisResponse(validAnalysis({ content_type_reason: 'x'.repeat(1000) }));
  assert(result.ok);
  if (result.ok) {
    assertEquals(result.value.content_type_reason.length, 200);
  }
});

Deno.test('rejects confidence outside [0, 1]', () => {
  const result = validateAnalysisResponse(validAnalysis({ confidence: 1.01 }));
  assert(!result.ok);
});

Deno.test('accepts every approved emotion and topic', () => {
  const result = validateAnalysisResponse(validAnalysis({
    emotions: ALLOWED_EMOTIONS.map((name) => ({ name, intensity: 0.5 })),
    topics: ALLOWED_TOPICS.slice(0, 3).map((name) => ({ name, relevance: 0.5 })),
  }));
  assert(result.ok);
});

Deno.test('rejects topic arrays outside the one-to-three item bound', () => {
  assert(!validateAnalysisResponse(validAnalysis({ topics: [] })).ok);
  assert(validateAnalysisResponse(validAnalysis({ topics: [{ name: 'Privacy', relevance: 0.5 }] })).ok);
  assert(validateAnalysisResponse(validAnalysis({
    topics: ['Privacy', 'Safety', 'Trust'].map((name) => ({ name, relevance: 0.5 })),
  })).ok);
  const topics = ['Privacy', 'Safety', 'Trust', 'Security'].map((name) => ({ name, relevance: 0.5 }));
  const result = validateAnalysisResponse(validAnalysis({ topics }));
  assert(!result.ok);
});

Deno.test('rejects an empty emotions array', () => {
  const result = validateAnalysisResponse(validAnalysis({ emotions: [] }));
  assert(!result.ok);
});

Deno.test('rejects non-canonical, combined, and duplicate topics', () => {
  for (const name of ['productivity', 'Privacy/Security', 'Privacy, Security', 'AI reliability']) {
    assert(!validateAnalysisResponse(validAnalysis({ topics: [{ name, relevance: 0.5 }] })).ok);
  }
  assert(!validateAnalysisResponse(validAnalysis({
    topics: [{ name: 'Privacy', relevance: 0.8 }, { name: 'Privacy', relevance: 0.6 }],
  })).ok);
});

Deno.test('accepts empty tools_mentioned arrays while topics remain required', () => {
  const result = validateAnalysisResponse(validAnalysis({ tools_mentioned: [] }));
  assert(result.ok);
});

Deno.test('enforces AI Sentiment category and score compatibility', () => {
  assert(validateAnalysisResponse(validAnalysis({ sentiment: 'positive', sentiment_score: 0.1 })).ok);
  assert(validateAnalysisResponse(validAnalysis({ sentiment: 'negative', sentiment_score: -0.1 })).ok);
  assert(validateAnalysisResponse(validAnalysis({ sentiment: 'neutral', sentiment_score: 0.1 })).ok);
  assert(validateAnalysisResponse(validAnalysis({ sentiment: 'mixed', sentiment_score: 0 })).ok);
  assert(!validateAnalysisResponse(validAnalysis({ sentiment: 'positive', sentiment_score: 0 })).ok);
  assert(!validateAnalysisResponse(validAnalysis({ sentiment: 'negative', sentiment_score: 0 })).ok);
  assert(!validateAnalysisResponse(validAnalysis({ sentiment: 'neutral', sentiment_score: 0.2 })).ok);
});

Deno.test('prompt defines AI Sentiment, the canonical topic taxonomy, and tool stance', () => {
  const prompt = buildPrompt('OpenAI released a new model.', 'en');
  assert(prompt.includes('AI Sentiment is the author'));
  assert(prompt.includes('OpenAI released a new model.'));
  assert(prompt.includes(ALLOWED_TOPICS.join(', ')));
  assert(prompt.includes('not_applicable'));
  assert(!prompt.includes('Analyse the sentiment of exactly one'));
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
