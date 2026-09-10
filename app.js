// Full-history dashboard metrics now come from the server aggregate
// (public.get_dashboard_v2()); there is no client-side time/emotion/topic
// filter state anymore (the filter controls were removed previously; the
// topic-scoped trend chart is driven solely by `trendTopic`).
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US');
const ARCHIVE_REFRESH_MS = 5 * 60 * 1000;
const SUPABASE_URL = 'https://bsnzcspfrmlihwxqkjyv.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_JXgoo-lTxuflm4CakgfuTQ_IH3AZ6V9';
const REVIEW_SEARCH_DEBOUNCE_MS = 400;
const TRANSIENT_REQUEST_RETRY_DELAY_MS = 300;
const bluesky = { posts: [], isLoading: false, error: '', totalCount: 0 };
const blueskyV2 = { posts: [], isLoading: false, error: '', totalCount: 0 };
// Dedicated dataset for the main Dashboard/map view, sourced from the
// server-aggregated public.get_dashboard_v2() RPC (all completed Foundry
// prompt versions). Fully independent from `bluesky`/`blueskyV2`, which
// continue to back the Data review tab's Legacy/V2 toggle.
//   - aggregate: the full-history totals/topics/emotions/trend payload.
//   - recent: the bounded recent-post feed (labelled as such in the UI);
//     never treated as, or merged into, a pretend full archive.
const dashboardV2 = { aggregate: null, recent: [], isLoading: false, error: '', totalCount: 0, lastLoadedAt: null };
const REVIEW_PAGE_SIZE = 100;
// Monotonically increasing request counters, used to discard stale/out-of-order
// responses (e.g. an older keystroke's request resolving after a newer one),
// which would otherwise overwrite the feed with results for a different search term.
const review = {
  source: 'v2', // 'legacy' | 'v2' -- Latest model (Foundry) is the default on open
  page: 1,
  searchTerm: '',
  expandedUri: null,
  requestSeq: { legacy: 0, v2: 0 },
};
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
  return stance === 'not_applicable' || !stance ? 'Not applicable' : humanizeLabel(stance);
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

// Different internal topic keys can humanize to the same display label (e.g.
// "reliability" and "reliability_issues" both read as "Reliability"). Merge
// those into a single entry so the topic cloud doesn't show duplicates.
function mergeTopics(topics) {
  const byName = new Map();
  for (const topic of topics) {
    const key = topic.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...topic });
      continue;
    }
    const totalVolume = existing.volume + topic.volume;
    existing.sentiment = totalVolume > 0
      ? (existing.sentiment * existing.volume + topic.sentiment * topic.volume) / totalVolume
      : existing.sentiment;
    existing.volume = totalVolume;
    existing.impact = (existing.impact || 0) + (topic.impact || 0);
    existing.lowSample = existing.lowSample && topic.lowSample;
  }
  return Array.from(byName.values()).sort((first, second) => second.volume - first.volume);
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



// Hourly bucket granularity, matching the server-side get_dashboard_v2()/
// get_dashboard_v2_trend() aggregation. Kept here only for the chart's
// front-loaded-bootstrap-period trim below (client-side rendering concern),
// not for any client-side aggregation.
const HOUR_MS = 60 * 60 * 1000;

// Full-history metrics, topic cloud, emotion list, and stance now come
// directly from the server aggregate (public.get_dashboard_v2()) rather than
// being recomputed client-side from a downloaded archive. `time`/`emotion`
// filters are no longer supported (the filter controls were removed; see the
// top-of-file note) -- only `topic` remains, driving the trend chart only.
function archiveDashboardData() {
  const aggregate = dashboardV2.aggregate;
  if (!aggregate) {
    return { score: 0, items: 0, confidence: 'N/A', emotions: [], topics: [], stance: 'N/A', stanceCount: 0 };
  }
  const topics = mergeTopics((aggregate.topics || [])
    .filter((topic) => humanizeLabel(topic.name).toLowerCase() !== 'other')
    .map((topic) => ({
      id: topic.name,
      name: humanizeLabel(topic.name),
      volume: topic.volume,
      sentiment: topic.avg_score,
      emotion: '',
      impact: topic.impact,
      lowSample: topic.low_sample,
    })));
  const emotions = (aggregate.emotions || []).map((emotion) => [emotion.name, emotion.count]);
  const stance = aggregate.totals?.stance;
  const stanceCount = aggregate.totals?.stance_count || 0;
  return {
    score: aggregate.totals?.avg_score ?? 0,
    items: aggregate.totals?.count ?? 0,
    confidence: aggregate.totals?.avg_confidence != null ? `${aggregate.totals.avg_confidence}%` : 'N/A',
    emotions,
    topics,
    stance: !stance || stance === 'not_applicable' ? 'N/A' : `${humanizeLabel(stance)} (${stanceCount})`,
    stanceCount,
  };
}

// Converts a server-computed trend payload (either the "all topics" section
// embedded in get_dashboard_v2(), or a topic-scoped get_dashboard_v2_trend()
// response) into the {points, score, items} shape the chart renderer expects.
// Buckets with fewer than the server's minimum sample size already arrive
// with score: null (no interpolation); this function only reshapes them for
// rendering, it performs no aggregation of its own.
function trendSeriesFromBuckets(buckets) {
  if (!buckets || !buckets.length) return { points: [], score: null, items: 0 };

  // The archive is front-loaded with a sparse bootstrap/backfill period, so
  // anchoring the axis to the full span would leave the line crushed against
  // one edge and make the early, thinly-sampled period look meaningful. The
  // displayed range is hardcoded to start at the first bucket that captures
  // meaningful, continuous data collection; earlier buckets are still present
  // in the underlying data/aggregation, they are simply not displayed.
  const CHART_START_MS = Date.UTC(2026, 8, 2, 9, 0, 0); // Sep 2, 09:00 UTC
  const byKey = new Map(buckets.map((bucket) => [Math.floor(new Date(bucket.bucket_start).getTime() / HOUR_MS), bucket]));
  const keys = [...byKey.keys()].sort((first, second) => first - second);
  const start = Math.floor(CHART_START_MS / HOUR_MS);
  const end = keys.length ? keys[keys.length - 1] : start;

  const points = [];
  for (let key = start; key <= end; key += 1) {
    const bucket = byKey.get(key);
    points.push({
      start: key * HOUR_MS,
      count: bucket ? bucket.count : 0,
      score: bucket && bucket.score !== null && bucket.score !== undefined ? Math.round(bucket.score) : null,
    });
  }
  // Report over the charted window so the headline number and the line agree.
  // Uses each bucket's raw (unrounded, un-suppressed) average so the headline
  // reflects every post in the window, not just buckets solid enough to draw.
  const windowKeys = keys.filter((key) => key >= start);
  const sourceKeys = windowKeys.length ? windowKeys : keys;
  const totals = sourceKeys.reduce((acc, key) => {
    const bucket = byKey.get(key);
    const rawAvg = bucket.raw_avg ?? bucket.score ?? 0;
    return { sum: acc.sum + rawAvg * bucket.count, count: acc.count + bucket.count };
  }, { sum: 0, count: 0 });
  const items = totals.count;
  const score = items ? Math.round(totals.sum / items) : null;
  return { points, score, items };
}

/**
 * Build a PostgREST `or=(...)` filter that matches a search term against
 * post_text, author_handle, and topics (JSONB array of strings or objects),
 * so search runs across the full archive at the database level instead of
 * only the currently loaded page.
 */
function buildReviewSearchFilter(term) {
  const trimmed = term.trim();
  if (!trimmed) return '';
  // Escape characters that are meaningful to PostgREST's filter syntax
  // (comma, parentheses) since they would otherwise break the or=(...) list.
  const escaped = trimmed.replace(/["\\,()]/g, '\\$&');
  const likeValue = `*${escaped}*`;
  return `or=(post_text.ilike.${likeValue},author_handle.ilike.${likeValue},topics.cs.["${escaped}"],topics.cs.[{"name":"${escaped}"}])`;
}

async function requestArchive(path, options = {}, retryTransientServerError = false) {
  const request = () => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      ...options.headers,
    },
  });
  let response = await request();
  if (retryTransientServerError && response.status >= 500 && response.status < 600) {
    await new Promise((resolve) => window.setTimeout(resolve, TRANSIENT_REQUEST_RETRY_DELAY_MS));
    response = await request();
  }
  if (!response.ok) throw new Error(`Archive returned ${response.status}`);
  if (response.status === 201 || response.status === 204 || response.headers.get('content-length') === '0') {
    return { data: null, totalCount: 0 };
  }
  const data = await response.json();
  const contentRange = response.headers.get('content-range'); // e.g. "0-99/955"
  const totalCount = contentRange ? Number(contentRange.split('/')[1]) : data.length;
  return { data, totalCount };
}

const REVIEW_V2_SELECT = 'post_uri,sentiment,sentiment_score,emotions,topics,tools_mentioned,'
  + 'ai_tooling_stance,confidence,rationale,provider,deployment,model,prompt_version,'
  + 'processed_at,post_text,author_handle,original_language,published_at,source_url';

const reviewSources = {
  legacy: {
    state: bluesky,
    view: 'completed_post_analyses',
    emptyMessage: 'No completed analyses yet. Check back soon.',
    errorLabel: 'archive',
    afterLoad: () => {
      renderBlueskyStatus();
      renderDashboard(selectedData());
    },
    mapRow: (analysis) => ({
      uri: analysis.post_uri,
      score: Math.round((analysis.score || 0) * 100),
      sentiment: {
        positive: 'Very positive',
        negative: 'Very negative',
        neutral: 'Mixed',
        mixed: 'Mixed',
      }[analysis.sentiment] || 'Unknown',
      confidence: analysis.confidence || 0,
      emotions: parseArray(analysis.emotions),
      topics: parseArray(analysis.topics),
      ai_stance: analysis.ai_tooling_stance || 'not_applicable',
      rationale: analysis.rationale || '',
      model: analysis.model || 'unknown',
      timestamp: formatTimestamp(analysis.published_at || analysis.created_at),
      publishedAt: analysis.published_at || analysis.created_at,
      url: analysis.source_url,
      text: analysis.post_text || '(post text unavailable)',
      author: analysis.author_handle || 'unknown',
      originalLanguage: analysis.original_language || 'unknown',
    }),
  },
  v2: {
    state: blueskyV2,
    view: 'completed_post_analyses_v2',
    select: REVIEW_V2_SELECT,
    emptyMessage: 'No completed V2 analyses yet. Check back soon.',
    errorLabel: 'V2 archive',
    mapRow: (analysis) => ({
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
    }),
  },
};

async function loadReviewArchive(source, page = review.page, searchTerm = review.searchTerm) {
  const descriptor = reviewSources[source];
  const requestId = ++review.requestSeq[source];
  const { state } = descriptor;
  try {
    state.isLoading = true;
    if (descriptor.afterLoad) descriptor.afterLoad();
    renderDataReview();
    review.page = page;

    const from = (page - 1) * REVIEW_PAGE_SIZE;
    const to = from + REVIEW_PAGE_SIZE - 1;
    const searchFilter = buildReviewSearchFilter(searchTerm);
    const queryParameters = [
      descriptor.select ? `select=${descriptor.select}` : '',
      'order=published_at.desc',
      searchFilter,
    ].filter(Boolean).join('&');
    const query = `${descriptor.view}?${queryParameters}`;
    const { data: analyses, totalCount } = await requestArchive(
      query,
      { headers: { Prefer: 'count=exact', Range: `${from}-${to}` } },
      Boolean(searchFilter)
    );

    if (requestId !== review.requestSeq[source]) return;
    state.totalCount = totalCount;
    if (!analyses || analyses.length === 0) {
      state.error = searchTerm.trim()
        ? `No posts match "${searchTerm.trim()}".`
        : descriptor.emptyMessage;
      state.posts = [];
    } else {
      state.posts = analyses.map(descriptor.mapRow);
      state.error = '';
    }
  } catch (error) {
    if (requestId !== review.requestSeq[source]) return;
    state.error = `Failed to load ${descriptor.errorLabel}: ${error.message}`;
    console.error(`${descriptor.errorLabel} load error:`, error);
  } finally {
    if (requestId === review.requestSeq[source]) {
      state.isLoading = false;
      if (descriptor.afterLoad) descriptor.afterLoad();
      renderDataReview();
    }
  }
}

function loadArchive(page = review.page, searchTerm = review.searchTerm) {
  return loadReviewArchive('legacy', page, searchTerm);
}

function loadArchiveV2(page = review.page, searchTerm = review.searchTerm) {
  return loadReviewArchive('v2', page, searchTerm);
}

/** Dispatch archive loading to the currently selected review source. */
async function loadReviewData(page = review.page, searchTerm = review.searchTerm) {
  if (review.source === 'v2') {
    await loadArchiveV2(page, searchTerm);
  } else {
    await loadArchive(page, searchTerm);
  }
}

/**
 * Load the compact, all-prompt-version dashboard aggregate (public.get_dashboard_v2())
 * for the main Dashboard/map view: one bounded server response instead of
 * paginating through the full completed_post_analyses_v2 archive. Full-history
 * metrics and trends remain historically accurate because aggregation happens
 * in SQL, not in the browser. The Data review tab's Legacy/V2 toggle remains
 * independent and continues to page through the archive directly.
 */
async function loadDashboardV2() {
  try {
    dashboardV2.isLoading = true;
    renderBlueskyStatus();

    const { data: aggregate } = await requestArchive('rpc/get_dashboard_v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    dashboardV2.totalCount = aggregate?.totals?.count || 0;

    if (!aggregate || !aggregate.totals?.count) {
      dashboardV2.error = 'No completed V2 analyses yet. Check back soon.';
      dashboardV2.aggregate = null;
      dashboardV2.recent = [];
    } else {
      dashboardV2.aggregate = aggregate;
      trendTopicCache = new Map();
      // Bounded recent feed only; never merged into a pretend full archive.
      dashboardV2.recent = (aggregate.recent || []).map((analysis) => ({
        uri: analysis.post_uri,
        score: analysis.display_score,
        sentiment: analysis.sentiment || 'unknown',
        confidence: analysis.confidence || 0,
        emotions: parseArray(analysis.emotions).map((item) => (
          typeof item === 'string' ? item : { label: item.name, confidence: item.intensity || 0 }
        )),
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
      }));
      dashboardV2.error = '';
    }
    dashboardV2.lastLoadedAt = new Date();
  } catch (error) {
    dashboardV2.error = `Failed to load V2 dashboard aggregate: ${error.message}`;
    console.error('Dashboard V2 aggregate load error:', error);
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
  return archiveDashboardData();
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
// Cache of topic-scoped trend payloads (public.get_dashboard_v2_trend()) so
// re-selecting a topic during the same session doesn't refetch. Invalidated
// whenever a fresh dashboard aggregate loads (see loadDashboardV2).
let trendTopicCache = new Map();

async function fetchTrendBuckets(topic) {
  if (topic === 'all') return dashboardV2.aggregate?.trend || [];
  if (trendTopicCache.has(topic)) return trendTopicCache.get(topic);
  const { data } = await requestArchive('rpc/get_dashboard_v2_trend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_topic: topic }),
  });
  const buckets = data?.trend || [];
  trendTopicCache.set(topic, buckets);
  return buckets;
}

async function renderTrend() {
  const container = $('trendChart');
  if (!container) return;
  const buckets = await fetchTrendBuckets(trendTopic);
  const { points, score, items } = trendSeriesFromBuckets(buckets);
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
      sentimentLabel: `AI Sentiment: ${humanizeLabel(post.sentiment)}`,
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
  if (review.source === 'v2') {
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
    if (searchStatus) searchStatus.textContent = review.searchTerm.trim() ? '0 hits' : '';
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
  const firstRow = (review.page - 1) * REVIEW_PAGE_SIZE + 1;
  const lastRow = firstRow + archiveState.posts.length - 1;

  count.textContent = `${number.format(totalCount)} ${countLabel}`;
  if (pagination) {
    pagination.innerHTML = `<button type="button" id="reviewPrevPage" ${review.page <= 1 ? 'disabled' : ''}>Previous</button><span>Showing ${number.format(firstRow)}-${number.format(lastRow)} of ${number.format(totalCount)} · Page ${review.page} of ${totalPages}</span><button type="button" id="reviewNextPage" ${review.page >= totalPages ? 'disabled' : ''}>Next</button>`;
    const prevButton = $('reviewPrevPage');
    const nextButton = $('reviewNextPage');
    if (prevButton) prevButton.addEventListener('click', () => loadReviewData(review.page - 1));
    if (nextButton) nextButton.addEventListener('click', () => loadReviewData(review.page + 1));
  }

  if (searchStatus) {
    searchStatus.textContent = review.searchTerm.trim()
      ? `${number.format(totalCount)} hit${totalCount === 1 ? '' : 's'}`
      : '';
  }

  const records = archiveState.posts.map((post) => toFeedRecord(post, source));

  list.innerHTML = records.map((record) => {
    const isExpanded = review.expandedUri === record.uri;
    const provenanceRows = Object.entries({
      ...(record.source === 'v2' ? { 'AI Sentiment score': record.provenance.rawScore } : {}),
      Confidence: `${(record.confidence * 100).toFixed(0)}%`,
      Emotions: record.provenance.emotions,
      [record.source === 'v2' ? 'Product/Tool Stance' : 'AI stance']: record.provenance.aiStance,
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
      review.expandedUri = review.expandedUri === uri ? null : uri;
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
    if (review.source === 'v2' && !blueskyV2.posts.length && !blueskyV2.isLoading && !blueskyV2.error) {
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
  review.source = event.target.value;
  review.page = 1;
  review.expandedUri = null;
  review.searchTerm = '';
  const searchInput = $('reviewSearch');
  if (searchInput) searchInput.value = '';
  loadReviewData(1);
});

// Server-side search: queries the full archive (not just the loaded page)
// via loadReviewData, debounced long enough to avoid an expensive full-archive
// request for every keystroke. Changing the search term always resets to page 1.
let reviewSearchDebounce = null;
document.getElementById('reviewSearch')?.addEventListener('input', (event) => {
  const value = event.target.value;
  const searchStatus = $('reviewSearchStatus');
  if (searchStatus && value.trim()) searchStatus.textContent = 'Searching…';
  window.clearTimeout(reviewSearchDebounce);
  reviewSearchDebounce = window.setTimeout(() => {
    review.searchTerm = value;
    review.expandedUri = null;
    loadReviewData(1, review.searchTerm);
  }, REVIEW_SEARCH_DEBOUNCE_MS);
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
    if (review.source === 'legacy') loadArchive(review.page);
    if (review.source === 'v2') loadArchiveV2(review.page);
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
  { quote: 'Human intelligence comes from learning. Artificial, "super," intelligence comes from stealing. Sounds about right.', author: '@paulallopenna.bsky.social', analysis: ['13% Negative', 'Ethics, Trust'] },
  { quote: 'Yet another AI researcher has come forward to warn us of possible human extinction from uncontrolled AI super intelligence, and their numbers keep growing. The danger is in AI recursive self improvement, not today’s models. therundownai.beehiiv.com/p/an-anthrop...', author: '@puffjnlee.bsky.social', analysis: ['13% Negative', 'Safety, Risk, Research'] },
  { quote: 'They have had scam ads running for years and not just meta, but Google as well. They should have been in prison for those scams already, but with this AI scam, they really need to go to prison.', author: '@wesmank.bsky.social', analysis: ['10% Negative', 'Trust, Safety, Ethics'] },
  { quote: 'Blame the creator of grok. (such a stupid name, grok😀)', author: '@doybo.bsky.social', analysis: ['20% Negative', 'Public Opinion, grok'] },
  { quote: 'No, this is me arguing that people pursuing original work and research cannot trust AI products under any circumstances.', author: '@qlippot.bsky.social', analysis: ['10% Negative', 'Trust, Research'] },
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
