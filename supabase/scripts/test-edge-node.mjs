import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const require = createRequire(join(process.env.TEST_DEPS_PATH || join(tmpdir(), 'sentimentmap-validation'), 'package.json'));
const tests = [];
globalThis.Deno = {
  env: { get: (name) => process.env[name], set: (name, value) => { process.env[name] = value; }, delete: (name) => { delete process.env[name]; } },
  test: (name, run) => tests.push({ name, run }),
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'https://esm.sh/@supabase/supabase-js@2') {
      return { url: pathToFileURL(require.resolve('@supabase/supabase-js')).href, shortCircuit: true };
    }
    if (specifier === 'https://deno.land/std@0.224.0/assert/mod.ts') {
      return { url: 'data:text/javascript,import assert from "node:assert/strict";export {assert};export const assertEquals=assert.deepStrictEqual;', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

for (const directory of ['analyse-posts', 'ingest-bluesky-search', '_shared']) {
  const base = new URL(`../functions/${directory}/`, import.meta.url);
  for (const file of await readdir(base)) {
    if (file.endsWith('.test.ts')) await import(new URL(file, base));
  }
}
let failed = 0;
for (const { name, run } of tests) {
  try { await run(); }
  catch (error) { failed += 1; console.error(`FAIL: ${name}`, error); }
}
console.log(`${tests.length - failed}/${tests.length} Edge Function tests passed under Node compatibility runner (not native Deno).`);
assert.equal(failed, 0);

const context = vm.createContext({
  console, Intl, URLSearchParams,
  document: { hidden: false, querySelectorAll: () => [], getElementById: () => null },
  window: { addEventListener: () => {} },
});
vm.runInContext(await readFile(new URL('../../app.js', import.meta.url), 'utf8'), context);
const chart = vm.runInContext(`trendSeriesFromBuckets([
  { bucket_start: new Date(Date.now()-3600000).toISOString(), count: 4, score: 60, raw_avg: 60 }
])`, context);
assert.equal(chart.points.length, 1);
assert.equal(chart.score, 60);
vm.runInContext(`
  globalThis.reads = { dashboard: 0, review: 0 };
  loadDashboardV2 = async () => { reads.dashboard += 1; dashboardV2.lastFetchedAt = Date.now(); };
  loadReviewData = async () => { reads.review += 1; reviewSources[review.source].state.lastFetchedAt = Date.now(); };
`, context);
await vm.runInContext('refreshActiveView()', context);
await vm.runInContext('refreshActiveView()', context);
assert.equal(context.reads.dashboard, 1);
assert.equal(context.reads.review, 0);
vm.runInContext("activeView = 'data-review'", context);
await vm.runInContext('refreshActiveView()', context);
await vm.runInContext('refreshActiveView()', context);
assert.equal(context.reads.review, 1);
vm.runInContext('document.hidden = true; blueskyV2.lastFetchedAt = 0;', context);
await vm.runInContext('refreshActiveView()', context);
assert.equal(context.reads.review, 1);
console.log('Browser logic checks passed: rolling chart, active-view-only reads, freshness gate, hidden-tab suppression');

let clock = 1800000000000;
class TestDate extends Date { static now() { return clock; } }
const cadence = vm.createContext({
  console, Intl, Date: TestDate,
  document: { hidden: false, querySelectorAll: () => [], getElementById: () => null },
  window: { addEventListener: () => {} }, advance: () => { clock += 1000; },
});
vm.runInContext(await readFile(new URL('../../app.js', import.meta.url), 'utf8'), cadence);
vm.runInContext('globalThis.reads=0; dashboardV2.lastFetchedAt=Date.now(); loadDashboardV2=async()=>{reads+=1;advance();dashboardV2.lastFetchedAt=Date.now()}', cadence);
const started = clock;
for (const hour of [1,2,3]) {
  clock = started + hour * 3600000;
  await vm.runInContext('refreshActiveView(true)', cadence);
  assert.equal(cadence.reads, hour);
}
console.log('Polling regression passed: delayed responses no longer suppress alternate hourly ticks');
vm.runInContext(`
  globalThis.reviewQuery = '';
  renderDataReview = () => {};
  requestArchive = async (path) => { reviewQuery = path; return { data: [], totalCount: 0 }; };
`, context);
await vm.runInContext("loadReviewArchive('v2',1,'')", context);
assert(!context.reviewQuery.includes('published_at=gte.'));
assert(!context.reviewQuery.includes('published_at=lte.'));
console.log('Review cutoff regression passed: server view, not browser clock, determines recentness');