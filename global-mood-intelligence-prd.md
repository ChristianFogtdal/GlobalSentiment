# Product Requirements Document: Global Mood Intelligence

## 1. Product Overview

### Product name
**Global Mood Intelligence**

### Product vision
Create a live, interactive dashboard that answers:

> **How are people feeling right now, what is driving that mood, and where is it changing?**

The product will analyse public text-based content, convert it into understandable sentiment and emotion indicators, identify the topics driving those indicators, explain meaningful changes, and present geographic differences on an interactive map.

### Hackathon scope
This PRD covers the first six product layers:

1. Overall Mood Score
2. Emotion Breakdown
3. Hot Topics
4. AI Explanation of the Score
5. Mood Shift Detection
6. Geographic Mood Map

---

## 2. Problem Statement

Existing sentiment dashboards often provide a positive, neutral, or negative score without explaining what the score means or why it changed. Users must manually investigate topics, locations, and source content to understand the underlying story.

Global Mood Intelligence should combine measurement and explanation in one experience. A user should be able to move from a global score to the emotions, topics, events, locations, and source evidence contributing to it.

---

## 3. Target Users

### Primary users
- Journalists and researchers monitoring public reaction to events
- Communications and public affairs teams tracking public mood
- Event organisers assessing audience response
- Curious users exploring how public conversations change over time

### Primary user need
> As a user, I want to understand current public sentiment and the reasons behind it, so that I can quickly identify meaningful changes without manually reviewing large volumes of content.

---

## 4. Product Principles

1. **Explain, do not only score**: Every major score should be supported by understandable drivers.
2. **Show change over time**: Direction and movement are more useful than an isolated value.
3. **Allow drill-down**: Users should be able to move from global mood to emotion, topic, geography, and source evidence.
4. **Be transparent**: Clearly show data sources, sample size, update time, confidence, and limitations.
5. **Avoid false certainty**: AI-generated explanations and sentiment classifications should be presented as model outputs, not objective facts.
6. **Respect privacy and platform rules**: The product should use permitted public content and avoid profiling individual people.

---

## 5. Core User Journey

1. The user opens the dashboard and sees the current Overall Mood Score.
2. The user reviews how the score has changed during the selected period.
3. The user sees the dominant emotions contributing to the score.
4. The user reviews the hot topics driving public conversation.
5. The user reads an AI-generated explanation of why the score is high, low, or changing.
6. The user inspects detected mood shifts and their likely drivers.
7. The user selects a country or region on the map to view its local score, emotions, topics, and explanation.
8. Where available, the user opens representative source examples supporting the analysis.

---

# 6. Functional Requirements

## Layer 1: Overall Mood Score

### Objective
Provide an immediate, understandable summary of the analysed public mood.

### Requirements
- Display one Overall Mood Score on a scale from **0 to 100**.
- Interpret lower values as more negative sentiment and higher values as more positive sentiment.
- Display a clear label such as **Very Negative**, **Negative**, **Mixed**, **Positive**, or **Very Positive**.
- Show the score movement compared with the previous equivalent period.
- Show a simple historical trend for the selected time range.
- Display the last updated time.
- Display the number of analysed items.
- Display a confidence or data-quality indicator.
- Allow the user to select a time window, such as last hour, 24 hours, or seven days.
- Recalculate all dashboard layers when the time window changes.

### Example display
```text
Global Mood: 67/100
Positive
Up 4 points compared with the previous 24 hours
Based on 12,400 analysed items
Last updated: 14:30 UTC
Confidence: Medium
```

### Acceptance criteria
- The user can identify the current overall score without opening another view.
- The user can see whether the score increased, decreased, or remained stable.
- The user can see the analysis period and data volume behind the score.
- Changing the time window updates the score and related dashboard content.

---

## Layer 2: Emotion Breakdown

### Objective
Show the emotional composition hidden behind the overall positive or negative score.

### Emotion categories
The initial version should support:

- Joy
- Hope
- Excitement
- Pride
- Anger
- Fear
- Anxiety
- Frustration
- Sadness
- Neutral or unclear

### Requirements
- Display the proportion of analysed items associated with each emotion.
- Highlight the dominant emotion.
- Show how each emotion changed compared with the previous equivalent period.
- Use a clear visual such as a horizontal bar chart, radial chart, or emotion wheel.
- Allow the user to select an emotion and filter the hot topics, explanations, and map.
- Allow one item to contain more than one emotion if the selected analysis model supports multi-label classification.
- Provide a short explanation of how emotion labels are generated.

### Acceptance criteria
- The user can identify the dominant emotions.
- The user can see which emotions are increasing or decreasing.
- Selecting an emotion updates the other dashboard components.
- The dashboard distinguishes between no detected emotion and missing data.

---

## Layer 3: Hot Topics

### Objective
Identify the subjects receiving the most attention and show how each topic affects sentiment.

### Requirements
- Extract and group recurring topics from the analysed content.
- Display the leading topics for the selected time range and geographic scope.
- For each topic, show:
  - Topic name
  - Mention volume
  - Change in mention volume
  - Topic sentiment score
  - Dominant emotion
  - Contribution to the Overall Mood Score
  - Confidence in the topic grouping
- Allow users to sort topics by volume, growth, sentiment, or score impact.
- Allow users to select a topic and see its trend, emotions, locations, explanation, and representative source examples.
- Merge obvious duplicates and closely related terms where possible.
- Prevent a single highly repeated source or account from dominating a topic where deduplication is possible.

### Acceptance criteria
- The user can identify the topics driving the largest amount of conversation.
- The user can distinguish between a popular topic and a topic with a large impact on mood.
- Selecting a topic filters the other dashboard layers.
- Each displayed topic includes enough evidence to explain why it appears.

---

## Layer 4: AI Explanation of the Score

### Objective
Explain in plain language why the Overall Mood Score is high, low, or changing.

### Requirements
- Generate a concise explanation based on the metrics produced by Layers 1 to 3.
- The explanation should identify:
  - The main positive drivers
  - The main negative drivers
  - The dominant emotions
  - Important geographic differences
  - Whether the result is driven by broad conversation or a small number of high-volume topics
- Include measurable evidence in the explanation, such as topic contribution, mention increase, or regional difference.
- Clearly label the text as an AI-generated explanation.
- Provide links or drill-down actions to the supporting topics and representative source examples.
- Avoid claiming that a topic caused a mood change when the data only shows an association.
- Use cautious language when confidence or sample size is low.
- Regenerate the explanation when filters change.

### Example output
> **AI-generated explanation:** Overall sentiment increased during the selected period. Positive discussion around new technology announcements and a major sporting event outweighed negative discussion about severe weather. Hope and excitement were the fastest-growing emotions. The increase was strongest in Northern Europe, while sentiment in North America remained mixed.

### Acceptance criteria
- The explanation is consistent with the displayed score, emotions, topics, and geography.
- Every named driver can be opened or inspected elsewhere in the dashboard.
- Low-confidence findings are clearly qualified.
- The explanation uses association language rather than unsupported causal claims.

---

## Layer 5: Mood Shift Detection

### Objective
Automatically detect and explain meaningful changes in public sentiment.

### Requirements
- Compare the current analysis period with a previous equivalent baseline.
- Detect significant changes in:
  - Overall Mood Score
  - Individual emotions
  - Topic volume
  - Topic sentiment
  - Geographic sentiment
- Display the time at which a shift started.
- Classify a shift by direction and importance, for example minor increase, major increase, minor decrease, or major decrease.
- Identify the topics and locations most strongly associated with the shift.
- Show before-and-after values.
- Allow the user to select a detected shift and inspect its timeline and supporting evidence.
- Avoid triggering alerts for small movements caused by low sample size or normal fluctuation.
- Clearly indicate when there is insufficient data to explain a shift.

### Example display
```text
Major negative shift detected at 13:00 UTC
Mood Score: 71 to 56
Likely associated drivers:
1. Severe weather: mentions up 350%
2. Airline outage: mentions up 220%
3. Cost-of-living concerns: mentions up 80%
```

### Acceptance criteria
- The system identifies a shift when a configured threshold is exceeded.
- The user can see the score before and after the shift.
- The user can inspect the topics, emotions, and locations associated with the shift.
- The system does not present association as proven causation.

---

## Layer 6: Geographic Mood Map

### Objective
Show how sentiment, emotions, and conversation drivers differ by location.

### Requirements
- Display an interactive world map using a consistent colour scale for sentiment.
- Support country-level data for the hackathon version.
- Allow the user to hover over or select a country.
- For each supported country, display:
  - Overall Mood Score
  - Change compared with the previous period
  - Dominant emotions
  - Hot topics
  - AI-generated explanation
  - Analysed item count
  - Confidence or data-quality indicator
- Allow the map to be filtered by time window, emotion, and topic.
- Use a neutral visual state for countries with insufficient data.
- Do not compare countries without also showing data volume and confidence.
- Where content location is inferred rather than explicitly available, label it as inferred.

### Acceptance criteria
- The user can identify geographic differences in sentiment.
- Selecting a country filters or opens its detailed analysis.
- Areas with insufficient data are not assigned a misleading score.
- The map legend clearly explains the colour scale.

---

## 7. Cross-Layer Filtering

The following filters should apply consistently across all six layers:

- Time range
- Geography
- Topic
- Emotion
- Data source, where multiple sources are available
- Language, where language detection is available

When a filter changes, the score, emotion distribution, hot topics, explanation, shift detection, and map should all refresh using the same filtered dataset.

---

## 8. Data and Analysis Pipeline

### Proposed flow
1. Ingest permitted public text content from one or more sources.
2. Remove duplicates, spam, and unusable content where possible.
3. Detect language and available geographic information.
4. Classify sentiment.
5. Classify emotions.
6. Extract and cluster topics.
7. Aggregate results by time and geography.
8. Calculate the Overall Mood Score.
9. Detect material changes against a baseline.
10. Generate an evidence-based explanation from the aggregated results.
11. Store the aggregated outputs for dashboard retrieval.

### Minimum data object
Each analysed item should contain, where available:

```json
{
  "id": "unique-item-id",
  "source": "source-name",
  "publishedAt": "timestamp",
  "text": "public-text-content",
  "language": "detected-language",
  "country": "detected-or-inferred-country",
  "locationConfidence": 0.0,
  "sentimentScore": 0.0,
  "sentimentLabel": "positive-neutral-negative",
  "emotions": [
    {
      "label": "emotion-name",
      "score": 0.0
    }
  ],
  "topics": ["topic-id"],
  "analysisConfidence": 0.0
}
```

---

## 9. Scoring Approach

For the hackathon, the Overall Mood Score can be calculated by normalising the average item-level sentiment to a 0 to 100 scale.

The score should:

- Use the same calculation across time periods and countries.
- Exclude invalid or unclassifiable items.
- Apply deduplication before aggregation.
- Display data volume and confidence next to the result.
- Avoid silently changing methodology during the demo.

The exact scoring formula should be documented in the implementation and treated as configurable.

---

## 10. Non-Functional Requirements

### Performance
- The main dashboard should load from pre-aggregated data rather than analysing all content during page rendering.
- User filter changes should return visible feedback immediately and complete without blocking the interface.

### Transparency
- Show the analysis period, last update, data volume, sources, and confidence.
- Mark AI-generated summaries clearly.
- Make representative supporting content available where source terms permit it.

### Responsible AI and privacy
- Analyse public discussion at an aggregated level.
- Do not score, profile, or expose individual people.
- Avoid inferring protected or highly sensitive personal attributes.
- Respect source terms, retention requirements, and deletion obligations.
- Include a notice that sentiment and emotion classification may be inaccurate, especially for sarcasm, slang, mixed-language content, and cultural context.

### Accessibility
- Do not rely on colour alone to communicate sentiment.
- Provide text labels and keyboard-accessible interactions.
- Use readable contrast and a desktop-first layout. The primary supported experience is a PC viewport; compact-screen layouts are a graceful fallback, not a feature target for the hackathon MVP.

---

## 11. Hackathon MVP

### Must have
- Overall Mood Score with trend and update time
- Emotion breakdown
- Five to ten hot topics
- AI-generated explanation grounded in calculated metrics
- At least one detected mood shift or a demo dataset that demonstrates shift detection
- Interactive country-level map
- Shared filters across all six layers
- Data volume and confidence indicators

### Should have
- Topic and country drill-down views
- Representative source examples
- Configurable time windows
- Multi-language analysis
- Auto-refresh

### Could have
- Alerts for major mood shifts
- User-defined topics
- Saved views
- Shareable insight cards
- Comparison between two countries or periods

---

## 12. Out of Scope for the Initial Version

- Predicting future public sentiment
- What-if scenario simulation
- Individual user profiling
- Automated decision-making based on sentiment
- Full global coverage with equal data quality
- Guaranteed real-time ingestion from every source
- Claims that online discussion represents the full population
- Claims that a detected topic caused a sentiment change

---

## 13. Success Measures

For the hackathon prototype, success is demonstrated when:

1. A user can understand the current mood, its direction, and its main drivers from the landing view.
2. A user can move from the overall score to supporting emotions, topics, locations, and evidence.
3. The AI explanation matches the underlying aggregated metrics.
4. The application distinguishes low-confidence or low-volume results from reliable results.
5. The demo clearly shows how the dashboard explains a meaningful mood shift rather than only visualising a score.

---

## 14. Demo Scenario

The prototype should include a prepared scenario in which:

1. The Overall Mood Score changes noticeably between two periods.
2. One positive topic and one negative topic increase in volume.
3. The dominant emotion changes.
4. The system detects the shift.
5. The AI explanation identifies the associated topics and locations.
6. The map shows that the change is stronger in one country or region than another.
7. The presenter drills from the global score into the supporting evidence.

This scenario ensures that all six layers form one coherent story during the demonstration.

---

## 15. Open Product Decisions

The implementation team should decide and document:

- Which public data source or approved demo dataset will be used
- Whether the prototype is genuinely live, near-real-time, or replaying time-stamped data
- Which sentiment and emotion models will be used
- Whether emotion classification is single-label or multi-label
- How topic similarity and duplicate topics will be handled
- How the Overall Mood Score is calculated
- What thresholds define a meaningful mood shift
- How geographic information is obtained and how uncertainty is displayed
- How representative source examples are selected
- How source bias and unequal geographic coverage are communicated

---

## 16. One-Sentence Pitch

> **Global Mood Intelligence is a live AI-powered dashboard that shows how public conversation is feeling, what is driving that mood, why it is changing, and where the change is happening.**
