import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { logInvocationFinish, logInvocationStart } from './index.ts';

// Minimal in-memory mock of the analyse_posts_invocation_log surface used by
// logInvocationStart/logInvocationFinish: .from(table).insert(...).select('id').single(),
// and .from(table).update(...).eq('id', id).
function createMockSupabase(options: { insertShouldFail?: boolean; updateShouldFail?: boolean } = {}) {
  const rows: Array<Record<string, unknown>> = [];
  let nextId = 1;

  const client = {
    from(table: string) {
      assertEquals(table, 'analyse_posts_invocation_log');
      return {
        insert(row: Record<string, unknown>) {
          return {
            select(_col: string) {
              return {
                single() {
                  if (options.insertShouldFail) {
                    return Promise.resolve({ data: null, error: { message: 'insert failed' } });
                  }
                  const id = nextId++;
                  rows.push({ id, ...row });
                  return Promise.resolve({ data: { id }, error: null });
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(_col: string, val: unknown) {
              if (options.updateShouldFail) return Promise.resolve({ error: { message: 'update failed' } });
              const row = rows.find((r) => r.id === val);
              if (row) Object.assign(row, patch);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
    __rows: rows,
    // deno-lint-ignore no-explicit-any
  } as any;
  return client;
}

Deno.test('logInvocationStart returns the inserted row id on success', async () => {
  const supabase = createMockSupabase();
  const id = await logInvocationStart(supabase, 20);
  assertEquals(id, 1);
  assertEquals(supabase.__rows[0].batch_size, 20);
});

Deno.test('logInvocationStart returns null (never throws) when the insert fails', async () => {
  const supabase = createMockSupabase({ insertShouldFail: true });
  const id = await logInvocationStart(supabase, 20);
  assertEquals(id, null);
});

Deno.test('logInvocationFinish writes selected/completed/failed on a successful batch', async () => {
  const supabase = createMockSupabase();
  const id = await logInvocationStart(supabase, 20);
  await logInvocationFinish(supabase, id, { selected: 5, completed: 4, failed: 1, scanned: 6, results: [] });
  const row = supabase.__rows.find((r: Record<string, unknown>) => r.id === id)!;
  assertEquals(row.selected, 5);
  assertEquals(row.completed, 4);
  assertEquals(row.failed, 1);
  assertEquals(typeof row.finished_at, 'string');
});

Deno.test('logInvocationFinish writes error_message on a failed batch', async () => {
  const supabase = createMockSupabase();
  const id = await logInvocationStart(supabase, 20);
  await logInvocationFinish(supabase, id, { error: 'candidate selection failed' });
  const row = supabase.__rows.find((r: Record<string, unknown>) => r.id === id)!;
  assertEquals(row.error_message, 'candidate selection failed');
});

Deno.test('logInvocationFinish is a no-op when the invocation was never logged (id is null)', async () => {
  const supabase = createMockSupabase();
  // Should not throw even though there is no row to update.
  await logInvocationFinish(supabase, null, { selected: 1, completed: 1, failed: 0, scanned: 1, results: [] });
  assertEquals(supabase.__rows.length, 0);
});

Deno.test('logInvocationFinish swallows update errors without throwing', async () => {
  const supabase = createMockSupabase({ updateShouldFail: true });
  const id = await logInvocationStart(supabase, 20);
  await logInvocationFinish(supabase, id, { selected: 1, completed: 1, failed: 0, scanned: 1, results: [] });
  // No assertion needed beyond "did not throw" - logging must never fail the invocation.
});
