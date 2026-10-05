import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { collectionLimits, hasUsefulText, isRecent, searchPlan } from '../_shared/costControls.ts';
import { databaseFetch, renewLease, withPipelineLease } from '../_shared/workerLease.ts';

const SEARCH_TERMS = [
  'artificial intelligence',
  'generative AI',
  'LLM',
  'AI model',
  'AGI',
  'OpenAI',
  'Anthropic',
  'Google DeepMind',
  'Meta AI',
  'xAI',
  'DeepSeek',
  'Mistral AI',
  'Hugging Face',
  'NVIDIA',
  'ChatGPT',
  'GPT-6 Astra',
  'Claude',
  'Claude Fable',
  'Claude Fable 5.1',
  'Gemini',
  'Gemini 3.8',
  'Copilot',
  'Perplexity',
  'Grok',
  'Cursor',
  'Windsurf',
  'Claude Code',
  'AI coding',
  'coding agent',
  'vibe coding',
  'AI agent',
  'agentic AI',
  'autonomous agent',
  'MCP',
  'Model Context Protocol',
  'Llama',
  'Llama 5',
  'Mistral',
  'Qwen',
  'AI safety',
  'AI regulation',
  'AI ethics',
  'AI governance',
  'AI copyright',
  'robotics',
  'humanoid robot',
  'Tesla Optimus',
  'Figure AI',
  'multimodal AI',
  'Stable Diffusion',
  'DALL-E',
  'video generation',
  'image generation',
  'AI jobs',
  'AI research',
  'AI healthcare',
  'AI education',
  'open source AI',
];
const corsHeaders = { 'Content-Type': 'application/json' };

interface SearchPost {
  uri?: string;
  author?: { handle?: string };
  record?: { text?: string; langs?: string[]; createdAt?: string };
  indexedAt?: string;
}

export function prepareRows(posts: SearchPost[], maximum: number, now = Date.now()) {
  const rows = new Map<string, {
    uri: string; author_handle: string; post_text: string; original_language: string | null;
    published_at: string; source_url: string;
  }>();
  for (const post of posts) {
    const text = post.record?.text?.replace(/\s+/g, ' ').trim();
    const rkey = post.uri?.split('/').at(-1);
    const publishedAt = post.record?.createdAt || post.indexedAt;
    if (!post.uri || !text || !hasUsefulText(text) || !post.author?.handle || !rkey || !isRecent(publishedAt, now)) continue;
    if (rows.has(post.uri)) continue;
    rows.set(post.uri, {
      uri: post.uri, author_handle: post.author.handle, post_text: text,
      original_language: post.record?.langs?.[0] ?? null,
      published_at: publishedAt!,
      source_url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
    });
    if (rows.size >= maximum) break;
  }
  return [...rows.values()];
}

export async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST' || request.headers.get('x-ingestion-secret') !== Deno.env.get('INGESTION_SECRET')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  const handle = Deno.env.get('BLUESKY_HANDLE');
  const appPassword = Deno.env.get('BLUESKY_APP_PASSWORD');
  if (!handle || !appPassword) {
    return new Response(JSON.stringify({ error: 'Bluesky credentials are not configured' }), { status: 500, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Supabase configuration is missing' }), { status: 500, headers: corsHeaders });
  }
  const supabase = createClient(supabaseUrl, serviceKey, { global: { fetch: databaseFetch } });
  const limits = collectionLimits((name) => Deno.env.get(name));
  return withPipelineLease(supabase, 'bluesky_ingestion', limits.intervalMinutes * 60, async (lease) => {
  try {
    if (!await renewLease(supabase, lease)) throw new Error('Worker lease lost');
    const sessionResponse = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: handle, password: appPassword }),
    });
    if (!sessionResponse.ok) {
      return new Response(JSON.stringify({ error: `Bluesky session request failed: ${sessionResponse.status}` }), { status: 502, headers: corsHeaders });
    }
    const { accessJwt } = await sessionResponse.json();

    const plan = searchPlan(SEARCH_TERMS, limits);
    const since = new Date(Date.now() - limits.intervalMinutes * 60_000).toISOString();
    const results = await Promise.allSettled(plan.map(async ({ term, limit }) => {
      const parameters = new URLSearchParams({ q: term, limit: String(limit), sort: 'latest', since });
      const response = await fetch(`https://bsky.social/xrpc/app.bsky.feed.searchPosts?${parameters}`, {
        signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${accessJwt}` },
      });
      if (!response.ok) throw new Error(`Search for ${term} failed: ${response.status}`);
      const result = await response.json();
      return (Array.isArray(result.posts) ? result.posts.slice(0, limit) : []) as SearchPost[];
    }));

    const failedSearches = results.filter((result) => result.status === 'rejected').length;
    if (failedSearches === plan.length) {
      return new Response(JSON.stringify({ error: 'All Bluesky searches failed' }), { status: 502, headers: corsHeaders });
    }
    const rows = prepareRows(results.flatMap((result) => result.status === 'fulfilled' ? result.value : []), limits.postsPerRun);

    const { error } = rows.length
      ? await supabase.rpc('ingest_posts_fenced', { p_owner: lease.owner, p_fence: lease.fence, p_rows: rows })
      : { error: null };
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
    }
    return new Response(JSON.stringify({ searchedTerms: plan.length, failedSearches, candidates: rows.length }), { headers: corsHeaders });
  } catch {
    return new Response(JSON.stringify({ error: 'Bluesky collection failed or timed out' }), { status: 502, headers: corsHeaders });
  }
  });
}

if (import.meta.main) Deno.serve(handleRequest);
