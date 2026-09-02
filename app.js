const state = { time: '24h', emotion: 'all', topic: 'all', sort: 'impact' };
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US');
const ARCHIVE_REFRESH_MS = 5 * 60 * 1000;
const SUPABASE_URL = 'https://bsnzcspfrmlihwxqkjyv.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_JXgoo-lTxuflm4CakgfuTQ_IH3AZ6V9';
const bluesky = { posts: [], allPosts: [], isLoading: false, error: '', totalCount: 0 };
const REVIEW_PAGE_SIZE = 100;
let reviewPage = 1;
let activeView = 'dashboard';
let map;
let countryLayer;

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

function archiveDashboardData({ time = '24h', emotion = 'all', topic = 'all' } = {}) {
  const hours = { '1h': 1, '24h': 24, '7d': 24 * 7 }[time] || 24;
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const recentPosts = bluesky.allPosts.filter((post) => {
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
    return { id: name, name, volume: entry.volume, sentiment, emotion: '', impact: Number((sentiment - score).toFixed(1)) };
  }).sort((first, second) => second.volume - first.volume);
  const stanceCounts = new Map();
  posts.forEach((post) => stanceCounts.set(post.ai_stance, (stanceCounts.get(post.ai_stance) || 0) + 1));
  const stance = [...stanceCounts.entries()].sort((first, second) => second[1] - first[1])[0];
  const selectedTopic = topics.find((item) => item.id === topic);
  return {
    score,
    items: posts.length,
    confidence: confidence ? `${confidence}%` : 'N/A',
    emotions,
    topics,
    selectedTopic,
    selectedEmotion: emotions.find(([name]) => name === emotion),
    stance: stance ? `${stance[0]} (${stance[1]})` : 'N/A',
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

function selectedData() {
  return archiveDashboardData(state);
}

function renderDashboardMetrics(data) {
  $('moodScore').textContent = data.score;
  $('moodLabel').textContent = sentimentLabel(data.score);
  $('stanceSummary').textContent = data.stance;
  $('stanceNote').textContent = 'Most common classification (count)';
  $('sampleSize').textContent = number.format(data.items);
  $('sourceNote').textContent = 'Completed Bluesky analyses';
  $('confidence').textContent = data.confidence;
}

function renderDashboard(data) {
  renderDashboardMetrics(data);
  renderEmotions(data.emotions);
  renderTopics(data.topics);
  renderExplanation(data);
  renderSources(data);
}

function renderEmotions(emotions) {
  $('dominantEmotion').textContent = `Dominant: ${emotions[0]?.[0] || 'N/A'}`;
  $('emotionList').innerHTML = emotions.length
    ? emotions.map(([name, share]) => `<button class="emotion-row ${state.emotion === name ? 'selected' : ''}" data-emotion="${name}" type="button"><span>${escapeHtml(name)}</span><div class="bar"><i style="width:${share}%"></i></div><strong>${share}%</strong></button>`).join('')
    : '<p class="empty">No emotion data for the selected analyses.</p>';
}

function renderTopics(topics) {
  const sorted = [...topics].sort((first, second) => state.sort === 'volume' ? second.volume - first.volume : Math.abs(second.impact) - Math.abs(first.impact));
  $('topicList').innerHTML = sorted.length ? sorted.map((topic) => `<tr class="topic-row ${state.topic === topic.id ? 'selected' : ''}" data-topic="${topic.id}"><td><b>${escapeHtml(topic.name)}</b><span>Analyzed posts</span></td><td>${number.format(topic.volume)}</td><td><span class="score-dot" style="background:${scoreColor(topic.sentiment)}"></span>${topic.sentiment}</td><td class="${topic.impact >= 0 ? 'impact-positive' : 'impact-negative'}">${signed(topic.impact, ' pts')}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No topics match this filter.</td></tr>';
}

function renderExplanation(data) {
  const focus = data.selectedTopic
    ? `${data.selectedTopic.name} is the active lens, with a sentiment score of ${data.selectedTopic.sentiment}.`
    : bluesky.allPosts.length
      ? 'The dashboard is aggregating the completed analyses currently available in the archive.'
      : 'Clean energy and international football are the strongest positive associations, while severe weather and cost-of-living discussion pull in the opposite direction.';
  const leadingEmotion = data.emotions[0]?.[0] || 'No dominant emotion';
  $('explanation').textContent = data.items
    ? `Public mood is ${sentimentLabel(data.score).toLowerCase()} at ${data.score}/100, based on ${number.format(data.items)} analyzed posts. ${focus} ${leadingEmotion} is the leading emotion in the selected data.`
    : 'No completed analyses match the selected filters. Widen the time window or reset the filters to see a data-backed summary.';
  $('evidence').innerHTML = data.topics.slice(0, 3).map((topic) => `<button data-topic="${topic.id}" type="button"><b>${escapeHtml(topic.name)}</b><span>${signed(topic.impact, ' pts')} vs overall score</span></button>`).join('');
}

function renderSources(data) {
  if (data.posts.length) {
    $('sourceList').innerHTML = data.posts.slice(0, 3).map((post) => `<div class="source"><span>Bluesky AI sample</span><p>"${escapeHtml(post.text)}"</p><b>${escapeHtml(post.timestamp)}</b></div>`).join('');
    return;
  }
  $('sourceList').innerHTML = '<div class="source"><span>Archive</span><p>No completed analyses match the selected filters.</p><b>Try a wider time window or reset filters</b></div>';
}

function renderDataReview() {
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
    if (prevButton) prevButton.addEventListener('click', () => loadArchive(reviewPage - 1));
    if (nextButton) nextButton.addEventListener('click', () => loadArchive(reviewPage + 1));
  }

  list.innerHTML = bluesky.posts.map((post) => `
    <tr>
      <td>${escapeHtml(post.timestamp)}</td>
      <td>@${escapeHtml(post.author)}</td>
      <td>${escapeHtml(post.originalLanguage || 'Unknown')}</td>
      <td class="post-text">${escapeHtml(post.text)}</td>
      <td>
        <span class="sentiment-score" style="background: ${scoreColor(post.score)}">${post.score}%</span>
        <br><small>${escapeHtml(post.sentiment)}</small>
      </td>
      <td><small>${(post.confidence * 100).toFixed(0)}%</small></td>
      <td title="${post.emotions.map(e => `${e.label} (${(e.confidence * 100).toFixed(0)}%)`).join(', ')}">
        ${post.emotions.length > 0 ? post.emotions.slice(0, 2).map(e => escapeHtml(e.label)).join(', ') : 'N/A'}
      </td>
      <td>${post.topics.length > 0 ? escapeHtml(post.topics.join(', ')) : 'N/A'}</td>
      <td>${escapeHtml(post.ai_stance)}</td>
      <td class="rationale" title="${escapeHtml(post.rationale)}"><small>${escapeHtml(post.rationale.substring(0, 40))}${post.rationale.length > 40 ? '...' : ''}</small></td>
      <td><a class="post-link" href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer">Open</a></td>
    </tr>
  `).join('');
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
  if (view === 'data-review') renderDataReview();
}

function renderBlueskyStatus() {
  const status = $('blueskyStatus');
  if (bluesky.isLoading) {
    status.innerHTML = '⏳ Loading persisted sentiment analysis...';
    status.className = 'loading';
  } else if (bluesky.error) {
    status.innerHTML = `⚠️ ${escapeHtml(bluesky.error)}`;
    status.className = 'error';
  } else if (bluesky.totalCount > 0) {
    status.innerHTML = `✓ ${number.format(bluesky.totalCount)} posts with completed sentiment analysis`;
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
  state.time = '24h';
  state.emotion = 'all';
  state.topic = 'all';
  $('timeFilter').value = state.time;
  $('emotionFilter').value = state.emotion;
  $('topicFilter').value = state.topic;
  renderDashboard(selectedData());
});

document.getElementById('refreshBluesky')?.addEventListener('click', () => loadArchive(reviewPage));

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
  
  // Load persisted sentiment analyses
  await loadArchive();
  const archiveData = selectedData();
  const emotionOptions = [...new Set(bluesky.allPosts.flatMap((post) => parseArray(post.emotions).map((item) => typeof item === 'string' ? item : item.label)).filter(Boolean))];
  const topicOptions = [...new Set(bluesky.allPosts.flatMap((post) => parseArray(post.topics)).filter(Boolean))];
  $('emotionFilter').innerHTML = '<option value="all">All emotions</option>' + emotionOptions.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  $('topicFilter').innerHTML = '<option value="all">All topics</option>' + topicOptions.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  renderDashboard(archiveData);
  
  // Refresh archive periodically (reload current page)
  setInterval(() => loadArchive(reviewPage), ARCHIVE_REFRESH_MS);
}

// Start application
window.addEventListener('DOMContentLoaded', init);
