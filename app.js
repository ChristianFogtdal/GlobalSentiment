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
let reviewSource = 'legacy'; // 'legacy' | 'v2'
let expandedReviewRow = null; // post_uri of the row whose details expander is open (V2 only)
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
  scoreEl.textContent = data.items ? data.score : '--';
  scoreEl.style.color = data.items ? scoreColor(data.score) : 'var(--text-muted)';
  $('sampleSize').textContent = number.format(data.items);
}

function renderDashboard(data) {
  renderDashboardMetrics(data);
  renderEmotions(data.emotions);
  renderTopics(data.topics);
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

document.getElementById('reviewSource')?.addEventListener('change', (event) => {
  reviewSource = event.target.value;
  reviewPage = 1;
  expandedReviewRow = null;
  loadReviewData(1);
});

// Initial load
async function init() {
  // Render the empty archive state while the persisted data loads.
  renderDashboard(selectedData());
  
  // Load persisted V2 (Foundry) sentiment analyses for the main dashboard,
  // and the legacy archive for the Data review tab's default Legacy source.
  await Promise.all([loadDashboardV2(), loadArchive()]);
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

// Start application
window.addEventListener('DOMContentLoaded', () => {
  initializeAnimations();
  init();
});
