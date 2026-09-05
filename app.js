// The dashboard aggregates the full archive; the filter controls were removed.
const state = { time: 'all', emotion: 'all', topic: 'all' };
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US');
const ARCHIVE_REFRESH_MS = 5 * 60 * 1000;
const SUPABASE_URL = 'https://bsnzcspfrmlihwxqkjyv.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_JXgoo-lTxuflm4CakgfuTQ_IH3AZ6V9';
const bluesky = { posts: [], allPosts: [], isLoading: false, error: '', totalCount: 0 };
const blueskyV2 = { posts: [], isLoading: false, error: '', totalCount: 0 };
// Dedicated dataset for the main Dashboard/map view, sourced from
// completed_post_analyses_v2 (Foundry). Fully independent from `bluesky`/
// `blueskyV2`, which continue to back the Data review tab's Legacy/V2 toggle.
const dashboardV2 = { allPosts: [], isLoading: false, error: '', totalCount: 0, lastLoadedAt: null };
const REVIEW_PAGE_SIZE = 100;
let reviewPage = 1;
let reviewSource = 'v2'; // 'legacy' | 'v2' -- Latest model (Foundry) is the default on open
let expandedReviewRow = null; // post_uri of the record whose analysis details are open
let reviewSearchTerm = ''; // server-side search term, applied across the full archive
let activeView = 'dashboard';

// Utility functions
function sentimentClass(score) { return score >= 60 ? 'positive' : score >= 45 ? 'mixed' : 'negative'; }
// Sentiment drives a continuous red -> white -> green ramp so the number
// itself carries the meaning without any surrounding chart furniture.
function scoreColor(score) {
  const clamped = Math.max(0, Math.min(100, Number(score) || 0));
  const mix = (from, to, t) => from.map((channel, index) => Math.round(channel + (to[index] - channel) * t));
  const red = [220, 38, 38];
  const white = [245, 245, 245];
  const green = [16, 185, 129];
  const rgb = clamped <= 50
    ? mix(red, white, clamped / 50)
    : mix(white, green, (clamped - 50) / 50);
  return `rgb(${rgb.join(' ')})`;
}
function escapeHtml(value) {
  const element = document.createElement('span');
  element.textContent = value;
  return element.innerHTML;
}
function matchesTerm(text, term) {
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escapedTerm}\\b`, 'i').test(text);
}
function formatTimestamp(value) {
  return new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
}
// Canonical V2 sentiment_score is [-1, 1]; display convention: displayScore = round((score + 1) * 50).
function v2DisplayScore(sentimentScore) {
  return sentimentScore === null || sentimentScore === undefined
    ? 0
    : Math.round((sentimentScore + 1) * 50);
}
function aiStanceLabel(stance) {
  return stance === 'not_applicable' || !stance ? 'N/A' : humanizeLabel(stance);
}
// Convert internal snake_case/kebab-case taxonomy labels (topics, stances, etc.)
// into human-readable, sentence-cased text for display.
function humanizeLabel(value) {
  if (!value) return value;
  const spaced = String(value).replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
function timeAgoLabel(date) {
  if (!date) return '';
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatTimeSinceRefresh(lastRefreshTime) {
  const refreshTime = new Date(lastRefreshTime).getTime();
  if (!Number.isFinite(refreshTime)) return 'Updated recently';
  const diffMs = Math.max(0, Date.now() - refreshTime);
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  if (diffMins < 1) return 'Updated just now';
  if (diffMins < 60) return `Updated ${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `Updated ${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  return 'Updated recently';
}

function updateFreshnessLabel(lastRefreshTime, sampleCount) {
  const label = document.querySelector('.data-freshness');
  if (!label) return;
  const safeCount = Number.isFinite(Number(sampleCount)) ? number.format(Number(sampleCount)) : '0';
  label.textContent = `${formatTimeSinceRefresh(lastRefreshTime)} • Based on ${safeCount} analysed posts`;
}

/**
 * Map persisted analysis data from Supabase to post object
 * Converts score from 0-1 to 0-100 range
 */
function postFromArchive(row) {
  const analysis = row.completed_post_analyses || {};
  
  // Convert numeric score (0-1) to 0-100 for dashboard
  const scorePercent = analysis.score !== null && analysis.score !== undefined 
    ? Math.round(analysis.score * 100) 
    : 0;
  
  // Map sentiment enum to label for consistency
  const sentimentLabel = {
    'positive': 'Very positive',
    'negative': 'Very negative',
    'neutral': 'Mixed',
    'mixed': 'Mixed',
  }[analysis.sentiment] || 'Unknown';
  
  return {
    uri: row.uri,
    text: row.post_text,
    author: row.author_handle,
    originalLanguage: row.original_language,
    timestamp: formatTimestamp(row.published_at),
    publishedAt: row.published_at,
    url: row.source_url,
    // Persisted LLM analysis fields
    score: scorePercent,
    sentiment: sentimentLabel,
    emotions: analysis.emotions || [],
    topics: analysis.topics || [],
    ai_stance: analysis.ai_tooling_stance || 'unknown',
    confidence: analysis.confidence || 0,
    rationale: analysis.rationale || '',
    model_version: analysis.model || 'unknown',
    prompt_version: analysis.prompt_version || 'unknown',
  };
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('Invalid archive array:', error);
    return [];
  }
}



function periodAverageScore(hours, offsetHours) {
  const end = Date.now() - offsetHours * 60 * 60 * 1000;
  const start = end - hours * 60 * 60 * 1000;
  const posts = dashboardV2.allPosts.filter((post) => {
    const t = new Date(post.publishedAt || post.timestamp).getTime();
    return !Number.isNaN(t) && t >= start && t < end;
  });
  if (!posts.length) return null;
  return Math.round(posts.reduce((sum, post) => sum + post.score, 0) / posts.length);
}

function archiveDashboardData({ time = 'all', emotion = 'all', topic = 'all' } = {}) {
  const hours = { '1h': 1, '24h': 24, '7d': 24 * 7 }[time] || null;
  const cutoff = hours ? Date.now() - hours * 60 * 60 * 1000 : null;
  const recentPosts = cutoff === null ? dashboardV2.allPosts : dashboardV2.allPosts.filter((post) => {
    const publishedAt = new Date(post.publishedAt || post.timestamp).getTime();
    return Number.isNaN(publishedAt) || publishedAt >= cutoff;
  });

  const filteredPosts = recentPosts.filter((post) => {
    const postTopics = parseArray(post.topics);
    const postEmotions = parseArray(post.emotions).map((item) => typeof item === 'string' ? item : item.label);
    return (emotion === 'all' || postEmotions.includes(emotion))
      && (topic === 'all' || postTopics.includes(topic));
  });
  const posts = filteredPosts;
  const average = (values) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  const score = average(posts.map((post) => post.score));
  const confidence = average(posts.map((post) => post.confidence * 100));
  // Movement vs the immediately preceding period of equal length, computed
  // over the full (unfiltered) dataset so the cue reflects overall momentum
  // rather than the currently selected emotion/topic slice. Not meaningful
  // when the whole archive is in scope.
  const prevScore = hours ? periodAverageScore(hours, hours) : null;
  const delta = prevScore === null || !posts.length ? null : score - prevScore;
  const emotionCounts = new Map();
  posts.forEach((post) => parseArray(post.emotions).forEach((item) => {
    const name = typeof item === 'string' ? item : item.label;
    if (name) emotionCounts.set(name, (emotionCounts.get(name) || 0) + 1);
  }));
  // Raw counts are passed through so the renderer can normalise once, after it
  // has dropped the emotions it ignores.
  const emotions = [...emotionCounts.entries()]
    .map(([name, count]) => [name, count])
    .sort((first, second) => second[1] - first[1]);
  const topicMap = new Map();
  posts.forEach((post) => parseArray(post.topics).forEach((name) => {
    const entry = topicMap.get(name) || { scores: [], volume: 0 };
    entry.scores.push(post.score);
    entry.volume += 1;
    topicMap.set(name, entry);
  }));
  const topics = [...topicMap.entries()].map(([name, entry]) => {
    const sentiment = average(entry.scores);
    return { id: name, name: humanizeLabel(name), volume: entry.volume, sentiment, emotion: '', impact: Number((sentiment - score).toFixed(1)), lowSample: entry.volume < 3 };
  }).sort((first, second) => second.volume - first.volume);
  // Prefer the most common *meaningful* stance classification; only fall back
  // to not_applicable if there is no applicable stance in the selection at all.
  const stanceCounts = new Map();
  posts.forEach((post) => stanceCounts.set(post.ai_stance, (stanceCounts.get(post.ai_stance) || 0) + 1));
  const meaningfulStances = [...stanceCounts.entries()].filter(([name]) => name && name !== 'not_applicable');
  const stance = (meaningfulStances.length ? meaningfulStances : [...stanceCounts.entries()])
    .sort((first, second) => second[1] - first[1])[0];
  const selectedTopic = topics.find((item) => item.id === topic);
  return {
    score,
    prevScore,
    delta,
    items: posts.length,
    confidence: confidence ? `${confidence}%` : 'N/A',
    emotions,
    topics,
    selectedTopic,
    selectedEmotion: emotions.find(([name]) => name === emotion),
    stance: stance ? (stance[0] === 'not_applicable' ? 'N/A' : `${humanizeLabel(stance[0])} (${stance[1]})`) : 'N/A',
    stanceCount: stance ? stance[1] : 0,
    posts,
  };
}

// Hourly sentiment series keyed strictly on the source post's publication time
// (published_at), never on processed_at/created_at, which can trail publication
// by a day or more. Records without a valid publication time are excluded from
// the trend rather than being bucketed against a substitute timestamp.
// Buckets holding fewer than MIN_BUCKET_POSTS are returned with a null score so
// the chart breaks the line instead of drawing a swing from one or two posts as
// though it were a trend.
const HOUR_MS = 60 * 60 * 1000;
const MIN_BUCKET_POSTS = 3;

function trendSeries({ topic = 'all' } = {}) {
  const rows = [];
  dashboardV2.allPosts.forEach((post) => {
    if (topic !== 'all' && !parseArray(post.topics).includes(topic)) return;
    if (!post.publishedAt) return;
    const time = new Date(post.publishedAt).getTime();
    if (!Number.isNaN(time)) rows.push({ time, score: post.score });
  });
  if (!rows.length) return { points: [], score: null, items: 0 };

  const buckets = new Map();
  rows.forEach(({ time, score }) => {
    const key = Math.floor(time / HOUR_MS);
    const entry = buckets.get(key) || { total: 0, count: 0 };
    entry.total += score;
    entry.count += 1;
    buckets.set(key, entry);
  });

  // The archive is front-loaded with backfill, so anchoring the axis to the
  // full span would leave the line crushed against one edge. Start at the first
  // bucket that begins a *sustained* run, so an isolated early reading cannot
  // strand a dot behind a long gap or distort the period movement.
  const keys = [...buckets.keys()].sort((first, second) => first - second);
  const isSolid = (key) => buckets.has(key) && buckets.get(key).count >= MIN_BUCKET_POSTS;
  const sustained = keys.find((key) => isSolid(key) && isSolid(key + 1));
  const anySolid = keys.find(isSolid);
  const start = sustained !== undefined ? sustained : (anySolid === undefined ? keys[0] : anySolid);
  const end = keys[keys.length - 1];

  const points = [];
  for (let key = start; key <= end; key += 1) {
    const entry = buckets.get(key);
    const solid = entry && entry.count >= MIN_BUCKET_POSTS;
    points.push({
      start: key * HOUR_MS,
      count: entry ? entry.count : 0,
      score: solid ? Math.round(entry.total / entry.count) : null,
    });
  }
  // Report over the charted window so the headline number and the line agree.
  const windowRows = rows.filter((row) => Math.floor(row.time / HOUR_MS) >= start);
  const items = windowRows.length || rows.length;
  const source = windowRows.length ? windowRows : rows;
  const score = Math.round(source.reduce((sum, row) => sum + row.score, 0) / items);
  return { points, score, items };
}

/**
 * Build a PostgREST `or=(...)` filter that matches a search term against
 * post_text, author_handle, and topics (JSONB array of strings/objects),
 * so search runs across the full archive at the database level instead of
 * only the currently loaded page.
 */
function buildReviewSearchFilter(term) {
  const trimmed = term.trim();
  if (!trimmed) return '';
  // Escape characters that are meaningful to PostgREST's filter syntax
  // (comma, parentheses) since they would otherwise break the or=(...) list.
  const escaped = trimmed.replace(/[,()]/g, '\\$&');
  const likeValue = `*${escaped}*`;
  return `or=(post_text.ilike.${likeValue},author_handle.ilike.${likeValue},topics.cs.["${escaped}"])`;
}

async function requestArchive(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`Archive returned ${response.status}`);
  if (response.status === 201 || response.status === 204 || response.headers.get('content-length') === '0') {
    return { data: null, totalCount: 0 };
  }
  const data = await response.json();
  const contentRange = response.headers.get('content-range'); // e.g. "0-99/955"
  const totalCount = contentRange ? Number(contentRange.split('/')[1]) : data.length;
  return { data, totalCount };
}
/**
 * Load completed post analyses from Supabase
 * Queries completed_post_analyses view joined with bluesky_posts
 */
async function loadArchive(page = reviewPage, searchTerm = reviewSearchTerm) {
  try {
    bluesky.isLoading = true;
    renderBlueskyStatus();
    renderDataReview();

    reviewPage = page;
    const from = (page - 1) * REVIEW_PAGE_SIZE;
    const to = from + REVIEW_PAGE_SIZE - 1;

    // Query completed_post_analyses view with exact count + range-based pagination.
    // The search filter is applied at the database level (via PostgREST's
    // or=(...) filter), so matches are found across the full archive rather
    // than only the currently loaded page.
    const searchFilter = buildReviewSearchFilter(searchTerm);
    const query = searchFilter
      ? `completed_post_analyses?order=created_at.desc&${searchFilter}`
      : `completed_post_analyses?order=created_at.desc`;
    const { data: analyses, totalCount } = await requestArchive(
      query,
      {
        headers: {
          Prefer: 'count=exact',
          Range: `${from}-${to}`,
        },
      }
    );

    bluesky.totalCount = totalCount;

    if (!analyses || analyses.length === 0) {
      bluesky.error = searchTerm.trim()
        ? `No posts match "${searchTerm.trim()}".`
        : 'No completed analyses yet. Check back soon.';
      bluesky.posts = [];
    } else {
      // For each analysis, we need to fetch the post details from bluesky_posts
      const mappedPosts = analyses.map(analysis => ({
        // Post metadata from completed_post_analyses
        uri: analysis.post_uri,
        score: Math.round((analysis.score || 0) * 100),
        sentiment: {
          'positive': 'Very positive',
          'negative': 'Very negative', 
          'neutral': 'Mixed',
          'mixed': 'Mixed',
        }[analysis.sentiment] || 'Unknown',
        confidence: (analysis.confidence || 0), // Keep as 0-1, renderDataReview will format
        emotions: parseArray(analysis.emotions),
        topics: parseArray(analysis.topics),
        ai_stance: analysis.ai_tooling_stance || 'not_applicable',
        rationale: analysis.rationale || '',
        model: analysis.model || 'unknown',
        timestamp: formatTimestamp(analysis.created_at),
        publishedAt: analysis.published_at || analysis.created_at,
        url: analysis.source_url,
        
        // Post details from bluesky_posts (via JOIN in completed_post_analyses view)
        text: analysis.post_text || '(post text unavailable)',
        author: analysis.author_handle || 'unknown',
        originalLanguage: analysis.original_language || 'unknown',
      }));
      bluesky.posts = mappedPosts;
      bluesky.error = '';
    }
  } catch (error) {
    bluesky.error = `Failed to load archive: ${error.message}`;
    console.error('Archive load error:', error);
  } finally {
    bluesky.isLoading = false;
    renderBlueskyStatus();
    renderDashboard(selectedData());
    renderDataReview();
  }
}

/**
 * Load completed V2 (Foundry) post analyses from Supabase, for the Data
 * review tab only. Fully isolated from the legacy `bluesky` state and from
 * the main Dashboard/map aggregation, which always uses the legacy source.
 */
async function loadArchiveV2(page = reviewPage, searchTerm = reviewSearchTerm) {
  try {
    blueskyV2.isLoading = true;
    renderDataReview();

    reviewPage = page;
    const from = (page - 1) * REVIEW_PAGE_SIZE;
    const to = from + REVIEW_PAGE_SIZE - 1;

    // V2 default ordering: most recently analyzed first, for validation.
    // The search filter is applied at the database level so matches are
    // found across the full archive rather than only the loaded page.
    const searchFilter = buildReviewSearchFilter(searchTerm);
    const query = searchFilter
      ? `completed_post_analyses_v2?order=processed_at.desc,published_at.desc&${searchFilter}`
      : `completed_post_analyses_v2?order=processed_at.desc,published_at.desc`;
    const { data: analyses, totalCount } = await requestArchive(
      query,
      {
        headers: {
          Prefer: 'count=exact',
          Range: `${from}-${to}`,
        },
      }
    );

    blueskyV2.totalCount = totalCount;

    if (!analyses || analyses.length === 0) {
      blueskyV2.error = searchTerm.trim()
        ? `No posts match "${searchTerm.trim()}".`
        : 'No completed V2 analyses yet. Check back soon.';
      blueskyV2.posts = [];
    } else {
      blueskyV2.posts = analyses.map((analysis) => ({
        uri: analysis.post_uri,
        displayScore: v2DisplayScore(analysis.sentiment_score),
        sentimentScore: analysis.sentiment_score,
        sentiment: analysis.sentiment || 'unknown',
        confidence: analysis.confidence || 0,
        emotions: parseArray(analysis.emotions),
        topics: parseArray(analysis.topics),
        toolsMentioned: parseArray(analysis.tools_mentioned),
        aiStance: analysis.ai_tooling_stance,
        rationale: analysis.rationale || '',
        provider: analysis.provider || 'unknown',
        deployment: analysis.deployment || 'unknown',
        model: analysis.model || 'unknown',
        promptVersion: analysis.prompt_version || 'unknown',
        processedAt: analysis.processed_at,
        publishedAt: analysis.published_at,
        timestamp: formatTimestamp(analysis.published_at),
        processedTimestamp: analysis.processed_at ? formatTimestamp(analysis.processed_at) : 'N/A',
        url: analysis.source_url,
        text: analysis.post_text || '(post text unavailable)',
        author: analysis.author_handle || 'unknown',
        originalLanguage: analysis.original_language || 'unknown',
      }));
      blueskyV2.error = '';
    }
  } catch (error) {
    blueskyV2.error = `Failed to load V2 archive: ${error.message}`;
    console.error('V2 archive load error:', error);
  } finally {
    blueskyV2.isLoading = false;
    renderDataReview();
  }
}

/** Dispatch archive loading to the currently selected review source. */
async function loadReviewData(page = reviewPage, searchTerm = reviewSearchTerm) {
  if (reviewSource === 'v2') {
    await loadArchiveV2(page, searchTerm);
  } else {
    await loadArchive(page, searchTerm);
  }
}

/**
 * Load the full completed_post_analyses_v2 (Foundry) archive for the main
 * Dashboard/map view. This is now the default/sole source for the dashboard
 * aggregation; the Data review tab's Legacy/V2 toggle remains independent.
 */
async function loadDashboardV2() {
  try {
    dashboardV2.isLoading = true;
    renderBlueskyStatus();

    const allAnalyses = [];
    const pageSize = 1000;
    let offset = 0;
    let page;
    let totalCount = 0;
    do {
      const result = await requestArchive(
        `completed_post_analyses_v2?order=processed_at.desc&limit=${pageSize}&offset=${offset}`,
        { headers: { Prefer: 'count=exact' } }
      );
      page = result.data;
      totalCount = result.totalCount || totalCount;
      if (Array.isArray(page)) allAnalyses.push(...page);
      offset += page?.length || 0;
    } while (page?.length === pageSize);

    dashboardV2.totalCount = totalCount || allAnalyses.length;

    if (!allAnalyses.length) {
      dashboardV2.error = 'No completed V2 analyses yet. Check back soon.';
      dashboardV2.allPosts = [];
    } else {
      dashboardV2.allPosts = allAnalyses.map((analysis) => ({
        uri: analysis.post_uri,
        score: v2DisplayScore(analysis.sentiment_score),
        sentiment: analysis.sentiment || 'unknown',
        confidence: analysis.confidence || 0,
        // Normalize to the {label, confidence} shape archiveDashboardData expects.
        emotions: parseArray(analysis.emotions).map((item) => (
          typeof item === 'string' ? item : { label: item.name, confidence: item.intensity || 0 }
        )),
        // Normalize to plain topic-name strings, matching legacy's shape.
        topics: parseArray(analysis.topics).map((item) => (typeof item === 'string' ? item : item.name)).filter(Boolean),
        ai_stance: analysis.ai_tooling_stance || 'not_applicable',
        rationale: analysis.rationale || '',
        model: analysis.model || 'unknown',
        timestamp: formatTimestamp(analysis.published_at),
        publishedAt: analysis.published_at,
        url: analysis.source_url,
        text: analysis.post_text || '(post text unavailable)',
        author: analysis.author_handle || 'unknown',
        originalLanguage: analysis.original_language || 'unknown',
        reply_count: analysis.reply_count || 0,
        like_count: analysis.like_count || 0,
      }));
      dashboardV2.error = '';
    }
    dashboardV2.lastLoadedAt = new Date();
  } catch (error) {
    dashboardV2.error = `Failed to load V2 dashboard archive: ${error.message}`;
    console.error('Dashboard V2 archive load error:', error);
  } finally {
    dashboardV2.isLoading = false;
    renderBlueskyStatus();
    renderDashboard(selectedData());
    renderFreshness();
  }
}

function renderFreshness() {
  const el = $('updatedAt');
  if (el) el.textContent = dashboardV2.lastLoadedAt ? `· Updated ${timeAgoLabel(dashboardV2.lastLoadedAt)}` : '';
  updateFreshnessLabel(dashboardV2.lastLoadedAt, dashboardV2.totalCount);
}

function selectedData() {
  return archiveDashboardData(state);
}

function renderDashboardMetrics(data) {
  const scoreEl = $('moodScore');
  scoreEl.innerHTML = data.items ? `${data.score}<span class="sentiment-scale">/100</span>` : '--';
  scoreEl.style.color = data.items ? scoreColor(data.score) : 'var(--text-muted)';
  $('sampleSize').textContent = number.format(data.items);
}

function renderDashboard(data) {
  renderDashboardMetrics(data);
  renderEmotions(data.emotions);
  renderTopics(data.topics);
  populateTrendTopics(data.topics);
  renderTrend();
}

// Emotions are ranked by share of all non-neutral mentions so the leading
// emotion reads as a proportion of meaningful sentiment, not of every tag.
const IGNORED_EMOTIONS = new Set(['neutral', 'none', 'not_applicable', 'mixed']);

function renderEmotions(emotions) {
  const meaningful = emotions.filter(([name]) => name && !IGNORED_EMOTIONS.has(String(name).toLowerCase()));
  const container = $('emotionList');
  if (!meaningful.length) {
    container.innerHTML = '';
    return;
  }
  const total = meaningful.reduce((sum, [, count]) => sum + count, 0) || 1;
  const ranked = meaningful
    .map(([name, count]) => [name, count / total * 100])
    .filter(([, share]) => share >= 1)
    .slice(0, 7);
  if (!ranked.length) {
    container.innerHTML = '';
    return;
  }
  const peak = ranked[0][1] || 1;
  container.innerHTML = ranked.map(([name, share], index) => `
    <div class="emotion-row${index === 0 ? ' is-leading' : ''}">
      <span class="emotion-name">${escapeHtml(humanizeLabel(name))}</span>
      <span class="emotion-track"><i style="--fill:${Math.round(share / peak * 100)}%"></i></span>
      <span class="emotion-share">${Math.round(share)}%</span>
    </div>`).join('');
}

// The archive holds thousands of long-tail topics. Showing the top slice by
// volume keeps the cloud readable while still exposing the dominant themes.
function renderTopics(topics) {
  const container = $('topicCloud');
  const top = topics.filter((topic) => topic.volume > 1).slice(0, 28);
  if (!top.length) {
    container.innerHTML = '';
    return;
  }
  const max = top[0].volume;
  const min = top[top.length - 1].volume;
  const range = Math.max(max - min, 1);
  // Shuffle deterministically so the cloud reads as a composition rather than
  // an ordered list, while keeping render output stable between refreshes.
  const arranged = top
    .map((topic, index) => ({ topic, order: (index * 7919) % top.length }))
    .sort((first, second) => first.order - second.order)
    .map((entry) => entry.topic);
  container.innerHTML = arranged.map((topic) => {
    const weight = (topic.volume - min) / range;
    const size = (1 + weight * 3.2).toFixed(2);
    const tone = (0.42 + weight * 0.58).toFixed(2);
    return `<span class="topic-word" style="--size:${size}rem;--tone:${tone}" title="${number.format(topic.volume)} posts">${escapeHtml(topic.name)}</span>`;
  }).join('');
}

// A single line answering a single question. Sparse buckets break the path
// rather than being interpolated, so the chart never implies a trend it cannot
// support. Deliberately no volume layer: one chart, one metric.
let trendTopic = 'all';

function renderTrend() {
  const container = $('trendChart');
  if (!container) return;
  const { points, score, items } = trendSeries({ topic: trendTopic });
  const solid = points.filter((point) => point.score !== null);
  // A chart needs at least one connected pair to read as a trend. Isolated dots
  // scattered across an empty frame look broken rather than sparse.
  const hasRun = points.some((point, index) => (
    point.score !== null && points[index + 1] && points[index + 1].score !== null
  ));
  if (solid.length < 2 || !hasRun) {
    container.innerHTML = `<p class="trend-empty">Not enough continuous data yet to chart this topic over time.</p>`;
    return;
  }

  const width = 1000;
  const height = 320;
  const padX = 56;
  const padY = 28;
  const span = Math.max(points.length - 1, 1);
  const x = (index) => padX + (index / span) * (width - padX * 2);
  // Anchor the scale around the data's own range, with a floor so a genuinely
  // flat line stays visually flat instead of being amplified into noise.
  const values = solid.map((point) => point.score);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const mid = (low + high) / 2;
  const half = Math.max((high - low) / 2, 8);
  const minY = Math.max(0, mid - half * 1.35);
  const maxY = Math.min(100, mid + half * 1.35);
  const y = (value) => padY + (1 - (value - minY) / Math.max(maxY - minY, 1)) * (height - padY * 2);

  // Split into contiguous runs so gaps stay gaps.
  const runs = [];
  let run = [];
  points.forEach((point, index) => {
    if (point.score === null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push({ index, ...point });
  });
  if (run.length) runs.push(run);

  const paths = runs.map((segment) => {
    if (segment.length === 1) {
      const only = segment[0];
      return `<circle class="trend-dot" cx="${x(only.index).toFixed(1)}" cy="${y(only.score).toFixed(1)}" r="3" />`;
    }
    const d = segment.map((point, i) => `${i ? 'L' : 'M'}${x(point.index).toFixed(1)} ${y(point.score).toFixed(1)}`).join(' ');
    return `<path class="trend-line" d="${d}" />`;
  }).join('');

  const baseline = minY <= 50 && maxY >= 50
    ? `<line class="trend-baseline" x1="${padX}" x2="${width - padX}" y1="${y(50).toFixed(1)}" y2="${y(50).toFixed(1)}" />`
    : '';

  // Gradient stops follow the line's own values so colour tracks sentiment
  // continuously rather than switching at a threshold.
  const gradientStops = runs.flatMap((segment) => segment.map((point) => (
    `<stop offset="${(point.index / span * 100).toFixed(2)}%" stop-color="${scoreColor(point.score)}" />`
  ))).join('');

  const first = solid[0];
  const last = solid[solid.length - 1];
  // UTC throughout, matching formatTimestamp()'s convention elsewhere in the app.
  const timeLabel = (value) => new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });
  // Hover targets: one band per valid bucket, so users can hit a wide column
  // rather than a 2px line. Excluded buckets get no band and so no tooltip.
  const bandWidth = (width - padX * 2) / Math.max(span, 1);
  const hotspots = runs.flatMap((segment) => segment.map((point) => {
    const cx = x(point.index);
    return `<rect class="trend-hit" x="${(cx - bandWidth / 2).toFixed(1)}" y="0" width="${bandWidth.toFixed(1)}" height="${height}" fill="transparent"
      tabindex="0" role="button"
      aria-label="${escapeHtml(timeLabel(point.start))} UTC, sentiment ${point.score}, ${point.count} ${point.count === 1 ? 'post' : 'posts'}"
      data-cx="${cx.toFixed(1)}" data-cy="${y(point.score).toFixed(1)}" data-score="${point.score}" data-count="${point.count}" data-start="${point.start}" />`;
  })).join('');

  const topicName = trendTopic === 'all' ? '' : humanizeLabel(trendTopic);

  container.innerHTML = `
    <div class="trend-summary">
      <strong class="trend-score" style="color:${scoreColor(score)}">${score}<span class="trend-scale">/100</span></strong>
      <span class="trend-meta">${number.format(items)} posts</span>
    </div>
    <svg class="trend-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="Hourly average sentiment${topicName ? ` for ${topicName}` : ''}">
      <defs><linearGradient id="trendStroke" gradientUnits="userSpaceOnUse" x1="${padX}" x2="${width - padX}">${gradientStops}</linearGradient></defs>
      ${baseline}
      ${paths}
      <line class="trend-guide" x1="0" x2="0" y1="${padY}" y2="${height - padY}" opacity="0" />
      <circle class="trend-marker" r="3.5" opacity="0" />
      ${hotspots}
    </svg>
    <div class="trend-tooltip" hidden></div>
    <div class="trend-axis"><span>${timeLabel(first.start)} UTC</span><span>${timeLabel(last.start)} UTC</span></div>`;

  attachTrendHover(container, { topicName, timeLabel, width, height });
}

// Pointer/focus interaction. Hit bands are generated only for valid buckets, so
// excluded ones can never surface a tooltip or an interpolated value.
function attachTrendHover(container, { topicName, timeLabel, width, height }) {
  const svg = container.querySelector('.trend-svg');
  const tooltip = container.querySelector('.trend-tooltip');
  const marker = container.querySelector('.trend-marker');
  const guide = container.querySelector('.trend-guide');
  if (!svg || !tooltip) return;

  const show = (hit) => {
    const cx = Number(hit.dataset.cx);
    const cy = Number(hit.dataset.cy);
    const score = Number(hit.dataset.score);
    const count = Number(hit.dataset.count);
    marker.setAttribute('cx', cx);
    marker.setAttribute('cy', cy);
    marker.setAttribute('fill', scoreColor(score));
    marker.setAttribute('opacity', '1');
    guide.setAttribute('x1', cx);
    guide.setAttribute('x2', cx);
    guide.setAttribute('opacity', '1');
    tooltip.innerHTML = `${topicName ? `<b>${escapeHtml(topicName)}</b>` : ''}
      <span>${escapeHtml(timeLabel(Number(hit.dataset.start)))} UTC</span>
      <span>Sentiment: <em style="color:${scoreColor(score)}">${score}</em></span>
      <span>${number.format(count)} ${count === 1 ? 'post' : 'posts'}</span>`;
    tooltip.hidden = false;
    // Position within the rendered box and clamp so edge buckets stay on screen.
    const box = svg.getBoundingClientRect();
    const host = container.getBoundingClientRect();
    const px = (box.left - host.left) + (cx / width) * box.width;
    const py = (box.top - host.top) + (cy / height) * box.height;
    const half = tooltip.offsetWidth / 2;
    const clamped = Math.max(half + 4, Math.min(host.width - half - 4, px));
    tooltip.style.left = `${clamped}px`;
    tooltip.style.top = `${Math.max(0, py - tooltip.offsetHeight - 14)}px`;
  };

  const hide = () => {
    tooltip.hidden = true;
    marker.setAttribute('opacity', '0');
    guide.setAttribute('opacity', '0');
  };

  svg.querySelectorAll('.trend-hit').forEach((hit) => {
    hit.addEventListener('pointerenter', () => show(hit));
    hit.addEventListener('pointerdown', () => show(hit));
    hit.addEventListener('focus', () => show(hit));
    hit.addEventListener('blur', hide);
  });
  svg.addEventListener('pointerleave', hide);
}

function populateTrendTopics(topics) {
  const select = $('trendTopic');
  if (!select) return;
  const options = topics.filter((topic) => topic.volume >= 5).slice(0, 20);
  const markup = ['<option value="all">All topics</option>']
    .concat(options.map((topic) => `<option value="${escapeHtml(topic.id)}">${escapeHtml(topic.name)}</option>`))
    .join('');
  if (select.innerHTML === markup) return;
  const previous = trendTopic;
  select.innerHTML = markup;
  // Keep the user's selection across refreshes when the topic still exists.
  if (previous !== 'all' && options.some((topic) => topic.id === previous)) {
    select.value = previous;
  } else {
    trendTopic = 'all';
    select.value = 'all';
  }
}

/** Normalize a legacy or V2 archive post into a source-neutral feed record.
 * Primary fields drive the collapsed feed item; provenance fields are only
 * ever shown inside the inline "Analysis details" expansion. */
function toFeedRecord(post, source) {
  if (source === 'v2') {
    const topicNames = post.topics.map((item) => typeof item === 'string' ? item : item.name).filter(Boolean).map(humanizeLabel);
    const emotionNames = post.emotions.map((e) => typeof e === 'string' ? humanizeLabel(e) : `${humanizeLabel(e.name)} (${Math.round((e.intensity || 0) * 100)}%)`);
    return {
      uri: post.uri,
      source: 'v2',
      author: post.author,
      language: post.originalLanguage || 'unknown',
      timestamp: post.timestamp,
      text: post.text,
      score: post.displayScore,
      sentimentLabel: humanizeLabel(post.sentiment),
      topics: topicNames,
      confidence: post.confidence,
      toolsMentioned: post.toolsMentioned,
      url: post.url,
      provenance: {
        rawScore: post.sentimentScore ?? 'N/A',
        emotions: emotionNames.length ? emotionNames.join(', ') : 'N/A',
        aiStance: aiStanceLabel(post.aiStance),
        provider: post.provider,
        processedTimestamp: post.processedTimestamp,
        deployment: post.deployment,
        model: post.model,
        promptVersion: post.promptVersion,
        rationale: post.rationale,
      },
    };
  }
  return {
    uri: post.uri,
    source: 'legacy',
    author: post.author,
    language: post.originalLanguage || 'unknown',
    timestamp: post.timestamp,
    text: post.text,
    score: post.score,
    sentimentLabel: post.sentiment,
    topics: post.topics.map(humanizeLabel),
    confidence: post.confidence,
    toolsMentioned: [],
    url: post.url,
    provenance: {
      emotions: post.emotions.length ? post.emotions.map((e) => `${humanizeLabel(e.label)} (${(e.confidence * 100).toFixed(0)}%)`).join(', ') : 'N/A',
      aiStance: aiStanceLabel(post.ai_stance),
      rationale: post.rationale,
    },
  };
}

function renderDataReview() {
  if (reviewSource === 'v2') {
    renderFeed(blueskyV2, 'v2', 'V2 analyzed posts', 'No completed V2 analyses available yet.', 'Loading persisted V2 sentiment analysis from Supabase...');
  } else {
    renderFeed(bluesky, 'legacy', 'archived posts', 'No analyzed posts available yet. The archive will populate when analysis completes.', 'Loading persisted sentiment analysis from Supabase...');
  }
}

/** Shared conversation-first feed renderer for both archive sources. Search
 * is applied server-side (via loadReviewData/loadArchive/loadArchiveV2), so
 * the posts here are already the matching set for the full archive. */
function renderFeed(archiveState, source, countLabel, emptyMessage, loadingMessage) {
  const list = $('dataReviewList');
  const count = $('reviewCount');
  const pagination = $('reviewPagination');
  const searchStatus = $('reviewSearchStatus');

  if (archiveState.isLoading) {
    list.innerHTML = `<p class="empty">${escapeHtml(loadingMessage)}</p>`;
    count.textContent = 'Loading...';
    if (pagination) pagination.innerHTML = '';
    if (searchStatus) searchStatus.textContent = '';
    return;
  }

  if (archiveState.error) {
    list.innerHTML = `<p class="empty error"><strong>⚠️ ${escapeHtml(archiveState.error)}</strong></p>`;
    count.textContent = 'Error';
    if (pagination) pagination.innerHTML = '';
    if (searchStatus) searchStatus.textContent = reviewSearchTerm.trim() ? '0 hits' : '';
    return;
  }

  if (!archiveState.posts.length) {
    list.innerHTML = `<p class="empty">${escapeHtml(emptyMessage)}</p>`;
    count.textContent = 'No data';
    if (pagination) pagination.innerHTML = '';
    if (searchStatus) searchStatus.textContent = '';
    return;
  }

  const totalCount = archiveState.totalCount || archiveState.posts.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / REVIEW_PAGE_SIZE));
  const firstRow = (reviewPage - 1) * REVIEW_PAGE_SIZE + 1;
  const lastRow = firstRow + archiveState.posts.length - 1;

  count.textContent = `${number.format(totalCount)} ${countLabel}`;
  if (pagination) {
    pagination.innerHTML = `<button type="button" id="reviewPrevPage" ${reviewPage <= 1 ? 'disabled' : ''}>Previous</button><span>Showing ${number.format(firstRow)}-${number.format(lastRow)} of ${number.format(totalCount)} · Page ${reviewPage} of ${totalPages}</span><button type="button" id="reviewNextPage" ${reviewPage >= totalPages ? 'disabled' : ''}>Next</button>`;
    const prevButton = $('reviewPrevPage');
    const nextButton = $('reviewNextPage');
    if (prevButton) prevButton.addEventListener('click', () => loadReviewData(reviewPage - 1));
    if (nextButton) nextButton.addEventListener('click', () => loadReviewData(reviewPage + 1));
  }

  if (searchStatus) {
    searchStatus.textContent = reviewSearchTerm.trim()
      ? `${number.format(totalCount)} hit${totalCount === 1 ? '' : 's'}`
      : '';
  }

  const records = archiveState.posts.map((post) => toFeedRecord(post, source));

  list.innerHTML = records.map((record) => {
    const isExpanded = expandedReviewRow === record.uri;
    const provenanceRows = Object.entries({
      ...(record.source === 'v2' ? { 'Raw score': record.provenance.rawScore } : {}),
      Confidence: `${(record.confidence * 100).toFixed(0)}%`,
      Emotions: record.provenance.emotions,
      'AI stance': record.provenance.aiStance,
      ...(record.source === 'v2' ? {
        Provider: record.provenance.provider,
        'Processed (UTC)': record.provenance.processedTimestamp,
        Deployment: record.provenance.deployment,
        Model: record.provenance.model,
        'Prompt version': record.provenance.promptVersion,
      } : {}),
    }).map(([label, value]) => `<div><b>${escapeHtml(label)}</b><span>${escapeHtml(String(value))}</span></div>`).join('');

    return `
    <article class="feed-item">
      <div class="feed-meta">
        <span class="feed-author">@${escapeHtml(record.author)}</span>
        <span class="feed-dot" aria-hidden="true">·</span>
        <span class="feed-time">${escapeHtml(record.timestamp)}</span>
        <span class="feed-dot" aria-hidden="true">·</span>
        <span class="feed-lang">${escapeHtml(record.language)}</span>
      </div>
      <p class="feed-text">${escapeHtml(record.text)}</p>
      <div class="feed-analysis">
        <span class="sentiment-score ${sentimentClass(record.score)}" style="color: ${scoreColor(record.score)}">${record.score}%</span>
        <span class="feed-sentiment-label">${escapeHtml(record.sentimentLabel)}</span>
        ${record.topics.length ? `<span class="feed-topics">${escapeHtml(record.topics.join(', '))}</span>` : ''}
        ${record.toolsMentioned.length ? `<span class="feed-tools">${escapeHtml(record.toolsMentioned.join(', '))}</span>` : ''}
      </div>
      <div class="feed-actions">
        <button type="button" class="review-details-toggle" data-uri="${escapeHtml(record.uri)}">${isExpanded ? 'Hide analysis details' : 'Analysis details'}</button>
        <a class="post-link" href="${escapeHtml(record.url)}" target="_blank" rel="noopener noreferrer">Open on Bluesky</a>
      </div>
      ${isExpanded ? `
      <div class="review-details-card">
        ${provenanceRows}
        <div class="review-details-rationale"><b>Rationale</b><span>${escapeHtml(record.provenance.rationale)}</span></div>
      </div>` : ''}
    </article>`;
  }).join('');

  list.querySelectorAll('.review-details-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const uri = button.dataset.uri;
      expandedReviewRow = expandedReviewRow === uri ? null : uri;
      renderDataReview();
    });
  });
}

function setActiveView(view) {
  activeView = view;
  $('dashboardView').hidden = view !== 'dashboard';
  $('dataReviewView').hidden = view !== 'data-review';
  document.querySelectorAll('.view-tab').forEach((tab) => {
    const isActive = tab.dataset.view === view;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
  if (view === 'data-review') {
    if (reviewSource === 'v2' && !blueskyV2.posts.length && !blueskyV2.isLoading && !blueskyV2.error) {
      loadArchiveV2(1);
    } else {
      renderDataReview();
    }
  }
}

function renderBlueskyStatus() {
  const status = $('blueskyStatus');
  if (!status) return;
  if (dashboardV2.isLoading) {
    status.innerHTML = '⏳ Loading persisted sentiment analysis...';
    status.className = 'loading';
  } else if (dashboardV2.error) {
    status.innerHTML = `⚠️ ${escapeHtml(dashboardV2.error)}`;
    status.className = 'error';
  } else if (dashboardV2.totalCount > 0) {
    status.innerHTML = `✓ ${number.format(dashboardV2.totalCount)} posts with completed sentiment analysis`;
    status.className = 'loaded';
  } else {
    status.innerHTML = '○ No completed analyses yet. The archive will populate when analysis completes.';
    status.className = 'empty';
  }
}

// Event listeners
document.querySelectorAll('.view-tab').forEach((tab) => {
  tab.addEventListener('click', () => setActiveView(tab.dataset.view));
});

document.getElementById('trendTopic')?.addEventListener('change', (event) => {
  trendTopic = event.target.value;
  const chart = document.getElementById('trendChart');
  if (!chart) return;
  // Brief fade so the swap reads as a transition rather than a redraw.
  chart.classList.add('is-swapping');
  window.setTimeout(() => {
    renderTrend();
    chart.classList.remove('is-swapping');
  }, 160);
});

document.getElementById('reviewSource')?.addEventListener('change', (event) => {
  reviewSource = event.target.value;
  reviewPage = 1;
  expandedReviewRow = null;
  reviewSearchTerm = '';
  const searchInput = $('reviewSearch');
  if (searchInput) searchInput.value = '';
  loadReviewData(1);
});

// Server-side search: queries the full archive (not just the loaded page)
// via loadReviewData, debounced with a short timer so typing stays
// responsive. Changing the search term always resets to page 1.
let reviewSearchDebounce = null;
document.getElementById('reviewSearch')?.addEventListener('input', (event) => {
  const value = event.target.value;
  const searchStatus = $('reviewSearchStatus');
  if (searchStatus && value.trim()) searchStatus.textContent = 'Searching…';
  window.clearTimeout(reviewSearchDebounce);
  reviewSearchDebounce = window.setTimeout(() => {
    reviewSearchTerm = value;
    loadReviewData(1, reviewSearchTerm);
  }, 120);
});

// Initial load
async function init() {
  // Render the empty archive state while the persisted data loads.
  renderDashboard(selectedData());
  
  // Load persisted V2 (Foundry) sentiment analyses for the main dashboard,
  // and the V2 archive for the Data review tab's default Latest model source.
  await Promise.all([loadDashboardV2(), loadArchiveV2()]);
  renderDashboard(selectedData());
  renderFreshness();
  
  // Refresh archives periodically. The dashboard aggregation now uses the V2
  // (Foundry) source; the Data review tab additionally refreshes whichever
  // source is currently toggled on.
  setInterval(() => {
    loadDashboardV2();
    if (reviewSource === 'legacy') loadArchive(reviewPage);
    if (reviewSource === 'v2') loadArchiveV2(reviewPage);
  }, ARCHIVE_REFRESH_MS);

  // Keep the "Updated Xm ago" freshness label current between archive reloads.
  setInterval(renderFreshness, 30 * 1000);
}

// Reveal on enter and reset on exit so each chapter animates every time it is
// scrolled back into view, not just on first sight.
function initializeAnimations() {
  const animatedSections = document.querySelectorAll('.section-animate');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    animatedSections.forEach((element) => element.classList.add('visible'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      entry.target.classList.toggle('visible', entry.isIntersecting);
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -10% 0px' });
  animatedSections.forEach((element) => observer.observe(element));
}

// Featured conversation rotation: a small, curated set of illustrative
// examples cycles on the landing hero, giving the sense of a living stream
// of AI conversations rather than a single static marketing quote.
const FEATURED_CONVERSATIONS = [
  { quote: 'So many bad ideas. So little time. Disasters await.', author: '@stevenwoods.com', analysis: ['13% Negative', 'Reliability, Risk', '86% Confidence'] },
  { quote: 'When AI takes most jobs and people have to be paid to sit at home, what if not socialism do we call it?', author: '@dansky21.bsky.social', analysis: ['28% Negative', 'Employment impact, Economic systems'] },
  { quote: "You suggesting ChatGPT isn't 100% accurate \u{1F923}", author: '@algarveceltic.bsky.social', analysis: ['28% Negative', 'Reliability'] },
  { quote: 'Gemini probably led him to making moldy Lunchables knockoffs, so go nuts, Sir Beast.', author: '@shawnst.bsky.social', analysis: ['20% Negative', 'Quality & reliability, Creativity & misuse'] },
  { quote: 'Claude in Chrome feels like a real product, not just a demo.', author: '@papoo7.bsky.social', analysis: ['80% Positive', 'Product maturity, User experience'] },
];
const FEATURED_ROTATION_MS = 10 * 1000;
const FEATURED_FADE_MS = 500;

function renderFeaturedConversation(index) {
  const example = FEATURED_CONVERSATIONS[index];
  $('landingQuote').textContent = `\u201C${example.quote}\u201D`;
  $('landingAuthor').textContent = example.author;
  $('landingAnalysis').innerHTML = example.analysis.map((item) => `<span>${escapeHtml(item)}</span>`).join('');
}

function initializeFeaturedConversationRotation() {
  const figure = $('landingExample');
  if (!figure || !FEATURED_CONVERSATIONS.length) return;
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let index = Math.floor(Math.random() * FEATURED_CONVERSATIONS.length);
  renderFeaturedConversation(index);

  window.setInterval(() => {
    const next = (index + 1) % FEATURED_CONVERSATIONS.length;
    if (prefersReducedMotion) {
      index = next;
      renderFeaturedConversation(index);
      return;
    }
    figure.classList.add('is-fading');
    window.setTimeout(() => {
      index = next;
      renderFeaturedConversation(index);
      figure.classList.remove('is-fading');
    }, FEATURED_FADE_MS);
  }, FEATURED_ROTATION_MS);
}

// Start application
window.addEventListener('DOMContentLoaded', () => {
  initializeAnimations();
  initializeFeaturedConversationRotation();
  init();
});
