// =============================================================================
// TRANSLATE-ORCHESTRATOR PROCESSOR
// -----------------------------------------------------------------------------
// Calls back into Base44's `orchestrateTranslationRun`. Mirrors
// adapt-orchestrator exactly — same heartbeat pattern, same retry policy
// (attempts=1 to avoid counter drift), same forward-the-JWT auth model.
//
// Per-tick SDK density on the Base44 side: 3 calls. CHUNKS_PER_TICK on the
// orchestrator side is 2. Combined chunk-worker concurrency is 4. This bounds
// total platform SDK density at ~6 calls/sec sustained — safely below the
// platform's per-app rate limit threshold that triggered the May 8 incident.
// =============================================================================

import type { Job } from 'bullmq';
import type { TranslateOrchestratorJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';
import { Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { QUEUE_NAMES, ORCHESTRATOR_JOB_OPTIONS } from '../../shared/queue-contracts.js';

let _orchestratorQueue: Queue | null = null;
function orchestratorQueue(): Queue {
  if (!_orchestratorQueue) {
    _orchestratorQueue = new Queue(QUEUE_NAMES.TRANSLATE_ORCHESTRATOR, { connection: getRedis() });
  }
  return _orchestratorQueue;
}

const HEARTBEAT_MS = 15_000;
const TICK_TIMEOUT_MS = 90_000;

interface OrchestratorTickResult {
  next_tick?: boolean;
  next_tick_delay_ms?: number;
  finalized?: boolean;
  status?: string;
  chunk_cursor?: number;
  chunk_total?: number;
  chunks_dispatched?: number;
  chunk_in_flight?: number;
  chunk_completed?: number;
}

export async function processTranslateOrchestrator(job: Job<TranslateOrchestratorJobData>) {
  const t0 = Date.now();
  const { project_id, translation_run_id, user_email, request_id, auth_token } = job.data;

  if (!auth_token) {
    throw new Error('translate-orchestrator: missing auth_token (re-enqueue required)');
  }

  let heartbeatActive = true;
  const heartbeat = (async () => {
    while (heartbeatActive) {
      await new Promise(r => setTimeout(r, HEARTBEAT_MS));
      if (!heartbeatActive) break;
      try { await job.extendLock(job.token!, 30_000); } catch { /* lock may have already advanced */ }
    }
  })();

  try {
    const result = await invokeBase44Function<OrchestratorTickResult>({
      fn: 'orchestrateTranslationRun',
      authToken: auth_token,
      payload: { project_id, translation_run_id, request_id },
      timeoutMs: TICK_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:translate-orchestrator',
      event: 'translate_orchestrator_tick_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id, translation_run_id, user_email, request_id,
        attempts: job.attemptsMade + 1,
        next_tick: !!result.next_tick,
        finalized: !!result.finalized,
        chunk_cursor: result.chunk_cursor,
        chunk_total: result.chunk_total,
        chunks_dispatched: result.chunks_dispatched,
        chunk_in_flight: result.chunk_in_flight,
        chunk_completed: result.chunk_completed,
      },
    });

    if (result.next_tick && !result.finalized) {
      const delay = Math.max(500, Math.min(10_000, result.next_tick_delay_ms ?? 1_000));
      await orchestratorQueue().add(
        QUEUE_NAMES.TRANSLATE_ORCHESTRATOR,
        { ...job.data, request_id },
        // attempts=1: orchestrator retries cause counter drift.
        { ...ORCHESTRATOR_JOB_OPTIONS, attempts: 1, delay },
      );
    }

    return result;
  } catch (err) {
    const e = err as Error;

    // ─── AUDIT LOG (best-effort) ──────────────────────────────────────
    // logEvent itself goes through the same Base44 gateway that may be
    // the thing failing. We try it but never depend on it landing.
    await logEvent({
      function_name: 'bullmq:translate-orchestrator',
      level: 'error',
      event: 'translate_orchestrator_tick_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { project_id, translation_run_id, user_email, request_id, attempts: job.attemptsMade + 1 },
    }).catch(() => {});

    // ─── DIRECT WRITE TO TranslationRun.error_message ──────────────────
    // Incident 2026-05-18 (French run 6a0b8256...): the orchestrator's
    // FIRST tick failed inside the platform gateway-auth retry budget.
    // logEvent ALSO went through that gateway and was itself rejected,
    // so NO StructuredLog row was ever written. Result: 11 minutes of
    // "stuck at 0%" with zero diagnostic trail in Base44 — we had to
    // spelunk Railway logs to find the cause.
    //
    // Fix: when the tick fails, ask the Base44 fn to write the failure
    // reason directly onto the TranslationRun row using the scoped JWT
    // we already have. We pass a `_record_worker_failure` sentinel; the
    // Base44 fn checks for it first and writes error_message + status
    // without performing a tick. This goes through the same gateway —
    // by the time we hit this catch, the gateway's recovery curve is
    // usually on the upswing, so the second call typically succeeds.
    // Even if it also fails, we're no worse off than today; the
    // watchdog still catches the run in ≤5 min.
    //
    // SOC 2 CC7.2: every failure leaves an auditable trail on the
    // primary entity it concerns, not just in best-effort log surfaces.
    try {
      await invokeBase44Function({
        fn: 'orchestrateTranslationRun',
        authToken: auth_token,
        payload: {
          project_id,
          translation_run_id,
          request_id,
          _record_worker_failure: {
            message: e.message.slice(0, 400),
            error_kind: e.name,
            attempts: job.attemptsMade + 1,
            failed_at: new Date().toISOString(),
          },
        },
        timeoutMs: 15_000,
      });
    } catch (_) {
      // Already in a failure path — swallow secondary failure.
      // The watchdog will still catch the stuck run within 5 min.
    }

    throw err;
  } finally {
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}
