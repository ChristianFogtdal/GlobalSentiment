import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveActivePromptVersion } from './index.ts';

// Minimal mock of the subset of the Supabase JS client surface used by
// resolveActivePromptVersion: .rpc('get_active_prompt_version').
function createMockSupabase(rpcResult: { data?: unknown; error?: { message: string } | null }) {
  return {
    rpc(fnName: string) {
      assertEquals(fnName, 'get_active_prompt_version');
      return Promise.resolve({ data: rpcResult.data ?? null, error: rpcResult.error ?? null });
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

function withEnv(key: string, value: string | undefined, fn: () => Promise<void>) {
  const original = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
  return fn().finally(() => {
    if (original === undefined) Deno.env.delete(key);
    else Deno.env.set(key, original);
  });
}

Deno.test('resolveActivePromptVersion returns the database value when no legacy env var is set', async () => {
  await withEnv('LLM_PROMPT_VERSION', undefined, async () => {
    const supabase = createMockSupabase({ data: 'v1' });
    const result = await resolveActivePromptVersion(supabase);
    assert('promptVersion' in result);
    assertEquals((result as { promptVersion: string }).promptVersion, 'v1');
  });
});

Deno.test('resolveActivePromptVersion succeeds when legacy env var agrees with the database value', async () => {
  await withEnv('LLM_PROMPT_VERSION', 'v1', async () => {
    const supabase = createMockSupabase({ data: 'v1' });
    const result = await resolveActivePromptVersion(supabase);
    assert('promptVersion' in result);
    assertEquals((result as { promptVersion: string }).promptVersion, 'v1');
  });
});

Deno.test('resolveActivePromptVersion fails closed when legacy env var disagrees with the database value', async () => {
  await withEnv('LLM_PROMPT_VERSION', 'v0-stale', async () => {
    const supabase = createMockSupabase({ data: 'v1' });
    const result = await resolveActivePromptVersion(supabase);
    assert('error' in result);
  });
});

Deno.test('resolveActivePromptVersion fails closed when the RPC returns an error', async () => {
  await withEnv('LLM_PROMPT_VERSION', undefined, async () => {
    const supabase = createMockSupabase({ error: { message: 'permission denied' } });
    const result = await resolveActivePromptVersion(supabase);
    assert('error' in result);
  });
});

Deno.test('resolveActivePromptVersion fails closed when the database value is empty/missing', async () => {
  await withEnv('LLM_PROMPT_VERSION', undefined, async () => {
    const supabase = createMockSupabase({ data: null });
    const result = await resolveActivePromptVersion(supabase);
    assert('error' in result);
  });
});
