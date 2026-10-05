import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { renewLease, withPipelineLease, type WorkerLease } from './workerLease.ts';

Deno.test('busy lease prevents work and never releases another owner', async () => {
  const calls: string[] = [];
  const client = { rpc: (name: string) => { calls.push(name); return Promise.resolve({ data: null, error: null }); } };
  const response = await withPipelineLease(client as unknown as Parameters<typeof withPipelineLease>[0], 'analysis', 600,
    () => { throw new Error('Must not run'); });
  assertEquals(response.status, 200);
  assertEquals(calls, ['acquire_pipeline_lease']);
});

Deno.test('exception releases the exact acquired owner and fence', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = { rpc: (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return Promise.resolve({ data: name === 'acquire_pipeline_lease' ? 9 : true, error: null });
  } };
  const response = await withPipelineLease(client as unknown as Parameters<typeof withPipelineLease>[0], 'analysis', 600,
    () => { throw new Error('Crash before response'); });
  assertEquals(response.status, 503);
  assertEquals(calls[1].name, 'release_pipeline_lease');
  assertEquals(calls[1].args.p_owner, calls[0].args.p_owner);
  assertEquals(calls[1].args.p_fence, 9);
});

Deno.test('malformed lease response fails closed', async () => {
  const client = { rpc: () => Promise.resolve({ data: true, error: null }) };
  const response = await withPipelineLease(client as unknown as Parameters<typeof withPipelineLease>[0], 'analysis', 600,
    () => { throw new Error('Must not run'); });
  assertEquals(response.status, 503);
});

Deno.test('worker deadline prevents lease renewal and further work', async () => {
  const client = { rpc: () => { throw new Error('Must not renew'); } };
  const lease: WorkerLease = { pipeline: 'analysis', owner: 'test', fence: 1, deadline: Date.now() - 1 };
  assertEquals(await renewLease(client as unknown as Parameters<typeof renewLease>[0], lease), false);
});