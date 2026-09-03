// Pure conversion from the canonical post_analyses_v2.sentiment_score
// range [-1.0, 1.0] to the future dashboard 0-100 display scale.
//
// displayScore = round((sentiment_score + 1) * 50)
//
// This is the future dashboard contract only; no frontend code (app.js)
// is changed in this slice. Kept alongside the V2 worker since it
// operates on the same canonical score this worker persists.
export function displayScore(sentimentScore: number): number {
  return Math.round((sentimentScore + 1) * 50);
}
