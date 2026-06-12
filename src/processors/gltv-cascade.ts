
// =============================================================================
// GLTV-CASCADE PROCESSOR — Advance ONE GLTV Dubbing API job through its
// pipeline, one phase per tick, fully isolated from human Media Creator work.
// -----------------------------------------------------------------------------
// FULLY ISOLATED PRODUCT SURFACE. This processor only ever touches a
// DubbingApiJob (api_product='gltv_api') and its internal Project (tagged
// 'gltv_api'). It never reads/writes any human-facing entity for control flow.
//
// The producer is the Base44 fn `gltvEnqueueCascade` (gated behind the
// gltv_cascade_enabled FeatureFlag). On each tick this worker calls
// `gltvCascadeWorkerStep` on Base44, which performs EXACTLY ONE idempotent
// phase transition (start-or-poll keyed by the job's *_run_id fields, reading
// the FROZEN recipe_snapshot — never the live recipe) and returns one of:
//   • action='continue'     → current phase still running; re-enqueue self
//   • action='advance'      → phase complete + status advanced; re-enqueue self
//   • action='await_review' → checkpoint-mode parked at awaiting_review; EXIT
//                             (gltvApproveDubbingJob re-enqueues a fresh tick)
//   • action='done'         → terminal (completed/failed/cancelled); EXIT
//
// Pattern: identical shape to cc-cue-supersede (single-shot, tick-resumable,
// heartbeat-extended lock, JWT-scoped callback). The cascade re-enqueues a
// FRESH job for each continue/advance tick (with a 10s delay) rather than
// looping in-process — this keeps every tick bounded, gives the watchdog a
// clean per-tick staleness signal, and means a pod death between ticks loses
// nothing (the step is idempotent and resumes from DubbingApiJob.status).
//
// IDEMPOTENCY
// gltvCascadeWorkerStep short-circuits if DubbingApiJob.status is already
// terminal (returns action='done' with already_terminal=true). Start-or-poll
// per phase keyed by *_run_id means a re-run never double-starts a phase.
//
// HEARTBEAT
// A single tick's step call (start-or-poll) is short, but polling an
// underlying run can briefly exceed the BullMQ 30s stall window under load.
// We extend the job lock every 15s during the function call.
//
// AUTH MODEL
// Scoped JWT (60-min TTL) bound to (system, dubbing_api_job_id,
// 'gltvCascadeWorkerStep'). Worker forwards verbatim as X-Worker-JWT.
//
// SOC 2 CC7.2 — resumable across pod death. CC8.1 — every phase transition
// appends to DubbingApiJob.phase_history with timestamps + the underlying
// run id; the step (not the worker) is the sole writer of job.status.
// =============================================================================

import type { Job, Queue } from 'bullmq';
import type { GltvCascadeJobData } from '../../shared/queue-contracts.js';
import { QUEUE_NAMES, GLTV_CASCADE_JOB_OPTIONS } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

const FUNCTION_CALL_TIMEOUT_MS = 90_000;   // One phase step (start-or-poll).
const HEARTBEAT_MS = 15_000;
// Delay before the worker re-enqueues the NEXT tick. Approved cadence: 10s.
// Balances responsiveness against Base44 read pressure at 100+ concurrent jobs.
const TICK_DELAY_MS = 10_000;

interface CascadeStepResponse {
  action: 'continue' | 'advance' | 'await_review' | 'done';
  status?: string;
  phase?: string;
  progress_pct?: number;
  already_terminal?: boolean;
  result?: unknown;
}

async function _log(
  level: 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown>,
  message?: string,
) {
  const prefix = `[bullmq:gltv-cascade] ${event}`;
  const line = message ? `${prefix} — ${message} ${JSON.stringify(ctx)}` : `${prefix} ${JSON.stringify(ctx)}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    await logEvent({
      function_name: 'bullmq:gltv-cascade',
      level,
      event,
      message: message || event,
      context: ctx,
    });
  } catch (logErr) {
    console.error(`[bullmq:gltv-cascade] logEvent_failed event=${event} reason=${String((logErr as Error)?.message || logErr).slice(0, 200)}`);
  }
}

/**
 * Process one GLTV cascade tick. The processor needs a handle to its own queue
 * so it can re-enqueue the next tick (continue/advance). index.ts injects this
 * via a closure so the processor stays decoupled from the queue registry.
 */
export function makeGltvCascadeProcessor(getQueue: (name: string) => Queue) {
  return async function processGltvCascade(job: Job<GltvCascadeJobData>) {
    const t0 = Date.now();
    const { dubbing_api_job_id, project_id, request_id, auth_token } = job.data;
    const baseCtx = {
      dubbing_api_job_id,
      project_id,
      request_id,
      bullmq_job_id: job.id,
      attempts: job.attemptsMade + 1,
    };

    if (!auth_token) {
      await _log('error', 'gltv_cascade_missing_auth_token', baseCtx,
        'Job arrived without auth_token — producer schema is stale, re-enqueue required.');
      throw new Error('gltv-cascade: missing auth_token (job from a stale schema — re-enqueue required)');
    }

    await _log('info', 'gltv_cascade_tick_started', baseCtx,
      `Worker picked up cascade tick for DubbingApiJob ${dubbing_api_job_id} (attempt ${job.attemptsMade + 1}).`);

    let heartbeatActive = true;
    let heartbeatTicks = 0;
    const heartbeat = (async () => {
      while (heartbeatActive) {
        await new Promise(r => setTimeout(r, HEARTBEAT_MS));
        if (!heartbeatActive) break;
        try {
          await job.extendLock(job.token!, 30_000);
          heartbeatTicks++;
        } catch (hbErr) {
          console.warn(`[bullmq:gltv-cascade] heartbeat_lock_extend_failed job=${job.id} reason=${String((hbErr as Error)?.message || hbErr).slice(0, 200)}`);
        }
      }
    })();

    try {
      // ─── One bounded phase transition ──────────────────────────────
      const step: CascadeStepResponse = await invokeBase44Function<CascadeStepResponse>({
        fn: 'gltvCascadeWorkerStep',
        authToken: auth_token,
        payload: { dubbing_api_job_id, project_id, request_id },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
      });

      await _log('info', 'gltv_cascade_step_done', {
        ...baseCtx,
        action: step.action,
        status: step.status,
        phase: step.phase,
        progress_pct: step.progress_pct,
        already_terminal: !!step.already_terminal,
        tick_ms: Date.now() - t0,
      }, `Step returned action=${step.action} (status=${step.status ?? '?'} phase=${step.phase ?? '?'}).`);

      // ─── Re-enqueue the next tick for continue/advance ─────────────
      // A fresh job (not an in-process loop) keeps every tick bounded and
      // gives the watchdog a clean per-tick staleness signal. The producer
      // already minted a 60-min JWT; we reuse it across ticks (well within TTL
      // for a tick cadence of 10s). On a hard failure the JWT may approach
      // expiry — the watchdog re-enqueues with a fresh JWT in that case.
      if (step.action === 'continue' || step.action === 'advance') {
        const q = getQueue(QUEUE_NAMES.GLTV_CASCADE);
        await q.add(QUEUE_NAMES.GLTV_CASCADE, {
          schema_version: job.data.schema_version,
          dubbing_api_job_id,
          project_id,
          request_id,
          auth_token,
        }, { ...GLTV_CASCADE_JOB_OPTIONS, delay: TICK_DELAY_MS });

        await _log('info', 'gltv_cascade_next_tick_enqueued', {
          ...baseCtx, action: step.action, delay_ms: TICK_DELAY_MS,
        }, `Re-enqueued next cascade tick (delay ${TICK_DELAY_MS}ms).`);

        return { ok: true, action: step.action, status: step.status, duration_ms: Date.now() - t0 };
      }

      // ─── await_review (checkpoint mode) — EXIT cleanly ─────────────
      // The cascade parks at awaiting_review. gltvApproveDubbingJob re-enqueues
      // a fresh cascade tick when the API caller approves. The worker does NOT
      // re-enqueue here — that would busy-poll a parked job.
      if (step.action === 'await_review') {
        await _log('info', 'gltv_cascade_awaiting_review', {
          ...baseCtx, total_duration_ms: Date.now() - t0, heartbeat_ticks: heartbeatTicks,
        }, 'Cascade parked at awaiting_review (checkpoint mode) — exiting until approval.');
        return { ok: true, action: 'await_review', status: step.status, duration_ms: Date.now() - t0 };
      }

      // ─── done — terminal (completed/failed/cancelled) ──────────────
      await _log('info', 'gltv_cascade_done', {
        ...baseCtx,
        total_duration_ms: Date.now() - t0,
        heartbeat_ticks: heartbeatTicks,
        status: step.status,
        already_terminal: !!step.already_terminal,
      }, `Cascade terminal (status=${step.status ?? '?'}).`);

      return step.result ?? { ok: true, action: 'done', status: step.status, duration_ms: Date.now() - t0 };
    } catch (err) {
      const e = err as Error;
      console.error(`[bullmq:gltv-cascade] gltv_cascade_failure job=${job.id} dubbing_api_job=${dubbing_api_job_id} attempt=${job.attemptsMade + 1} duration_ms=${Date.now() - t0} error_kind=${e.name} message=${String(e.message || '').slice(0, 500)}`);
      if (e.stack) {
        console.error(`[bullmq:gltv-cascade] stack: ${e.stack.split('\n').slice(0, 5).join(' | ')}`);
      }
      await _log('error', 'gltv_cascade_failed', {
        ...baseCtx,
        total_duration_ms: Date.now() - t0,
        heartbeat_ticks: heartbeatTicks,
        error_kind: e.name,
      }, e.message);
      console.error(`[bullmq:gltv-cascade] throwing_to_bullmq job=${job.id} attempt=${job.attemptsMade + 1} — BullMQ will retry or DLQ per GLTV_CASCADE_JOB_OPTIONS; watchdogGltvCascade resumes a stalled cascade.`);
      throw err;
    } finally {
      heartbeatActive = false;
      await heartbeat.catch(() => {});
    }
  };
}
