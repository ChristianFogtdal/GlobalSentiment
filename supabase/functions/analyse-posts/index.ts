import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Azure Foundry sentiment-enrichment worker: batched, sequential, scheduled
// via cron (see supabase/migrations/20260903100000_scheduled_analyse_posts.sql),
// with a manual single-post override.
//
// This function is additive and isolated from the legacy post_analyses /
// completed_post_analyses pipeline: it reads and writes only
// post_analyses_v2. It must be invoked by a server-side caller holding
// INGESTION_SECRET (the same admin secret used by ingest-bluesky-search),
// whether that caller is the pg_cron/pg_net schedule or a manual admin
// request. The browser can never call this function directly with a usable
// credential.
//
// Cost containment: Foundry calls within a single invocation are always
// sequential, never concurrent. With an explicit post_uri, at most one
// provider call is made. Without one (batched/scheduled mode), at most
// LLM_BATCH_SIZE provider calls are made, clamped to a hard ceiling
// regardless of configuration.

const corsHeaders = { 'Content-Type': 'application/json' };

export const ALLOWED_SENTIMENTS = ['positive', 'negative', 'neutral', 'mixed'] as const;
export const ALLOWED_STANCES = ['positive', 'negative', 'neutral', 'mixed', 'not_applicable'] as const;
export const ALLOWED_EMOTIONS = [
  'excitement', 'optimism', 'trust', 'curiosity', 'admiration', 'relief',
  'neutral', 'surprise', 'confusion', 'concern', 'skepticism', 'uncertainty',
  'frustration', 'disappointment', 'fear', 'anger', 'awe', 'hype', 'doubt', 'urgency',
] as const;
export const ALLOWED_TOPICS = [
  'Reliability', 'Accuracy', 'Quality', 'Performance', 'Capabilities', 'Innovation',
  'Safety', 'Security', 'Privacy', 'Trust', 'Transparency', 'Explainability', 'Bias',
  'Fairness', 'Automation', 'Productivity', 'Efficiency', 'Usability', 'Accessibility',
  'Personalization', 'Integration', 'Deployment', 'Scalability', 'Availability',
  'Compatibility', 'Cost', 'Pricing', 'Business Value', 'ROI', 'Competition',
  'Market Adoption', 'Economic Impact', 'Employment Impact', 'Regulation', 'Governance',
  'Ethics', 'Copyright', 'Digital Rights', 'Public Opinion', 'Political Impact',
  'Misinformation', 'Education', 'Learning', 'Research', 'Healthcare',
  'Environmental Impact', 'Open Source', 'Community', 'Risk', 'Opportunity', 'Other',
] as const;

const MAX_RATIONALE_LENGTH = 600;
const MIN_TOPICS = 1;
const MAX_TOPICS = 3;
const MAX_EMOTIONS = ALLOWED_EMOTIONS.length;
const MAX_TOOLS_MENTIONED = 20;
const MAX_TOOL_NAME_LENGTH = 80;

type Sentiment = typeof ALLOWED_SENTIMENTS[number];
type Stance = typeof ALLOWED_STANCES[number];
type Topic = typeof ALLOWED_TOPICS[number];

interface EmotionEntry { name: string; intensity: number }
interface TopicEntry { name: string; relevance: number }

interface ValidatedAnalysis {
  sentiment: Sentiment;
  sentiment_score: number;
  emotions: EmotionEntry[];
  topics: TopicEntry[];
  tools_mentioned: string[];
  ai_tooling_stance: Stance;
  confidence: number;
  rationale: string;
}

function isFiniteNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

// Pure validation of the provider's structured JSON response. No network
// access; safe to unit test directly with mocked payloads.
export function validateAnalysisResponse(payload: unknown): { ok: true; value: ValidatedAnalysis } | { ok: false; error: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, error: 'Response is not an object' };
  }
  const candidate = payload as Record<string, unknown>;

  if (typeof candidate.sentiment !== 'string' || !ALLOWED_SENTIMENTS.includes(candidate.sentiment as Sentiment)) {
    return { ok: false, error: 'Invalid or missing sentiment' };
  }
  if (!isFiniteNumberInRange(candidate.sentiment_score, -1, 1)) {
    return { ok: false, error: 'Invalid or missing sentiment_score' };
  }
  if (
    (candidate.sentiment === 'positive' && candidate.sentiment_score <= 0) ||
    (candidate.sentiment === 'negative' && candidate.sentiment_score >= 0) ||
    (candidate.sentiment === 'neutral' && Math.abs(candidate.sentiment_score) > 0.1)
  ) {
    return { ok: false, error: 'sentiment_score is incompatible with sentiment' };
  }
  if (!Array.isArray(candidate.emotions) || candidate.emotions.length === 0 || candidate.emotions.length > MAX_EMOTIONS) {
    return { ok: false, error: 'Invalid or missing emotions array' };
  }
  const emotions: EmotionEntry[] = [];
  for (const entry of candidate.emotions) {
    if (typeof entry !== 'object' || entry === null) return { ok: false, error: 'Invalid emotion entry shape' };
    const emotionEntry = entry as Record<string, unknown>;
    if (typeof emotionEntry.name !== 'string' || !ALLOWED_EMOTIONS.includes(emotionEntry.name as typeof ALLOWED_EMOTIONS[number])) {
      return { ok: false, error: `Invalid emotion name: ${String(emotionEntry.name)}` };
    }
    if (!isFiniteNumberInRange(emotionEntry.intensity, 0, 1)) {
      return { ok: false, error: 'Invalid emotion intensity' };
    }
    emotions.push({ name: emotionEntry.name, intensity: emotionEntry.intensity });
  }

  if (!Array.isArray(candidate.topics) || candidate.topics.length < MIN_TOPICS || candidate.topics.length > MAX_TOPICS) {
    return { ok: false, error: 'Invalid topics array' };
  }
  const topics: TopicEntry[] = [];
  const topicNames = new Set<string>();
  for (const entry of candidate.topics) {
    if (typeof entry !== 'object' || entry === null) return { ok: false, error: 'Invalid topic entry shape' };
    const topicEntry = entry as Record<string, unknown>;
    if (typeof topicEntry.name !== 'string' || !ALLOWED_TOPICS.includes(topicEntry.name as Topic)) {
      return { ok: false, error: `Invalid topic name: ${String(topicEntry.name)}` };
    }
    if (topicNames.has(topicEntry.name)) return { ok: false, error: `Duplicate topic name: ${topicEntry.name}` };
    if (!isFiniteNumberInRange(topicEntry.relevance, 0, 1)) return { ok: false, error: 'Invalid topic relevance' };
    topicNames.add(topicEntry.name);
    topics.push({ name: topicEntry.name, relevance: topicEntry.relevance });
  }

  if (!Array.isArray(candidate.tools_mentioned) || candidate.tools_mentioned.length > MAX_TOOLS_MENTIONED) {
    return { ok: false, error: 'Invalid tools_mentioned array' };
  }
  const toolsMentioned: string[] = [];
  for (const entry of candidate.tools_mentioned) {
    if (!isNonEmptyString(entry, MAX_TOOL_NAME_LENGTH)) return { ok: false, error: 'Invalid tools_mentioned entry' };
    toolsMentioned.push(entry.trim());
  }

  if (typeof candidate.ai_tooling_stance !== 'string' || !ALLOWED_STANCES.includes(candidate.ai_tooling_stance as Stance)) {
    return { ok: false, error: 'Invalid or missing ai_tooling_stance' };
  }
  if (!isFiniteNumberInRange(candidate.confidence, 0, 1)) {
    return { ok: false, error: 'Invalid or missing confidence' };
  }
  if (!isNonEmptyString(candidate.rationale, MAX_RATIONALE_LENGTH)) {
    return { ok: false, error: 'Invalid or missing rationale' };
  }

  return {
    ok: true,
    value: {
      sentiment: candidate.sentiment as Sentiment,
      sentiment_score: candidate.sentiment_score as number,
      emotions,
      topics,
      tools_mentioned: toolsMentioned,
      ai_tooling_stance: candidate.ai_tooling_stance as Stance,
      confidence: candidate.confidence as number,
      rationale: (candidate.rationale as string).trim(),
    },
  };
}

const RESPONSE_JSON_SCHEMA = {
  name: 'post_sentiment_analysis',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sentiment: { type: 'string', enum: ALLOWED_SENTIMENTS },
      sentiment_score: { type: 'number', minimum: -1, maximum: 1 },
      emotions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_EMOTIONS,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', enum: ALLOWED_EMOTIONS },
            intensity: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['name', 'intensity'],
        },
      },
      topics: {
        type: 'array',
        minItems: MIN_TOPICS,
        maxItems: MAX_TOPICS,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', enum: ALLOWED_TOPICS },
            relevance: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['name', 'relevance'],
        },
      },
      tools_mentioned: {
        type: 'array',
        maxItems: MAX_TOOLS_MENTIONED,
        items: { type: 'string' },
      },
      ai_tooling_stance: { type: 'string', enum: ALLOWED_STANCES },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      rationale: { type: 'string' },
    },
    required: ['sentiment', 'sentiment_score', 'emotions', 'topics', 'tools_mentioned', 'ai_tooling_stance', 'confidence', 'rationale'],
  },
};

export function buildPrompt(postText: string, originalLanguage: string | null) {
  const languageNote = originalLanguage ? `Original language tag: ${originalLanguage}.` : 'Original language tag: unknown.';
  return [
    'Analyse exactly one social media post about AI. ' +
      'Ground every field only in the supplied post text; do not speculate beyond it.',
    languageNote,
    `Post text: """${postText}"""`,
    '',
    'AI Sentiment is the author’s expressed view of the AI technology, company, model, deployment, or AI-related development discussed. ' +
      'It is not generic wording polarity or overall mood. Ignore incidental positive or negative wording.',
    '- positive: endorsement or favourable evaluation of the AI subject (for example, "The benchmark results are amazing.").',
    '- negative: criticism of, or concern about harm from, the AI subject (for example, "AI companies are violating privacy.").',
    '- neutral: factual reporting without an evaluative position (for example, "OpenAI released a new model.").',
    '- mixed: material positive and negative views of the AI subject (for example, "The model is impressive but could threaten jobs.").',
    'Follow these rules precisely when producing the AI Sentiment score:',
    '- sentiment_score is on a continuous scale from -1.0 (extremely negative AI Sentiment) to 1.0 (extremely positive AI Sentiment), with 0.0 meaning neutral.',
    '- sentiment_score MUST be directionally consistent with the categorical sentiment field: ' +
      'if sentiment is "negative", sentiment_score MUST be less than 0; if sentiment is "positive", sentiment_score MUST be greater than 0; ' +
      'if sentiment is "neutral", sentiment_score MUST be close to 0.0 (roughly -0.1 to 0.1); if sentiment is "mixed", sentiment_score reflects the net balance and may be anywhere in range, including close to 0.0.',
    '- Do not default neutral or purely factual/informational posts to a midpoint of a 0-to-1 scale. The scale is -1 to 1, and "neutral" means near zero, not near 0.5.',
    '- Sarcastic or ironic posts must be scored by their real intended meaning, not the literal surface words.',
    '',
    'Emotion describes affect, and Topics describe subject themes; neither determines AI Sentiment.',
    `Topics must contain 1-3 unique canonical labels selected only from this taxonomy, in this exact spelling: ${ALLOWED_TOPICS.join(', ')}.`,
    '- Select separate labels for the actual subject themes. Do not use qualifiers, sentences, product/tool names, combined concepts, or separators.',
    '- Use Other only when no specific taxonomy label applies. Omit semantically redundant labels.',
    'Follow these rules precisely when producing topics, tools_mentioned, and ai_tooling_stance:',
    '- tools_mentioned is the exclusive place for concrete AI product/tool names (e.g. "ChatGPT", "Copilot", "Claude", "Gemini").',
    '- ai_tooling_stance records an explicit evaluative stance toward a named AI product/tool only. It is independently grounded in the text and never inferred from AI Sentiment.',
    '- Use ai_tooling_stance "not_applicable" when no named product/tool is evaluated, including factual product mentions and posts about AI generally.',
  ].join('\n');
}

export async function callFoundry(params: {
  endpoint: string; apiKey: string; deployment: string; model: string;
  postText: string; originalLanguage: string | null;
}): Promise<{ ok: true; raw: unknown } | { ok: false; error: string }> {
  const url = `${params.endpoint.replace(/\/+$/, '')}/openai/v1/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': params.apiKey },
      body: JSON.stringify({
        model: params.deployment,
        messages: [
          { role: 'system', content: 'You are a strict sentiment-analysis engine for AI-related social media posts. Respond only via the provided JSON schema.' },
          { role: 'user', content: buildPrompt(params.postText, params.originalLanguage) },
        ],
        response_format: { type: 'json_schema', json_schema: RESPONSE_JSON_SCHEMA },
        // gpt-5-mini is a reasoning-family model on Azure OpenAI: it rejects
        // the legacy `max_tokens` parameter (requires `max_completion_tokens`)
        // and rejects any non-default `temperature` value (only the model's
        // internal default is supported), per Microsoft Learn's reasoning
        // models guidance. max_completion_tokens covers BOTH internal
        // reasoning tokens and visible output tokens, so it must be sized
        // well above the visible JSON payload alone or the model can return
        // an empty completion (finish_reason: "length"). reasoning_effort
        // is set to minimal since this is a simple, bounded classification
        // task that does not need deep reasoning.
        reasoning_effort: 'minimal',
        max_completion_tokens: 2000,
      }),
    });
  } catch (error) {
    return { ok: false, error: `Foundry request failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!response.ok) {
    // Do not include response body verbatim (could echo back credentials in edge cases); keep bounded.
    return { ok: false, error: `Foundry request returned status ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: 'Foundry response was not valid JSON' };
  }

  const content = (body as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    return { ok: false, error: 'Foundry response missing message content' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: 'Foundry message content was not valid JSON' };
  }

  return { ok: true, raw: parsed };
}

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;

// Candidate selection over-fetches by this multiple of the batch size so that
// posts claimed by a concurrent invocation between selection and claiming do
// not leave the batch short. Selection itself is filtered in the database (see
// the select_unanalysed_posts function), so no scan bound is needed.
const CANDIDATE_OVERFETCH_MULTIPLIER = 2;

export function resolveBatchSize(): number {
  const raw = Deno.env.get('LLM_BATCH_SIZE');
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_BATCH_SIZE;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(parsed, MAX_BATCH_SIZE);
}

interface EligiblePost {
  uri: string;
  post_text: string;
  original_language: string | null;
}

interface FoundryConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
  model: string;
  promptVersion: string;
}

type PostOutcome =
  | { outcome: 'completed'; post_uri: string }
  | { outcome: 'failed'; post_uri: string; error: string }
  | { outcome: 'skipped'; post_uri: string; reason: string };

// Processes exactly one already-selected, already-claimed post: calls
// Foundry, validates the structured response, and persists the result.
// The (post_uri, prompt_version) row must already exist with
// status='processing' (claimed via unique-constraint insert by the caller)
// before this is invoked, so a failure here never leaves an unclaimed slot.
export async function processClaimedPost(
  supabase: ReturnType<typeof createClient>,
  config: FoundryConfig,
  post: EligiblePost,
): Promise<PostOutcome> {
  const { endpoint, apiKey, deployment, model, promptVersion } = config;
  const foundryResult = await callFoundry({
    endpoint, apiKey, deployment, model,
    postText: post.post_text,
    originalLanguage: post.original_language,
  });
  if (!foundryResult.ok) {
    await supabase
      .from('post_analyses_v2')
      .update({ status: 'failed', error_message: foundryResult.error.slice(0, 500), updated_at: new Date().toISOString() })
      .eq('post_uri', post.uri)
      .eq('prompt_version', promptVersion);
    return { outcome: 'failed', post_uri: post.uri, error: foundryResult.error };
  }

  const validation = validateAnalysisResponse(foundryResult.raw);
  if (!validation.ok) {
    await supabase
      .from('post_analyses_v2')
      .update({ status: 'failed', error_message: validation.error.slice(0, 500), updated_at: new Date().toISOString() })
      .eq('post_uri', post.uri)
      .eq('prompt_version', promptVersion);
    return { outcome: 'failed', post_uri: post.uri, error: validation.error };
  }

  const { value } = validation;
  const { error: updateError } = await supabase
    .from('post_analyses_v2')
    .update({
      provider: 'azure_foundry',
      deployment,
      model,
      sentiment: value.sentiment,
      sentiment_score: value.sentiment_score,
      emotions: value.emotions,
      topics: value.topics,
      tools_mentioned: value.tools_mentioned,
      ai_tooling_stance: value.ai_tooling_stance,
      confidence: value.confidence,
      rationale: value.rationale,
      status: 'complete',
      processed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      error_message: null,
    })
    .eq('post_uri', post.uri)
    .eq('prompt_version', promptVersion);

  if (updateError) {
    return { outcome: 'failed', post_uri: post.uri, error: updateError.message };
  }

  return { outcome: 'completed', post_uri: post.uri };
}

// Attempts to claim exactly one post (via the (post_uri, prompt_version)
// uniqueness constraint) and, if claimed, process it. Returns null if the
// post could not be claimed (already claimed by a concurrent/prior call).
export async function claimAndProcess(
  supabase: ReturnType<typeof createClient>,
  config: FoundryConfig,
  post: EligiblePost,
): Promise<PostOutcome | null> {
  const { error: claimError } = await supabase
    .from('post_analyses_v2')
    .insert({ post_uri: post.uri, prompt_version: config.promptVersion, status: 'processing' });
  if (claimError) {
    // Unique violation means another invocation already claimed this slot.
    return null;
  }
  return await processClaimedPost(supabase, config, post);
}

export interface BatchSummary {
  selected: number;
  completed: number;
  failed: number;
  scanned: number;
  results: PostOutcome[];
}

// Batched automatic selection. Candidate selection is delegated to the
// select_unanalysed_posts database function, which anti-joins post_analyses_v2
// and returns only posts that have never received a V2 analysis, oldest first.
// Filtering server-side keeps the cost of an invocation proportional to
// the batch size rather than to the size of the already-analysed backlog, and
// removes the need for any client-side scan bound: a bounded scan-and-skip
// loop would silently stall the pipeline once the analysed backlog exceeded
// the bound.
//
// Posts are still claimed and processed one at a time, so Foundry calls remain
// sequential and capped at batchSize per invocation.
export async function runBatch(
  supabase: ReturnType<typeof createClient>,
  config: FoundryConfig,
  batchSize: number,
): Promise<BatchSummary | { error: string }> {
  let selected = 0;
  let completed = 0;
  let failed = 0;
  let scanned = 0;
  const results: PostOutcome[] = [];

  // Over-fetch slightly so that posts claimed by a concurrent invocation
  // between selection and claiming do not leave the batch short.
  const { data: candidatePosts, error: candidateError } = await supabase.rpc('select_unanalysed_posts', {
    p_prompt_version: config.promptVersion,
    p_limit: batchSize * CANDIDATE_OVERFETCH_MULTIPLIER,
  });

  if (candidateError) return { error: candidateError.message };

  for (const candidate of (candidatePosts ?? []) as EligiblePost[]) {
    if (selected >= batchSize) break;
    scanned += 1;

    const result = await claimAndProcess(supabase, config, candidate);
    if (!result) continue; // Claimed concurrently between selection and insert; does not count toward the batch.
    selected += 1;
    results.push(result);
    if (result.outcome === 'completed') completed += 1;
    else if (result.outcome === 'failed') failed += 1;
  }

  return { selected, completed, failed, scanned, results };
}

// Resolves the single authoritative active V2 prompt version from the
// database (public.get_active_prompt_version(), see migration
// 20260904090000_active_prompt_version_contract.sql) rather than treating
// the LLM_PROMPT_VERSION Edge Function secret as an independent, potentially
// diverging source of truth.
//
// LLM_PROMPT_VERSION is retained only as a transitional deployment-safety
// check: if it is still set, it must agree with the database value, or the
// worker fails closed (does not claim or process any posts) rather than
// silently processing under one version while the dashboard/Data Review
// display another. Once all environments have migrated, the env var can be
// removed entirely and this check becomes a no-op.
export async function resolveActivePromptVersion(
  supabase: ReturnType<typeof createClient>,
): Promise<{ promptVersion: string } | { error: string }> {
  const { data, error } = await supabase.rpc('get_active_prompt_version');
  if (error) return { error: `Failed to resolve active prompt version: ${error.message}` };
  const dbPromptVersion = typeof data === 'string' ? data : null;
  if (!dbPromptVersion) return { error: 'Active prompt version is not configured in the database' };

  const legacyEnvPromptVersion = Deno.env.get('LLM_PROMPT_VERSION');
  if (legacyEnvPromptVersion && legacyEnvPromptVersion !== dbPromptVersion) {
    return {
      error: `Prompt version mismatch: LLM_PROMPT_VERSION ('${legacyEnvPromptVersion}') does not match the authoritative database value ('${dbPromptVersion}'). Refusing to process to avoid a worker/dashboard divergence.`,
    };
  }

  return { promptVersion: dbPromptVersion };
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST' || request.headers.get('x-ingestion-secret') !== Deno.env.get('INGESTION_SECRET')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  if (Deno.env.get('LLM_PROCESSING_ENABLED') !== 'enabled') {
    return new Response(JSON.stringify({ selected: 0, completed: 0, failed: 0, skipped: 'processing disabled' }), { headers: corsHeaders });
  }

  const endpoint = Deno.env.get('AZURE_FOUNDRY_ENDPOINT');
  const apiKey = Deno.env.get('AZURE_FOUNDRY_API_KEY');
  const deployment = Deno.env.get('AZURE_FOUNDRY_DEPLOYMENT');
  const model = Deno.env.get('AZURE_FOUNDRY_MODEL');
  if (!endpoint || !apiKey || !deployment || !model) {
    return new Response(JSON.stringify({ error: 'Foundry configuration is missing' }), { status: 500, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !supabaseServiceKey) {
    return new Response(JSON.stringify({ error: 'Supabase configuration is missing' }), { status: 500, headers: corsHeaders });
  }
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const promptVersionResult = await resolveActivePromptVersion(supabase);
  if ('error' in promptVersionResult) {
    return new Response(JSON.stringify({ error: promptVersionResult.error }), { status: 500, headers: corsHeaders });
  }
  const promptVersion = promptVersionResult.promptVersion;
  const config: FoundryConfig = { endpoint, apiKey, deployment, model, promptVersion };

  let requestedUri: string | null = null;
  try {
    const requestBody = await request.json().catch(() => ({}));
    if (typeof requestBody?.post_uri === 'string' && requestBody.post_uri.length > 0) {
      requestedUri = requestBody.post_uri;
    }
  } catch {
    // No body / invalid JSON is fine; falls back to automatic batch selection.
  }

  // Explicit post_uri: preserve single-post manual behavior (bypasses batching).
  if (requestedUri) {
    const { data: post, error: postError } = await supabase
      .from('bluesky_posts')
      .select('uri, post_text, original_language')
      .eq('uri', requestedUri)
      .maybeSingle();
    if (postError || !post) {
      return new Response(JSON.stringify({ selected: 0, completed: 0, failed: 0, error: 'Requested post_uri not found' }), { status: 404, headers: corsHeaders });
    }
    const { data: existing } = await supabase
      .from('post_analyses_v2')
      .select('id')
      .eq('post_uri', requestedUri)
      .maybeSingle();
    if (existing) {
      return new Response(JSON.stringify({ selected: 0, completed: 0, failed: 0, skipped: 'post already has a V2 analysis' }), { headers: corsHeaders });
    }

    const result = await claimAndProcess(supabase, config, post as EligiblePost);
    if (!result) {
      return new Response(JSON.stringify({ selected: 0, completed: 0, failed: 0, skipped: 'post already has a V2 analysis' }), { headers: corsHeaders });
    }
    if (result.outcome === 'completed') {
      return new Response(JSON.stringify({ selected: 1, completed: 1, failed: 0, post_uri: result.post_uri }), { headers: corsHeaders });
    }
    return new Response(JSON.stringify({ selected: 1, completed: 0, failed: 1, error: (result as { error: string }).error }), { headers: corsHeaders });
  }

  const batchResult = await runBatch(supabase, config, resolveBatchSize());
  if ('error' in batchResult) {
    return new Response(JSON.stringify({ error: batchResult.error }), { status: 500, headers: corsHeaders });
  }
  const { selected, completed, failed, scanned, results } = batchResult;

  if (selected === 0) {
    return new Response(JSON.stringify({ selected: 0, completed: 0, failed: 0, scanned, skipped: 'no eligible post found' }), { headers: corsHeaders });
  }

  return new Response(JSON.stringify({ selected, completed, failed, scanned, results }), { headers: corsHeaders });
}

// Only start the server when run directly by the Supabase Edge Runtime,
// not when this module is imported for unit testing.
if (import.meta.main) {
  Deno.serve(handleRequest);
}
