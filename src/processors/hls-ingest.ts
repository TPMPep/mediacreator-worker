// =============================================================================
// HLS-INGEST PROCESSOR — v2 HLS-to-MP4 ingest pipeline (Phase 2 remux).
// -----------------------------------------------------------------------------
// Single-shot job. The worker walks a phase machine on the Base44 side via
// `hlsIngestWorkerStep`; this processor is just the dumb messenger that:
//
//   1. Calls hlsIngestWorkerStep with no carry (phase=queued → codecs_validated).
//      → If the function returns action='recall_function', call again.
//   2. When action='call_railway', POST to the Railway /hls-ingest endpoint
//      with the body the function returned. Railway runs ffmpeg `-c copy`,
//      uploads to S3, and returns { output_key, size_bytes, remux_duration_ms }.
//   3. Call hlsIngestWorkerStep again with carry={ railway_response: <Railway's reply> }
//      (phase=railway_dispatched → project_patched). Function PATCHes the
//      Project, marks the run completed, returns action='done'.
//   4. Exit cleanly → BullMQ removes the job from the queue.
//
// SECURITY MODEL
//   • Every call to hlsIngestWorkerStep forwards the producer-minted scoped
//     JWT verbatim as X-Worker-JWT (mirrors translate-chunk / adapt-chunk /
//     enrich-chunk exactly). The function verifies signature + scope every
//     time. Blast radius: ONE run, 30 min, ONE function.
//   • The Railway api_key is NOT held in worker env — it comes back to the
//     worker inside the function response (carry.railway.api_key) so the
//     single source of truth is the Base44 secrets store. Bonus: this lets
//     us rotate the Railway key without redeploying the worker.
//
// HEARTBEAT
//   The Railway remux can take 5-15 minutes for long sources. Default BullMQ
//   stalled-job detection trips at 30s, which would re-enqueue the job mid-
//   remux and cause double-writes to S3. We extend the lock every 15s.
//
// IDEMPOTENCY
//   Re-running this processor on the same job is safe: hlsIngestWorkerStep's
//   phase machine short-circuits if the run is already past the requested
//   phase (e.g. status=completed → returns action='done' immediately).
// =============================================================================

import type { Job } from 'bullmq';
import type { HlsIngestJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

// Per-tick budgets. Base44 fn aims for ≤45s; this is the network-side ceiling.
const FUNCTION_CALL_TIMEOUT_MS = 90_000;
// Railway remux ceiling: 15 min for a 90-min source with `-c copy` is generous.
// If Railway exceeds this, we treat it as a hard failure and BullMQ retries.
const RAILWAY_CALL_TIMEOUT_MS = 15 * 60 * 1000;
// Lock heartbeat — Railway calls dwarf BullMQ's 30s default stalled-detection.
const HEARTBEAT_MS = 15_000;
// Safety: cap the number of phase-machine iterations we'll do in one job.
// Real runs need 3 iterations (queued → codecs_validated → railway_dispatched
// → done). 8 is a generous stuck-loop guard.
const MAX_PHASE_ITERATIONS = 8;

interface PhaseStepResponse {
  action: 'call_railway' | 'recall_function' | 'done';
  phase?: string;
  done?: boolean;
  result?: unknown;
  railway?: {
    url: string;
    api_key: string;
    body: Record<string, unknown>;
  };
  carry?: unknown;
}

interface RailwayHlsIngestResponse {
  output_key: string;
  size_bytes: number;
  remux_duration_ms: number;
  // Echo fields are optional but useful for audit cross-correlation.
  hls_ingest_run_id?: string;
  project_id?: string;
}

async function callRailway(railway: NonNullable<PhaseStepResponse['railway']>, requestId: string): Promise<RailwayHlsIngestResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RAILWAY_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(railway.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${railway.api_key}`,
        'X-Request-Id': requestId,
      },
      body: JSON.stringify(railway.body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`railway /hls-ingest → HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json() as RailwayHlsIngestResponse;
    if (!json.output_key || typeof json.size_bytes !== 'number') {
      throw new Error(`railway /hls-ingest → malformed response: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export async function processHlsIngest(job: Job<HlsIngestJobData>) {
  const t0 = Date.now();
  const { project_id, hls_ingest_run_id, user_email, request_id, auth_token } = job.data;

  if (!auth_token) {
    throw new Error('hls-ingest: missing auth_token (job from a stale schema — re-enqueue required)');
  }

  // ─── Heartbeat — keeps job lock alive during the long Railway call ───
  let heartbeatActive = true;
  const heartbeat = (async () => {
    while (heartbeatActive) {
      await new Promise(r => setTimeout(r, HEARTBEAT_MS));
      if (!heartbeatActive) break;
      try { await job.extendLock(job.token!, 30_000); } catch { /* lock may have already advanced */ }
    }
  })();

  try {
    let carry: unknown = undefined;
    let lastPhase: string | undefined;

    for (let i = 0; i < MAX_PHASE_ITERATIONS; i++) {
      // 1. Tick the phase machine on Base44.
      const step = await invokeBase44Function<PhaseStepResponse>({
        fn: 'hlsIngestWorkerStep',
        authToken: auth_token,
        payload: { project_id, hls_ingest_run_id, carry },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
      });

      lastPhase = step.phase;

      await logEvent({
        function_name: 'bullmq:hls-ingest',
        event: 'hls_ingest_phase_tick',
        context: {
          project_id,
          hls_ingest_run_id,
          user_email,
          request_id,
          attempts: job.attemptsMade + 1,
          iteration: i,
          action: step.action,
          phase: step.phase,
        },
      });

      // 2. Terminal — exit the loop.
      if (step.action === 'done') {
        await logEvent({
          function_name: 'bullmq:hls-ingest',
          event: 'hls_ingest_complete',
          duration_ms: Date.now() - t0,
          context: {
            project_id, hls_ingest_run_id, user_email, request_id,
            attempts: job.attemptsMade + 1,
            iterations: i + 1,
            phase: step.phase,
            result: step.result,
          },
        });
        return step.result ?? { ok: true, phase: step.phase };
      }

      // 3. Call Railway (the long one) and feed the result back next iteration.
      if (step.action === 'call_railway') {
        if (!step.railway?.url || !step.railway.api_key || !step.railway.body) {
          throw new Error('hls-ingest: function returned call_railway with missing railway payload');
        }
        await logEvent({
          function_name: 'bullmq:hls-ingest',
          event: 'hls_ingest_railway_dispatch',
          context: {
            project_id, hls_ingest_run_id, user_email, request_id,
            railway_url: step.railway.url,
            output_key: step.railway.body?.output_key,
          },
        });
        const railwayRes = await callRailway(step.railway, request_id);
        carry = { railway_response: railwayRes };
        continue;
      }

      // 4. Just call back without carry (e.g. queued → codecs_validated tick
      //    that asks for an immediate next iteration).
      if (step.action === 'recall_function') {
        carry = undefined;
        continue;
      }

      throw new Error(`hls-ingest: unknown action from hlsIngestWorkerStep: ${String(step.action)}`);
    }

    throw new Error(`hls-ingest: phase machine exceeded ${MAX_PHASE_ITERATIONS} iterations (last phase: ${lastPhase ?? 'none'})`);
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:hls-ingest',
      level: 'error',
      event: 'hls_ingest_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: {
        project_id, hls_ingest_run_id, user_email, request_id,
        attempts: job.attemptsMade + 1,
      },
    });
    throw err; // BullMQ will retry per DEFAULT_JOB_OPTIONS (3 attempts → DLQ).
  } finally {
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}