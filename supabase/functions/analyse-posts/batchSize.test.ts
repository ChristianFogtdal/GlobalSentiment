import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveBatchSize } from './index.ts';

// resolveBatchSize reads LLM_BATCH_SIZE directly from Deno.env, so tests
// set/clear that variable around each assertion rather than mocking a
// parameter-injected config object (keeping the production signature simple
// for a single-purpose Edge Function).

Deno.test('resolveBatchSize defaults to 5 when LLM_BATCH_SIZE is unset', () => {
  Deno.env.delete('LLM_BATCH_SIZE');
  assertEquals(resolveBatchSize(), 5);
});

Deno.test('resolveBatchSize defaults to 5 when LLM_BATCH_SIZE is not a valid number', () => {
  Deno.env.set('LLM_BATCH_SIZE', 'not-a-number');
  try {
    assertEquals(resolveBatchSize(), 5);
  } finally {
    Deno.env.delete('LLM_BATCH_SIZE');
  }
});

Deno.test('resolveBatchSize defaults to 5 when LLM_BATCH_SIZE is zero or negative', () => {
  Deno.env.set('LLM_BATCH_SIZE', '0');
  try {
    assertEquals(resolveBatchSize(), 5);
  } finally {
    Deno.env.delete('LLM_BATCH_SIZE');
  }
  Deno.env.set('LLM_BATCH_SIZE', '-5');
  try {
    assertEquals(resolveBatchSize(), 5);
  } finally {
    Deno.env.delete('LLM_BATCH_SIZE');
  }
});

Deno.test('resolveBatchSize respects a valid configured value below the ceiling', () => {
  Deno.env.set('LLM_BATCH_SIZE', '3');
  try {
    assertEquals(resolveBatchSize(), 3);
  } finally {
    Deno.env.delete('LLM_BATCH_SIZE');
  }
});

Deno.test('resolveBatchSize clamps a configured value above the hard ceiling of 5', () => {
  Deno.env.set('LLM_BATCH_SIZE', '500');
  try {
    assertEquals(resolveBatchSize(), 5);
  } finally {
    Deno.env.delete('LLM_BATCH_SIZE');
  }
});

Deno.test('resolveBatchSize clamps exactly at the ceiling boundary', () => {
  Deno.env.set('LLM_BATCH_SIZE', '5');
  try {
    assertEquals(resolveBatchSize(), 5);
  } finally {
    Deno.env.delete('LLM_BATCH_SIZE');
  }
});
