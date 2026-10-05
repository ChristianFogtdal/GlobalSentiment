import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface WorkerLease {
  pipeline: 'analysis' | 'bluesky_ingestion';
  owner: string;
  fence: number;
  deadline: number;
}

export const databaseFetch: typeof fetch = (input, init) => fetch(input, {
  ...init,
  signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(10_000)]),
});

export async function renewLease(client: SupabaseClient, lease: WorkerLease): Promise<boolean> {
  if (Date.now() >= lease.deadline) return false;
  const { data, error } = await client.rpc('renew_pipeline_lease', {
    p_pipeline: lease.pipeline, p_owner: lease.owner, p_fence: lease.fence,
  });
  return !error && data === true && Date.now() < lease.deadline;
}

export async function withPipelineLease(
  client: SupabaseClient,
  pipeline: WorkerLease['pipeline'],
  intervalSeconds: number,
  work: (lease: WorkerLease) => Promise<Response>,
): Promise<Response> {
  const owner = crypto.randomUUID();
  const headers = { 'Content-Type': 'application/json' };
  const { data, error } = await client.rpc('acquire_pipeline_lease', {
    p_pipeline: pipeline, p_interval_seconds: intervalSeconds, p_owner: owner,
  });
  if (error) return new Response(JSON.stringify({ error: 'Worker lease acquisition failed' }), { status: 503, headers });
  if (data === null) return new Response(JSON.stringify({ skipped: 'worker busy or interval not elapsed' }), { headers });
  if (!Number.isSafeInteger(data) || data < 1) {
    return new Response(JSON.stringify({ error: 'Invalid worker fence' }), { status: 503, headers });
  }
  const lease: WorkerLease = { pipeline, owner, fence: data, deadline: Date.now() + 120_000 };
  try {
    return await work(lease);
  } catch {
    return new Response(JSON.stringify({ error: 'Worker interrupted; recovery will use persisted ownership' }), { status: 503, headers });
  } finally {
    try {
      const release = await client.rpc('release_pipeline_lease', { p_pipeline: pipeline, p_owner: owner, p_fence: lease.fence });
      if (release.error) console.warn('Worker lease release failed; lease expiry will recover it');
    } catch {
      console.warn('Worker lease release failed; lease expiry will recover it');
    }
  }
}