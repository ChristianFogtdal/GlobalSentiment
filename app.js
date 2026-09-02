const state = { time: '24h', emotion: 'all', topic: 'all', sort: 'impact' };
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US');
let map;
let countryLayer;

function sentimentLabel(score) { return score >= 75 ? 'Very positive' : score >= 60 ? 'Positive' : score >= 45 ? 'Mixed' : score >= 25 ? 'Negative' : 'Very negative'; }
function scoreColor(score) { return score >= 70 ? '#118a72' : score >= 60 ? '#58a86d' : score >= 50 ? '#d3aa45' : '#cf6c53'; }
function signed(value, suffix = '') { return `${value > 0 ? '+' : ''}${value}${suffix}`; }
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
  const sources = data.topics.slice(0, 3).map((topic, index) => ({ source: ['Public forum', 'News comments', 'Video comments'][index], topic: topic.name, text: [`Discussion about ${topic.name.toLowerCase()} is gathering pace across multiple permitted public sources.`, `Representative, deduplicated discussion signal linked to ${topic.name.toLowerCase()}.`, `Aggregate signal reflects public reaction; individual authors are not profiled.`][index] }));
  $('sourceList').innerHTML = sources.map((item) => `<div class="source"><span>${item.source}</span><p>“${item.text}”</p><b>${item.topic}</b></div>`).join('');
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
  render();
  try {
    await loadCountryBoundaries();
  } catch (error) {
    console.error(error);
    $('map').setAttribute('aria-label', 'World sentiment map unavailable');
    $('map').insertAdjacentHTML('afterend', '<p class="map-error">World boundaries could not be loaded. Geographic mood data is temporarily unavailable.</p>');
  }
}
init();