import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SEARCH_TERMS = ['copilot', 'cursor', '"claude code"', 'windsurf', '"vibe coding"', '"ai coding"'];
const POSTS_PER_TERM = 25;
const corsHeaders = { 'Content-Type': 'application/json' };

function containsTerm(text: string, term: string) {
  return text.toLowerCase().includes(term.toLowerCase());
}

function analysePost(text: string) {
  const positiveTerms = ['advance', 'improve', 'safe', 'accessible', 'benefit', 'progress'];
  const negativeTerms = ['risk', 'harm', 'threat', 'outage', 'concern', 'failure', 'critical'];
  const topicTerms = [
    ['AI coding', ['copilot', 'cursor', 'claude code', 'windsurf', 'vibe coding', 'ai coding']],
    ['AI safety', ['safety', 'safe', 'risk', 'harm']],
    ['Model evaluation', ['evaluation', 'benchmark', 'capability', 'model']],
  ] as const;
  const matchedPositive = positiveTerms.filter((term) => containsTerm(text, term));
  const matchedNegative = negativeTerms.filter((term) => containsTerm(text, term));
  const score = Math.max(0, Math.min(100, 50 + matchedPositive.length * 8 - matchedNegative.length * 10));
  const leadingTopic = topicTerms
    .map(([name, terms]) => [name, terms.filter((term) => containsTerm(text, term))] as const)
    .sort((first, second) => second[1].length - first[1].length)[0];
  const topic = leadingTopic?.[0] ?? 'General AI';
  const topicMatches = leadingTopic?.[1] ?? [];
  const evidence = [
    ...matchedPositive.map((term) => `positive: ${term}`),
    ...matchedNegative.map((term) => `negative: ${term}`),
    ...topicMatches.map((term) => `topic: ${term}`),
  ];
  return {
    sentiment_score: score,
    sentiment_label: score >= 75 ? 'Very positive' : score >= 60 ? 'Positive' : score >= 45 ? 'Mixed' : score >= 25 ? 'Negative' : 'Very negative',
    mood: score >= 60 ? 'Upbeat' : score <= 40 ? 'Downbeat' : 'Mixed',
    emotion: topic === 'AI safety' ? 'Caution' : topic === 'Model evaluation' ? 'Curiosity' : topic === 'AI coding' ? 'Excitement' : 'Neutral',
    topic,
    rule_evidence: evidence.length ? evidence.join('; ') : 'No configured rule matched',
  };
}

Deno.serve(async (request) => {
  if (request.method !== 'POST' || request.headers.get('x-ingestion-secret') !== Deno.env.get('INGESTION_SECRET')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
  }

  const handle = Deno.env.get('BLUESKY_HANDLE');
  const appPassword = Deno.env.get('BLUESKY_APP_PASSWORD');
  if (!handle || !appPassword) {
    return new Response(JSON.stringify({ error: 'Bluesky credentials are not configured' }), { status: 500, headers: corsHeaders });
  }

  const sessionResponse = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
  });
  if (!sessionResponse.ok) {
    return new Response(JSON.stringify({ error: `Bluesky session request failed: ${sessionResponse.status}` }), { status: 502, headers: corsHeaders });
  }
  const { accessJwt } = await sessionResponse.json();

  const results = await Promise.all(SEARCH_TERMS.map(async (term) => {
    const parameters = new URLSearchParams({ q: term.replaceAll('"', ''), limit: String(POSTS_PER_TERM), sort: 'latest' });
    const response = await fetch(`https://bsky.social/xrpc/app.bsky.feed.searchPosts?${parameters}`, {
      headers: { Authorization: `Bearer ${accessJwt}` },
    });
    if (!response.ok) throw new Error(`Search for ${term} failed: ${response.status}`);
    return response.json();
  }));

  const rows = [...new Map(results.flatMap((result) => result.posts || []).map((post) => {
    const text = post.record?.text?.replace(/\s+/g, ' ').trim();
    const rkey = post.uri?.split('/').at(-1);
    if (!post.uri || !text || !post.author?.handle || !rkey) return [post.uri, null];
    return [post.uri, {
      uri: post.uri,
      author_handle: post.author.handle,
      post_text: text,
      original_language: post.record?.langs?.[0] ?? null,
      published_at: post.record.createdAt || post.indexedAt,
      source_url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
      ...analysePost(text),
    }];
  })).values()].filter(Boolean);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { error } = await supabase.from('bluesky_posts').upsert(rows, { onConflict: 'uri', ignoreDuplicates: true });
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
  return new Response(JSON.stringify({ searchedTerms: SEARCH_TERMS.length, candidates: rows.length }), { headers: corsHeaders });
});
