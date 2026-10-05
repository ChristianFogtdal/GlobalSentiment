export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function boundedInteger(value: string | undefined, fallback: number, maximum: number, minimum = 1): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? Math.min(parsed, maximum) : fallback;
}

export function collectionLimits(env: (name: string) => string | undefined) {
  return {
    intervalMinutes: boundedInteger(env('INGEST_INTERVAL_MINUTES'), 60, 1440, 60),
    postsPerRun: Math.min(
      boundedInteger(env('INGEST_POSTS_PER_SOURCE'), 25, 100),
      boundedInteger(env('INGEST_MAX_POSTS_PER_HOUR'), 100, 100),
    ),
    termsPerRun: boundedInteger(env('INGEST_TERMS_PER_RUN'), 5, 58),
    postsPerTerm: boundedInteger(env('INGEST_POSTS_PER_TERM'), 5, 25),
  };
}

export function searchPlan(terms: readonly string[], limits: ReturnType<typeof collectionLimits>, now = Date.now()) {
  const count = Math.min(terms.length, limits.termsPerRun, limits.postsPerRun);
  if (!count) return [];
  const slot = Math.floor(now / (limits.intervalMinutes * 60_000));
  let remaining = limits.postsPerRun;
  return Array.from({ length: count }, (_, index) => {
    const limit = Math.min(limits.postsPerTerm, Math.ceil(remaining / (count - index)));
    remaining -= limit;
    return { term: terms[(slot * count + index) % terms.length], limit };
  });
}

export function isRecent(timestamp: unknown, now = Date.now()): boolean {
  if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)) return false;
  const time = Date.parse(timestamp);
  return Number.isFinite(time) && time >= now - RETENTION_MS && time <= now;
}

export function hasUsefulText(text: string, minimumLength = 8): boolean {
  const words = text.replace(/https?:\/\/\S+/giu, '').trim();
  return [...words].length >= minimumLength && /\p{L}/u.test(words);
}

export async function contentKey(parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}