/* Replace this adapter with an API client when live aggregation is available. */
window.MoodData = (() => {
  const topics = [
    { id: 'clean-energy', name: 'Clean energy', volume: 18420, growth: 34, sentiment: 78, emotion: 'Hope', impact: 5.8 },
    { id: 'football', name: 'International football', volume: 16280, growth: 19, sentiment: 82, emotion: 'Excitement', impact: 4.9 },
    { id: 'weather', name: 'Severe weather', volume: 14750, growth: 186, sentiment: 28, emotion: 'Anxiety', impact: -7.2 },
    { id: 'costs', name: 'Cost of living', volume: 12110, growth: 42, sentiment: 36, emotion: 'Frustration', impact: -4.6 },
    { id: 'health', name: 'Public health', volume: 8950, growth: -8, sentiment: 59, emotion: 'Hope', impact: 1.3 },
    { id: 'culture', name: 'Culture & arts', volume: 7320, growth: 15, sentiment: 74, emotion: 'Joy', impact: 2.1 },
  ];
  const countries = [
    { name: 'Canada', boundaryId: 'CAN', score: 72, change: 7, items: 11240, confidence: 'High', topics: ['Clean energy', 'Culture & arts'], emotion: 'Hope' },
    { name: 'United States', boundaryId: 'USA', score: 54, change: -3, items: 34120, confidence: 'High', topics: ['Cost of living', 'International football'], emotion: 'Mixed' },
    { name: 'Brazil', boundaryId: 'BRA', score: 64, change: 5, items: 17850, confidence: 'Medium', topics: ['International football', 'Public health'], emotion: 'Excitement' },
    { name: 'United Kingdom', boundaryId: 'GBR', score: 57, change: -11, items: 12940, confidence: 'High', topics: ['Severe weather', 'Cost of living'], emotion: 'Anxiety' },
    { name: 'Germany', boundaryId: 'DEU', score: 73, change: 10, items: 10670, confidence: 'High', topics: ['Clean energy', 'Culture & arts'], emotion: 'Hope' },
    { name: 'Japan', boundaryId: 'JPN', score: 61, change: 2, items: 9020, confidence: 'Medium', topics: ['Public health', 'International football'], emotion: 'Neutral' },
  ];
  const presets = { '1h': { score: 59, change: -2, items: 8120, confidence: 'Medium', trend: [62, 61, 63, 61, 60, 59], emotions: [['Anxiety', 26, 7], ['Hope', 21, -2], ['Frustration', 18, 4], ['Excitement', 14, -3], ['Joy', 9, -1], ['Neutral', 12, 0]] }, '24h': { score: 63, change: 4, items: 103820, confidence: 'High', trend: [55, 57, 56, 60, 58, 61, 63], emotions: [['Hope', 27, 6], ['Anxiety', 23, 5], ['Excitement', 18, 4], ['Frustration', 14, -3], ['Joy', 10, 1], ['Neutral', 8, -2]] }, '7d': { score: 60, change: 8, items: 689420, confidence: 'High', trend: [52, 54, 57, 56, 59, 61, 60], emotions: [['Hope', 25, 4], ['Anxiety', 21, 2], ['Excitement', 19, 8], ['Frustration', 16, -4], ['Joy', 11, 2], ['Neutral', 8, -3]] } };
  function getDashboardData({ time = '24h', emotion = 'all', topic = 'all' } = {}) {
    const base = presets[time];
    const selectedTopic = topics.find((item) => item.id === topic);
    const selectedEmotion = base.emotions.find(([name]) => name === emotion);
    const adjustment = selectedTopic ? Math.round((selectedTopic.sentiment - 60) / 3) : selectedEmotion ? Math.round((selectedEmotion[1] - 17) / 2) : 0;
    const score = Math.max(0, Math.min(100, base.score + adjustment));
    const filteredTopics = topics.filter((item) => (topic === 'all' || item.id === topic) && (emotion === 'all' || item.emotion === emotion));
    return { ...base, score, topics: filteredTopics, countries: countries.filter((country) => (emotion === 'all' || country.emotion === emotion) && (topic === 'all' || country.topics.includes(selectedTopic.name))), selectedTopic, selectedEmotion };
  }
  return { topics, getDashboardData };
})();