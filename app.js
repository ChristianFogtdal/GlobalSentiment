// Default to a 7-day window: V2 (Foundry) has a much smaller volume than the
// legacy archive did, so a 24h window can easily show zero posts.
const state = { time: '7d', emotion: 'all', topic: 'all', sort: 'impact' };
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US');
const ARCHIVE_REFRESH_MS = 5 * 60 * 1000;
const SPOTLIGHT_CACHE_MS = 15 * 60 * 1000;
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
let reviewSource = 'legacy'; // 'legacy' | 'v2'
let expandedReviewRow = null; // post_uri of the row whose details expander is open (V2 only)
let activeView = 'dashboard';
let map;
let countryLayer;
let cachedSpotlightPost = null;
let spotlightCacheTime = null;

// Utility functions
function sentimentLabel(score) { return score >= 75 ? 'Very positive' : score >= 60 ? 'Positive' : score >= 45 ? 'Mixed' : score >= 25 ? 'Negative' : 'Very negative'; }
function scoreColor(score) { return score >= 70 ? '#118a72' : score >= 60 ? '#58a86d' : score >= 50 ? '#d3aa45' : '#cf6c53'; }
function signed(value, suffix = '') { return `${value > 0 ? '+' : ''}${value}${suffix}`; }
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

function selectMostRepresentativePost(posts) {
  if (!Array.isArray(posts) || posts.length === 0) return null;
  const validPosts = posts.filter((post) => Number.isFinite(new Date(post.publishedAt).getTime()));
  if (!validPosts.length) return null;
  const now = Date.now();
  const recentPosts = validPosts.filter((post) => {
    const hoursDiff = (now - new Date(post.publishedAt).getTime()) / (60 * 60 * 1000);
    return hoursDiff >= 0 && hoursDiff <= 48;
  });
  const candidates = recentPosts.length ? recentPosts : validPosts;
  return [...candidates].sort((first, second) => {
    const firstEngagement = (first.reply_count || 0) + (first.like_count || 0);
    const secondEngagement = (second.reply_count || 0) + (second.like_count || 0);
    return secondEngagement - firstEngagement ||
      new Date(second.publishedAt).getTime() - new Date(first.publishedAt).getTime();
  })[0];
}

function getSpotlightPost(posts) {
  const now = Date.now();
  if (cachedSpotlightPost && spotlightCacheTime && now - spotlightCacheTime < SPOTLIGHT_CACHE_MS) return cachedSpotlightPost;
  cachedSpotlightPost = selectMostRepresentativePost(posts);
  spotlightCacheTime = now;
  return cachedSpotlightPost;
}

function invalidateSpotlightCache() {
  cachedSpotlightPost = null;
  spotlightCacheTime = null;
}

function generatePostInsights(post) {
  if (!post) return [];
  const emotion = parseArray(post.emotions).map((item) => typeof item === 'string' ? item : item.label).filter(Boolean)[0];
  const topics = parseArray(post.topics).map((item) => typeof item === 'string' ? item : item.name).filter(Boolean).slice(0, 2).map(humanizeLabel);
  const focus = topics.length ? `focusing on ${topics.join(' and ')}` : 'spanning multiple topics';
  const engagement = (post.reply_count || 0) + (post.like_count || 0);
  return [`Dominated by ${humanizeLabel(emotion || 'mixed emotion')}, ${focus}`, `This post resonated with ${number.format(engagement)} engagements`];
}

function renderPostSpotlight(post) {
  const article = document.querySelector('.featured-post');
  if (!article) return;
  if (!post) {
    article.innerHTML = '<p class="empty-state">No representative post is available.</p>';
    return;
  }
  const sentiment = sentimentClass(post.score);
  const timestamp = timeAgoLabel(new Date(post.publishedAt));
  const insights = generatePostInsights(post);
  article.innerHTML = `<div class="post-header"><strong>${escapeHtml(post.author || 'Unknown author')}</strong><span class="timestamp">${escapeHtml(timestamp)}</span><span class="sentiment-badge ${sentiment}">${escapeHtml(sentimentLabel(post.score))}</span></div><p class="post-content">${escapeHtml(post.text || '')}</p><div class="post-analysis"><h3>Why this matters</h3><ul class="insights">${insights.map((insight) => `<li>${escapeHtml(insight)}</li>`).join('')}</ul></div>`;
}

function initializeSpotlight(posts) {
  renderPostSpotlight(getSpotlightPost(posts));
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

let topicsExpanded = false;
let emotionsExpanded = false;

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

function archiveDashboardData({ time = '24h', emotion = 'all', topic = 'all' } = {}) {
  const hours = { '1h': 1, '24h': 24, '7d': 24 * 7 }[time] || 24;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const recentPosts = dashboardV2.allPosts.filter((post) => {
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
  // rather than the currently selected emotion/topic slice.
  const prevScore = periodAverageScore(hours, hours);
  const delta = prevScore === null || !posts.length ? null : score - prevScore;
  const emotionCounts = new Map();
  posts.forEach((post) => parseArray(post.emotions).forEach((item) => {
    const name = typeof item === 'string' ? item : item.label;
    if (name) emotionCounts.set(name, (emotionCounts.get(name) || 0) + 1);
  }));
  const totalEmotions = [...emotionCounts.values()].reduce((sum, value) => sum + value, 0) || 1;
  const emotions = [...emotionCounts.entries()]
    .map(([name, count]) => [name, Math.round(count / totalEmotions * 100), 0])
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
async function loadArchive(page = reviewPage) {
  try {
    bluesky.isLoading = true;
    renderBlueskyStatus();
    renderDataReview();

    reviewPage = page;
    const from = (page - 1) * REVIEW_PAGE_SIZE;
    const to = from + REVIEW_PAGE_SIZE - 1;

    // Query completed_post_analyses view with exact count + range-based pagination
    const { data: analyses, totalCount } = await requestArchive(
      `completed_post_analyses?order=created_at.desc`,
      {
        headers: {
          Prefer: 'count=exact',
          Range: `${from}-${to}`,
        },
      }
    );

    bluesky.totalCount = totalCount;

    if (!analyses || analyses.length === 0) {
      bluesky.error = 'No completed analyses yet. Check back soon.';
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
      if (page === 1) {
        const allAnalyses = [];
        const pageSize = 1000;
        let offset = 0;
        let archivePage;
        do {
          const result = await requestArchive(
            `completed_post_analyses?order=created_at.desc&limit=${pageSize}&offset=${offset}`
          );
          archivePage = result.data;
          if (Array.isArray(archivePage)) allAnalyses.push(...archivePage);
          offset += archivePage?.length || 0;
        } while (archivePage?.length === pageSize);
        bluesky.allPosts = allAnalyses.map(analysis => ({
          ...analysis,
          score: Math.round((analysis.score || 0) * 100),
          confidence: analysis.confidence || 0,
          emotions: parseArray(analysis.emotions),
          topics: parseArray(analysis.topics),
          ai_stance: analysis.ai_tooling_stance || 'not_applicable',
          publishedAt: analysis.published_at || analysis.created_at,
        }));
      }
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
async function loadArchiveV2(page = reviewPage) {
  try {
    blueskyV2.isLoading = true;
    renderDataReview();

    reviewPage = page;
    const from = (page - 1) * REVIEW_PAGE_SIZE;
    const to = from + REVIEW_PAGE_SIZE - 1;

    // V2 default ordering: most recently analyzed first, for validation.
    const { data: analyses, totalCount } = await requestArchive(
      `completed_post_analyses_v2?order=processed_at.desc,published_at.desc`,
      {
        headers: {
          Prefer: 'count=exact',
          Range: `${from}-${to}`,
        },
      }
    );

    blueskyV2.totalCount = totalCount;

    if (!analyses || analyses.length === 0) {
      blueskyV2.error = 'No completed V2 analyses yet. Check back soon.';
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
async function loadReviewData(page = reviewPage) {
  if (reviewSource === 'v2') {
    await loadArchiveV2(page);
  } else {
    await loadArchive(page);
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
    invalidateSpotlightCache();
  } catch (error) {
    dashboardV2.error = `Failed to load V2 dashboard archive: ${error.message}`;
    console.error('Dashboard V2 archive load error:', error);
  } finally {
    dashboardV2.isLoading = false;
    renderBlueskyStatus();
    renderDashboard(selectedData());
    initializeSpotlight(dashboardV2.allPosts);
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

function scoreLegendText(score, items) {
  if (!items) return 'No analyses in this window yet';
  if (score >= 75) return 'Strongly positive conversation';
  if (score >= 60) return 'Leaning positive';
  if (score >= 45) return 'Split between positive and negative';
  if (score >= 25) return 'Leaning negative';
  return 'Strongly negative conversation';
}

function renderDashboardMetrics(data) {
  $('moodScore').textContent = data.score;
  $('moodLabel').textContent = sentimentLabel(data.score);
  $('scoreLegend').textContent = scoreLegendText(data.score, data.items);
  const deltaEl = $('scoreDelta');
  if (deltaEl) {
    if (data.delta === null) {
      deltaEl.textContent = '';
      deltaEl.className = 'score-delta';
    } else {
      deltaEl.textContent = `${signed(data.delta, ' pts')} vs previous period`;
      deltaEl.className = `score-delta ${data.delta > 0 ? 'up' : data.delta < 0 ? 'down' : ''}`;
    }
  }
  $('stanceSummary').textContent = data.stance;
  $('stanceNote').textContent = 'Most common classification (count)';
  $('sampleSize').textContent = number.format(data.items);
  $('sourceNote').textContent = 'Completed sentiment analyses';
  $('confidence').textContent = data.confidence;
}

function renderDashboard(data) {
  const isInitialLoad = dashboardV2.isLoading && !dashboardV2.allPosts.length && !dashboardV2.error;
  document.querySelectorAll('.dashboard-grid .panel').forEach((panel) => panel.classList.toggle('is-loading', isInitialLoad));
  renderDashboardMetrics(data);
  renderEmotions(data.emotions);
  renderTopics(data.topics);
  renderExplanation(data);
  renderSources(data);
}

function renderEmotions(emotions) {
  $('dominantEmotion').textContent = emotions.length ? `Dominant: ${humanizeLabel(emotions[0][0])}` : 'Dominant: N/A';
  const DEFAULT_COUNT = 5;
  const visible = emotionsExpanded ? emotions : emotions.slice(0, DEFAULT_COUNT);
  const rows = visible.map(([name, share]) => `<button class="emotion-row ${state.emotion === name ? 'selected' : ''}" data-emotion="${name}" type="button" title="Filter the dashboard to posts tagged with this emotion"><span>${escapeHtml(humanizeLabel(name))}</span><div class="bar"><i style="width:${share}%"></i></div><strong>${share}%</strong></button>`).join('');
  const toggle = emotions.length > DEFAULT_COUNT
    ? `<button class="show-more-toggle" id="toggleEmotions" type="button">${emotionsExpanded ? 'Show fewer' : `Show all ${emotions.length} emotions`}</button>`
    : '';
  $('emotionList').innerHTML = emotions.length ? rows + toggle : '<p class="empty">No emotion data for the selected analyses.</p>';
  const toggleButton = $('toggleEmotions');
  if (toggleButton) toggleButton.addEventListener('click', () => { emotionsExpanded = !emotionsExpanded; renderEmotions(emotions); });
}

function renderTopics(topics) {
  const sorted = [...topics].sort((first, second) => state.sort === 'volume' ? second.volume - first.volume : Math.abs(second.impact) - Math.abs(first.impact));
  const DEFAULT_COUNT = 5;
  const visible = topicsExpanded ? sorted : sorted.slice(0, DEFAULT_COUNT);
  const rows = visible.map((topic) => `<tr class="topic-row ${state.topic === topic.id ? 'selected' : ''}" data-topic="${topic.id}" title="Filter the dashboard to this topic"><td><b>${escapeHtml(topic.name)}</b><span class="${topic.lowSample ? 'low-sample' : ''}">${topic.lowSample ? `Low sample (${topic.volume} post${topic.volume === 1 ? '' : 's'})` : 'Analyzed posts'}</span></td><td>${number.format(topic.volume)}</td><td><span class="score-dot" style="background:${scoreColor(topic.sentiment)}"></span>${topic.sentiment}</td><td class="${topic.impact >= 0 ? 'impact-positive' : 'impact-negative'}" title="Difference vs the overall mood score for the selected period">${signed(topic.impact, ' pts')}</td></tr>`).join('');
  $('topicList').innerHTML = sorted.length ? rows : '<tr><td colspan="4" class="empty">No topics match this filter.</td></tr>';
  const toggleWrap = $('topicsToggleWrap');
  if (toggleWrap) {
    toggleWrap.innerHTML = sorted.length > DEFAULT_COUNT
      ? `<button class="show-more-toggle" id="toggleTopics" type="button">${topicsExpanded ? 'Show fewer' : `Show all ${sorted.length} topics`}</button>`
      : '';
    const toggleButton = $('toggleTopics');
    if (toggleButton) toggleButton.addEventListener('click', () => { topicsExpanded = !topicsExpanded; renderTopics(topics); });
  }
}

function renderExplanation(data) {
  const focus = data.selectedTopic
    ? `${data.selectedTopic.name} is the active lens, with a sentiment score of ${data.selectedTopic.sentiment}.`
    : dashboardV2.allPosts.length
      ? 'The dashboard is aggregating the completed sentiment analyses currently available in the archive.'
      : 'Clean energy and international football are the strongest positive associations, while severe weather and cost-of-living discussion pull in the opposite direction.';
  const leadingEmotion = data.emotions[0] ? humanizeLabel(data.emotions[0][0]) : 'No dominant emotion';
  $('explanation').textContent = data.items
    ? `Public mood is ${sentimentLabel(data.score).toLowerCase()} at ${data.score}/100, based on ${number.format(data.items)} analyzed posts. ${focus} ${leadingEmotion} is the leading emotion in the selected data.`
    : 'No completed analyses match the selected filters. Widen the time window or reset the filters to see a data-backed summary.';
  $('evidence').innerHTML = data.topics.slice(0, 3).map((topic) => `<button data-topic="${topic.id}" type="button" title="Filter the dashboard to this topic"><b>${escapeHtml(topic.name)}</b><span>${signed(topic.impact, ' pts')} vs overall score</span></button>`).join('');
}

function sentimentClass(score) { return score >= 60 ? 'positive' : score >= 45 ? 'mixed' : 'negative'; }

function renderSources(data) {
  if (data.posts.length) {
    $('sourceList').innerHTML = data.posts.slice(0, 3).map((post) => {
      const topicNames = parseArray(post.topics).map((name) => humanizeLabel(name)).slice(0, 2);
      const emotionNames = parseArray(post.emotions).map((item) => humanizeLabel(typeof item === 'string' ? item : item.label)).slice(0, 2);
      return `<div class="source"><span>Sample post</span><div class="source-meta"><span class="sentiment-tag ${sentimentClass(post.score)}">${escapeHtml(post.sentiment)}</span>${emotionNames.map((name) => `<span class="meta-chip">${escapeHtml(name)}</span>`).join('')}${topicNames.map((name) => `<span class="meta-chip">${escapeHtml(name)}</span>`).join('')}</div><p>"${escapeHtml(post.text)}"</p><b>${escapeHtml(post.timestamp)}</b></div>`;
    }).join('');
    return;
  }
  $('sourceList').innerHTML = '<div class="source"><span>Archive</span><p>No completed analyses match the selected filters.</p><b>Try a wider time window or reset filters</b></div>';
}

function renderDataReview() {
  const head = $('dataReviewHead');
  if (head) {
    head.innerHTML = reviewSource === 'v2'
      ? '<tr><th>Published (UTC)</th><th>Author</th><th>Language</th><th>Post text</th><th>Score (0-100)</th><th>Sentiment</th><th>Tools mentioned</th><th>Topics</th><th>Confidence</th><th>Provider</th><th>Processed (UTC)</th><th>Details</th><th>Verification</th></tr>'
      : '<tr><th>Published (UTC)</th><th>Author</th><th>Language</th><th>Post text</th><th>Sentiment (0-100)</th><th>Confidence</th><th>Emotions</th><th>Topics</th><th>AI stance</th><th>Rationale</th><th>Verification</th></tr>';
  }
  if (reviewSource === 'v2') {
    renderV2Review();
  } else {
    renderLegacyReview();
  }
}

function renderLegacyReview() {
  const list = $('dataReviewList');
  const count = $('reviewCount');
  const pagination = $('reviewPagination');

  if (bluesky.isLoading) {
    list.innerHTML = `<tr><td colspan="11" class="empty">Loading persisted sentiment analysis from Supabase...</td></tr>`;
    count.textContent = 'Loading...';
    if (pagination) pagination.innerHTML = '';
    return;
  }
  
  if (bluesky.error) {
    list.innerHTML = `<tr><td colspan="11" class="empty error"><strong>⚠️ ${escapeHtml(bluesky.error)}</strong><br><small>Check that: (1) Ingestion function has run, (2) LLM analysis is complete, (3) Supabase completed_post_analyses view exists</small></td></tr>`;
    count.textContent = 'Error';
    if (pagination) pagination.innerHTML = '';
    return;
  }
  
  if (!bluesky.posts.length) {
    list.innerHTML = `<tr><td colspan="11" class="empty">No analyzed posts available yet. The archive will populate when analysis completes.</td></tr>`;
    count.textContent = 'No data';
    if (pagination) pagination.innerHTML = '';
    return;
  }
  
  const totalCount = bluesky.totalCount || bluesky.posts.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / REVIEW_PAGE_SIZE));
  const firstRow = (reviewPage - 1) * REVIEW_PAGE_SIZE + 1;
  const lastRow = firstRow + bluesky.posts.length - 1;

  count.textContent = `${number.format(totalCount)} archived posts`;
  if (pagination) {
    pagination.innerHTML = `<button type="button" id="reviewPrevPage" ${reviewPage <= 1 ? 'disabled' : ''}>Previous</button><span>Rows ${number.format(firstRow)}-${number.format(lastRow)} of ${number.format(totalCount)} · Page ${reviewPage} of ${totalPages}</span><button type="button" id="reviewNextPage" ${reviewPage >= totalPages ? 'disabled' : ''}>Next</button>`;
    const prevButton = $('reviewPrevPage');
    const nextButton = $('reviewNextPage');
    if (prevButton) prevButton.addEventListener('click', () => loadReviewData(reviewPage - 1));
    if (nextButton) nextButton.addEventListener('click', () => loadReviewData(reviewPage + 1));
  }

  list.innerHTML = bluesky.posts.map((post) => `
    <tr>
      <td data-label="Published (UTC)">${escapeHtml(post.timestamp)}</td>
      <td data-label="Author">@${escapeHtml(post.author)}</td>
      <td data-label="Language">${escapeHtml(post.originalLanguage || 'Unknown')}</td>
      <td class="post-text" data-label="Post text">${escapeHtml(post.text)}</td>
      <td data-label="Sentiment (0-100)">
        <span class="sentiment-score ${sentimentClass(post.score)}" style="background: ${scoreColor(post.score)}">${post.score}%</span>
        <br><small>${escapeHtml(post.sentiment)}</small>
      </td>
      <td data-label="Confidence"><small>${(post.confidence * 100).toFixed(0)}%</small></td>
      <td data-label="Emotions" title="${post.emotions.map(e => `${humanizeLabel(e.label)} (${(e.confidence * 100).toFixed(0)}%)`).join(', ')}">
        ${post.emotions.length > 0 ? post.emotions.slice(0, 2).map(e => escapeHtml(humanizeLabel(e.label))).join(', ') : 'N/A'}
      </td>
      <td data-label="Topics">${post.topics.length > 0 ? escapeHtml(post.topics.map(humanizeLabel).join(', ')) : 'N/A'}</td>
      <td data-label="AI stance">${escapeHtml(aiStanceLabel(post.ai_stance))}</td>
      <td class="rationale" data-label="Rationale" title="${escapeHtml(post.rationale)}"><small>${escapeHtml(post.rationale.substring(0, 40))}${post.rationale.length > 40 ? '...' : ''}</small></td>
      <td data-label="Verification"><a class="post-link" href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer">Open</a></td>
    </tr>
  `).join('');
}

/** Curated columns for V2, per plan: Published, Score, Sentiment, Tools
 * mentioned, Topics, Confidence, Provider, Processed At -- everything else
 * (raw sentiment_score, emotions, ai_tooling_stance, rationale, deployment,
 * model, prompt_version) lives in a per-row details expander. */
function renderV2Review() {
  const list = $('dataReviewList');
  const count = $('reviewCount');
  const pagination = $('reviewPagination');
  const COLSPAN = 13;

  if (blueskyV2.isLoading) {
    list.innerHTML = `<tr><td colspan="${COLSPAN}" class="empty">Loading persisted V2 sentiment analysis from Supabase...</td></tr>`;
    count.textContent = 'Loading...';
    if (pagination) pagination.innerHTML = '';
    return;
  }

  if (blueskyV2.error) {
    list.innerHTML = `<tr><td colspan="${COLSPAN}" class="empty error"><strong>⚠️ ${escapeHtml(blueskyV2.error)}</strong><br><small>Check that: (1) the analyse-posts cron has run, (2) completed_post_analyses_v2 view exists and is granted to anon</small></td></tr>`;
    count.textContent = 'Error';
    if (pagination) pagination.innerHTML = '';
    return;
  }

  if (!blueskyV2.posts.length) {
    list.innerHTML = `<tr><td colspan="${COLSPAN}" class="empty">No completed V2 analyses available yet.</td></tr>`;
    count.textContent = 'No data';
    if (pagination) pagination.innerHTML = '';
    return;
  }

  const totalCount = blueskyV2.totalCount || blueskyV2.posts.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / REVIEW_PAGE_SIZE));
  const firstRow = (reviewPage - 1) * REVIEW_PAGE_SIZE + 1;
  const lastRow = firstRow + blueskyV2.posts.length - 1;

  count.textContent = `${number.format(totalCount)} V2 analyzed posts`;
  if (pagination) {
    pagination.innerHTML = `<button type="button" id="reviewPrevPage" ${reviewPage <= 1 ? 'disabled' : ''}>Previous</button><span>Rows ${number.format(firstRow)}-${number.format(lastRow)} of ${number.format(totalCount)} · Page ${reviewPage} of ${totalPages}</span><button type="button" id="reviewNextPage" ${reviewPage >= totalPages ? 'disabled' : ''}>Next</button>`;
    const prevButton = $('reviewPrevPage');
    const nextButton = $('reviewNextPage');
    if (prevButton) prevButton.addEventListener('click', () => loadReviewData(reviewPage - 1));
    if (nextButton) nextButton.addEventListener('click', () => loadReviewData(reviewPage + 1));
  }

  list.innerHTML = blueskyV2.posts.map((post) => {
    const topicNames = post.topics.map((item) => typeof item === 'string' ? item : item.name).filter(Boolean).map(humanizeLabel);
    const rows = [`
    <tr>
      <td data-label="Published (UTC)">${escapeHtml(post.timestamp)}</td>
      <td data-label="Author">@${escapeHtml(post.author)}</td>
      <td data-label="Language">${escapeHtml(post.originalLanguage || 'Unknown')}</td>
      <td class="post-text" data-label="Post text">${escapeHtml(post.text)}</td>
      <td data-label="Score (0-100)"><span class="sentiment-score ${sentimentClass(post.displayScore)}" style="background: ${scoreColor(post.displayScore)}">${post.displayScore}%</span></td>
      <td data-label="Sentiment"><small>${escapeHtml(humanizeLabel(post.sentiment))}</small></td>
      <td data-label="Tools mentioned">${post.toolsMentioned.length > 0 ? escapeHtml(post.toolsMentioned.join(', ')) : 'N/A'}</td>
      <td data-label="Topics">${topicNames.length > 0 ? escapeHtml(topicNames.join(', ')) : 'N/A'}</td>
      <td data-label="Confidence"><small>${(post.confidence * 100).toFixed(0)}%</small></td>
      <td data-label="Provider"><small>${escapeHtml(post.provider)}</small></td>
      <td data-label="Processed (UTC)">${escapeHtml(post.processedTimestamp)}</td>
      <td data-label="Details"><button type="button" class="review-details-toggle" data-uri="${escapeHtml(post.uri)}">${expandedReviewRow === post.uri ? 'Hide' : 'View'}</button></td>
      <td data-label="Verification"><a class="post-link" href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer">Open</a></td>
    </tr>`];

    if (expandedReviewRow === post.uri) {
      rows.push(`
    <tr class="review-details-row">
      <td colspan="${COLSPAN}">
        <div class="review-details-card">
          <div><b>Raw sentiment_score</b><span>${post.sentimentScore ?? 'N/A'}</span></div>
          <div><b>Confidence</b><span>${(post.confidence * 100).toFixed(0)}%</span></div>
          <div><b>Emotions</b><span>${post.emotions.length ? escapeHtml(post.emotions.map((e) => typeof e === 'string' ? humanizeLabel(e) : `${humanizeLabel(e.name)} (${Math.round((e.intensity || 0) * 100)}%)`).join(', ')) : 'N/A'}</span></div>
          <div><b>AI tooling stance</b><span>${escapeHtml(aiStanceLabel(post.aiStance))}</span></div>
          <div><b>Deployment</b><span>${escapeHtml(post.deployment)}</span></div>
          <div><b>Model</b><span>${escapeHtml(post.model)}</span></div>
          <div><b>Prompt version</b><span>${escapeHtml(post.promptVersion)}</span></div>
          <div class="review-details-rationale"><b>Rationale</b><span>${escapeHtml(post.rationale)}</span></div>
        </div>
      </td>
    </tr>`);
    }
    return rows.join('');
  }).join('');

  list.querySelectorAll('.review-details-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const uri = button.dataset.uri;
      expandedReviewRow = expandedReviewRow === uri ? null : uri;
      renderV2Review();
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

document.getElementById('timeFilter')?.addEventListener('change', (event) => {
  state.time = event.target.value;
  renderDashboard(selectedData());
});

document.getElementById('emotionFilter')?.addEventListener('change', (event) => {
  state.emotion = event.target.value;
  renderDashboard(selectedData());
});

document.getElementById('topicFilter')?.addEventListener('change', (event) => {
  state.topic = event.target.value;
  renderDashboard(selectedData());
});

document.getElementById('sortTopics')?.addEventListener('change', (event) => {
  state.sort = event.target.value;
  renderTopics(selectedData().topics);
});

document.getElementById('resetFilters')?.addEventListener('click', () => {
  state.time = '7d';
  state.emotion = 'all';
  state.topic = 'all';
  $('timeFilter').value = state.time;
  $('emotionFilter').value = state.emotion;
  $('topicFilter').value = state.topic;
  renderDashboard(selectedData());
});

document.getElementById('refreshBluesky')?.addEventListener('click', async () => {
  await Promise.all([loadDashboardV2(), loadReviewData(reviewPage)]);
});

document.getElementById('reviewSource')?.addEventListener('change', (event) => {
  reviewSource = event.target.value;
  reviewPage = 1;
  expandedReviewRow = null;
  loadReviewData(1);
});

document.getElementById('emotionList')?.addEventListener('click', (event) => {
  const button = event.target.closest('.emotion-row');
  if (button) {
    state.emotion = state.emotion === button.dataset.emotion ? 'all' : button.dataset.emotion;
    $('emotionFilter').value = state.emotion;
    renderDashboard(selectedData());
  }
});

document.getElementById('topicList')?.addEventListener('click', (event) => {
  const row = event.target.closest('.topic-row');
  if (row) {
    state.topic = state.topic === row.dataset.topic ? 'all' : row.dataset.topic;
    $('topicFilter').value = state.topic;
    renderDashboard(selectedData());
  }
});

// Initial load
async function init() {
  // Render the empty archive state while the persisted data loads.
  renderDashboard(selectedData());
  
  // Load persisted V2 (Foundry) sentiment analyses for the main dashboard,
  // and the legacy archive for the Data review tab's default Legacy source.
  await Promise.all([loadDashboardV2(), loadArchive()]);
  const archiveData = selectedData();
  const emotionOptions = [...new Set(dashboardV2.allPosts.flatMap((post) => parseArray(post.emotions).map((item) => typeof item === 'string' ? item : item.label)).filter(Boolean))];
  const topicOptions = [...new Set(dashboardV2.allPosts.flatMap((post) => parseArray(post.topics)).filter(Boolean))];
  $('emotionFilter').innerHTML = '<option value="all">All emotions</option>' + emotionOptions.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(humanizeLabel(name))}</option>`).join('');
  $('topicFilter').innerHTML = '<option value="all">All topics</option>' + topicOptions.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(humanizeLabel(name))}</option>`).join('');
  renderDashboard(archiveData);
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

function initializeAnimations() {
  const animatedSections = document.querySelectorAll('.section-animate');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    animatedSections.forEach((element) => element.classList.add('visible'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });
  animatedSections.forEach((element) => observer.observe(element));
}

// Start application
window.addEventListener('DOMContentLoaded', () => {
  initializeAnimations();
  init();
});
