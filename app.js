const state = { time: '24h', emotion: 'all', topic: 'all', sort: 'impact' };
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US');
const BLUESKY_AI_ACCOUNTS = ['openaibot.bsky.social', 'emollick.bsky.social', 'garymarcus.bsky.social'];
const BLUESKY_POST_LIMIT = 10;
const BLUESKY_POSTS_PER_ACCOUNT = 5;
const BLUESKY_REFRESH_MS = 5 * 60 * 1000;
const bluesky = { posts: [], isLoading: false, lastRequestAt: 0, error: '' };
let activeView = 'dashboard';
let map;
let countryLayer;

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
function isAiRelated(text) {
  return /\b(ai|artificial intelligence|llm|language model|chatgpt|gpt|claude|gemini|machine learning|deep learning|neural network|model|models)\b/i.test(text);
}
function selectedData() { return MoodData.getDashboardData(state); }

function renderTrend(trend) {
  const points = trend.map((value, index) => `${index * (350 / (trend.length - 1))},${65 - (value - 45) * 2.5}`).join(' ');
  $('trendChart').innerHTML = `<polyline points="${points}" fill="none" stroke="#2c7f7b" stroke-width="3" vector-effect="non-scaling-stroke"/><circle cx="350" cy="${65 - (trend.at(-1) - 45) * 2.5}" r="4" fill="#ec7657"/>`;
}
function renderEmotions(emotions) {
  $('dominantEmotion').textContent = `Dominant: ${emotions[0][0]}`;
  $('emotionList').innerHTML = emotions.map(([name, share, change]) => `<button class="emotion-row ${state.emotion === name ? 'selected' : ''}" data-emotion="${name}" type="button"><span>${name}</span><div class="bar"><i style="width:${share}%"></i></div><strong>${share}%</strong><small class="${change >= 0 ? 'up' : 'down'}">${signed(change, ' pts')}</small></button>`).join('');
}
function renderTopics(topics) {
  const sorted = [...topics].sort((first, second) => state.sort === 'volume' ? second.volume - first.volume : state.sort === 'growth' ? second.growth - first.growth : Math.abs(second.impact) - Math.abs(first.impact));
  $('topicList').innerHTML = sorted.length ? sorted.map((topic) => `<tr class="topic-row ${state.topic === topic.id ? 'selected' : ''}" data-topic="${topic.id}"><td><b>${topic.name}</b><span>${topic.emotion} · ${topic.growth > 0 ? '+' : ''}${topic.growth}%</span></td><td>${number.format(topic.volume)}</td><td><span class="score-dot" style="background:${scoreColor(topic.sentiment)}"></span>${topic.sentiment}</td><td class="${topic.impact >= 0 ? 'impact-positive' : 'impact-negative'}">${signed(topic.impact, ' pts')}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No demo topics match this filter.</td></tr>';
}
function renderExplanation(data) {
  const focus = data.selectedTopic ? `${data.selectedTopic.name} is the active lens, with a sentiment score of ${data.selectedTopic.sentiment}.` : 'Clean energy and international football are the strongest positive associations, while severe weather and cost-of-living discussion pull in the opposite direction.';
  $('explanation').textContent = `Public mood is ${sentimentLabel(data.score).toLowerCase()} at ${data.score}/100, ${data.change >= 0 ? 'up' : 'down'} ${Math.abs(data.change)} points from the equivalent prior period. ${focus} Hope is the leading emotion, while anxiety has increased alongside weather-related conversation. The strongest change is visible in Germany and the United Kingdom.`;
  $('evidence').innerHTML = data.topics.slice(0, 3).map((topic) => `<button data-topic="${topic.id}" type="button"><b>${topic.name}</b><span>${signed(topic.impact, ' pts')} mood impact</span></button>`).join('');
}
function renderShifts(data) {
  $('shiftList').innerHTML = `<button class="shift" data-topic="weather" type="button"><span class="shift-badge down">Major decrease</span><div><b>Weather concern accelerated</b><p>Started 13:00 UTC · score 71 to 56 in affected markets</p><span>Associated with severe weather mentions, up 186%</span></div><strong>-15</strong></button><button class="shift" data-topic="clean-energy" type="button"><span class="shift-badge up">Minor increase</span><div><b>Hope grew around clean energy</b><p>Started 08:00 UTC · score 58 to ${data.score}</p><span>Most visible in Canada and Germany</span></div><strong>+${data.change}</strong></button>`;
}
function renderSources(data) {
  if (bluesky.posts.length) {
    $('sourceList').innerHTML = bluesky.posts.slice(0, 3).map((post) => `<div class="source"><span>Bluesky AI sample</span><p>“${escapeHtml(post.text)}”</p><b>${escapeHtml(post.timestamp)}</b></div>`).join('');
    return;
  }
  const sources = data.topics.slice(0, 3).map((topic, index) => ({ source: ['Public forum', 'News comments', 'Video comments'][index], topic: topic.name, text: [`Discussion about ${topic.name.toLowerCase()} is gathering pace across multiple permitted public sources.`, `Representative, deduplicated discussion signal linked to ${topic.name.toLowerCase()}.`, `Aggregate signal reflects public reaction; individual authors are not profiled.`][index] }));
  $('sourceList').innerHTML = sources.map((item) => `<div class="source"><span>${item.source}</span><p>“${item.text}”</p><b>${item.topic}</b></div>`).join('');
}

function analysePost(text) {
  const normalizedText = text.toLowerCase();
  const sentimentRules = [
    { terms: ['advance', 'advanced', 'improve', 'improved', 'safe', 'safeguard', 'accessible', 'benefit', 'progress'], score: 8, label: 'positive' },
    { terms: ['risk', 'risks', 'harm', 'threat', 'outage', 'concern', 'failure', 'critical'], score: -10, label: 'negative' },
  ];
  const topicRules = [
    { topic: 'AI safety', emotion: 'Caution', terms: ['safety', 'safe', 'safeguard', 'preparedness', 'risk', 'harm'] },
    { topic: 'Model evaluation', emotion: 'Curiosity', terms: ['evaluated', 'evaluation', 'benchmark', 'capability', 'capabilities', 'model'] },
    { topic: 'Cybersecurity', emotion: 'Concern', terms: ['cybersecurity', 'security', 'critical threshold'] },
    { topic: 'AI releases', emotion: 'Excitement', terms: ['release', 'preview', 'launch', 'announcing'] },
    { topic: 'AI research', emotion: 'Curiosity', terms: ['research', 'learn', 'learning', 'science'] },
  ];
  const matches = [];
  let score = 50;
  for (const rule of sentimentRules) {
    const matchedTerms = rule.terms.filter((term) => matchesTerm(normalizedText, term));
    if (matchedTerms.length) {
      score += rule.score * matchedTerms.length;
      matches.push(...matchedTerms.map((term) => `${rule.label}: ${term}`));
    }
  }
  const matchedTopics = topicRules.map((rule) => ({ ...rule, matchedTerms: rule.terms.filter((term) => matchesTerm(normalizedText, term)) })).filter((rule) => rule.matchedTerms.length);
  const leadingTopic = matchedTopics.sort((first, second) => second.matchedTerms.length - first.matchedTerms.length)[0];
  if (leadingTopic) matches.push(...leadingTopic.matchedTerms.map((term) => `topic: ${term}`));
  score = Math.max(0, Math.min(100, score));
  return {
    score,
    sentiment: sentimentLabel(score),
    mood: score >= 60 ? 'Upbeat' : score <= 40 ? 'Downbeat' : 'Mixed',
    emotion: leadingTopic?.emotion || 'Neutral',
    topic: leadingTopic?.topic || 'General AI',
    evidence: matches.length ? matches.join('; ') : 'No configured rule matched',
  };
}

function renderDataReview() {
  const list = $('dataReviewList');
  const count = $('reviewCount');
  if (!bluesky.posts.length) {
    list.innerHTML = `<tr><td colspan="9" class="empty">${bluesky.isLoading ? 'Loading the public Bluesky sample...' : 'No Bluesky sample has been loaded yet.'}</td></tr>`;
    count.textContent = 'Waiting for sample';
    return;
  }
  count.textContent = `${bluesky.posts.length} cleaned posts`;
  list.innerHTML = bluesky.posts.map((post) => {
    const analysis = analysePost(post.text);
    return `<tr><td>${escapeHtml(post.timestamp)}</td><td>@${escapeHtml(post.author)}</td><td class="post-text">${escapeHtml(post.text)}</td><td>${analysis.score}/100<br><span>${escapeHtml(analysis.sentiment)}</span></td><td>${escapeHtml(analysis.mood)}</td><td>${escapeHtml(analysis.emotion)}</td><td>${escapeHtml(analysis.topic)}</td><td class="rule-evidence">${escapeHtml(analysis.evidence)}</td><td><a class="post-link" href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer">Open post</a></td></tr>`;
  }).join('');
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
  const button = $('refreshBluesky');
  const status = $('blueskyStatus');
  button.disabled = bluesky.isLoading;
  if (bluesky.isLoading) {
    button.textContent = 'Loading Bluesky sample...';
    status.textContent = `${BLUESKY_AI_ACCOUNTS.length} public requests · up to ${BLUESKY_POST_LIMIT} AI posts`;
  } else if (bluesky.posts.length) {
    button.textContent = 'Refresh Bluesky AI sample';
    status.textContent = bluesky.error || `${bluesky.posts.length} posts from ${new Set(bluesky.posts.map((post) => post.author)).size} AI sources · refreshes every 5 minutes`;
  } else if (bluesky.error) {
    button.textContent = 'Retry Bluesky AI sample';
    status.textContent = bluesky.error;
  } else {
    button.textContent = 'Refresh Bluesky AI sample';
    status.textContent = `Auto-refreshes every 5 minutes · up to ${BLUESKY_POST_LIMIT} AI posts`;
  }
}

async function loadBlueskySample() {
  if (bluesky.isLoading) return;
  bluesky.isLoading = true;
  bluesky.error = '';
  renderBlueskyStatus();
  renderDataReview();
  try {
    const feeds = await Promise.all(BLUESKY_AI_ACCOUNTS.map(async (account) => {
      const parameters = new URLSearchParams({ actor: account, limit: String(BLUESKY_POSTS_PER_ACCOUNT) });
      const response = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?${parameters}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`Bluesky returned ${response.status} for ${account}`);
      const payload = await response.json();
      return payload.feed || [];
    }));
    bluesky.posts = feeds.flat()
      .map((item) => item.post)
      .filter((post) => typeof post?.record?.text === 'string' && post.record.text.trim())
      .filter((post) => isAiRelated(post.record.text))
      .sort((first, second) => new Date(second.indexedAt) - new Date(first.indexedAt))
      .slice(0, BLUESKY_POST_LIMIT)
      .map((post) => {
        const rkey = post.uri.split('/').at(-1);
        return {
          text: post.record.text.replace(/\s+/g, ' ').trim(),
          author: post.author.handle,
          timestamp: new Date(post.indexedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC',
          url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
        };
      });
    if (!bluesky.posts.length) throw new Error('No public AI posts were available.');
    bluesky.lastRequestAt = Date.now();
    renderSources(selectedData());
    renderDataReview();
  } catch (error) {
    bluesky.error = `Could not load Bluesky: ${error.message}`;
  } finally {
    bluesky.isLoading = false;
    renderBlueskyStatus();
    renderDataReview();
  }
}
function renderMap(countries) {
  if (!countryLayer) return;
  const countriesByBoundaryId = new Map(countries.map((country) => [country.boundaryId, country]));
  countryLayer.eachLayer((layer) => {
    const country = countriesByBoundaryId.get(layer.feature.id);
    layer.setStyle(country ? {
      color: '#fffdf8',
      fillColor: scoreColor(country.score),
      fillOpacity: 0.78,
      opacity: 0.85,
      weight: 1.25,
    } : {
      color: '#cbd5d0',
      fillColor: '#dfe7e2',
      fillOpacity: 0.28,
      opacity: 0.55,
      weight: 0.5,
    });
    if (country) {
      layer.bindPopup(`<div class="popup"><b>${country.name}</b><strong>${country.score}/100 ${sentimentLabel(country.score)}</strong><span>${signed(country.change, ' pts')} · ${number.format(country.items)} items · ${country.confidence} confidence</span><p>${country.emotion}: ${country.topics.join(', ')}</p></div>`);
    } else {
      layer.unbindPopup();
    }
  });
}

async function loadCountryBoundaries() {
  const response = await fetch('https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json');
  if (!response.ok) throw new Error(`Unable to load world boundaries: ${response.status}`);
  const boundaries = await response.json();
  countryLayer = L.geoJSON(boundaries, {
    style: {
      color: '#cbd5d0',
      fillColor: '#dfe7e2',
      fillOpacity: 0.28,
      opacity: 0.55,
      weight: 0.5,
    },
  }).addTo(map);
  renderMap(selectedData().countries);
}
function render() {
  const data = selectedData();
  $('moodScore').textContent = data.score;
  $('moodLabel').textContent = sentimentLabel(data.score);
  $('movement').textContent = signed(data.change, ' pts');
  $('movement').className = data.change >= 0 ? 'positive' : 'negative';
  $('movementNote').textContent = 'vs previous equivalent period';
  $('sampleSize').textContent = number.format(data.items);
  $('sourceNote').textContent = '3 permitted public sources';
  $('confidence').textContent = data.confidence;
  $('trendRange').textContent = state.time === '1h' ? 'Last 60 minutes' : state.time === '7d' ? 'Last 7 days' : 'Last 24 hours';
  $('updatedAt').textContent = 'Updated 14:30 UTC';
  renderTrend(data.trend); renderEmotions(data.emotions); renderTopics(data.topics); renderExplanation(data); renderShifts(data); renderSources(data); renderMap(data.countries);
}
function bindEvents() {
  $('timeFilter').onchange = (event) => { state.time = event.target.value; render(); };
  $('emotionFilter').onchange = (event) => { state.emotion = event.target.value; render(); };
  $('topicFilter').onchange = (event) => { state.topic = event.target.value; render(); };
  $('sortTopics').onchange = (event) => { state.sort = event.target.value; render(); };
  $('refreshBluesky').onclick = loadBlueskySample;
  document.querySelectorAll('.view-tab').forEach((tab) => { tab.onclick = () => setActiveView(tab.dataset.view); });
  $('resetFilters').onclick = () => { state.time = '24h'; state.emotion = 'all'; state.topic = 'all'; ['timeFilter', 'emotionFilter', 'topicFilter'].forEach((id) => { $(id).value = state[id.replace('Filter', '')] || 'all'; }); render(); };
  document.addEventListener('click', (event) => { const trigger = event.target.closest('[data-topic], [data-emotion]'); if (!trigger) return; if (trigger.dataset.topic) { state.topic = trigger.dataset.topic; $('topicFilter').value = state.topic; } if (trigger.dataset.emotion) { state.emotion = trigger.dataset.emotion; $('emotionFilter').value = state.emotion; } render(); });
}
async function init() {
  MoodData.topics.forEach((topic) => { $('topicFilter').insertAdjacentHTML('beforeend', `<option value="${topic.id}">${topic.name}</option>`); });
  ['Hope', 'Anxiety', 'Excitement', 'Frustration', 'Joy', 'Neutral'].forEach((emotion) => { $('emotionFilter').insertAdjacentHTML('beforeend', `<option value="${emotion}">${emotion}</option>`); });
  map = L.map('map', {
    attributionControl: false,
    scrollWheelZoom: true,
    touchZoom: true,
    doubleClickZoom: true,
    boxZoom: true,
  }).setView([24, 10], 1.35);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', { subdomains: 'abcd', maxZoom: 19 }).addTo(map);
  bindEvents();
  renderBlueskyStatus();
  setActiveView(activeView);
  render();
  loadBlueskySample();
  window.setInterval(loadBlueskySample, BLUESKY_REFRESH_MS);
  try {
    await loadCountryBoundaries();
  } catch (error) {
    console.error(error);
    $('map').setAttribute('aria-label', 'World sentiment map unavailable');
    $('map').insertAdjacentHTML('afterend', '<p class="map-error">World boundaries could not be loaded. Geographic mood data is temporarily unavailable.</p>');
  }
}
init();