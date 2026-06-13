// =============================================================================
// GLTV-CASCADE PROCESSOR — Transport executor for the GLTV Dubbing API cascade.
// -----------------------------------------------------------------------------
// FULLY ISOLATED PRODUCT SURFACE. This processor only ever advances a
// DubbingApiJob (api_product='gltv_api') via its brain function on Base44.
// It never reads/writes any human-facing entity directly.
//
// ─── DIRECTIVE MODEL (Option A, 2026-06-13) ───────────────────────────────
// AUTH-BOUNDARY CORRECTION. Proven dead transports for Base44-fn → producer:
//   ❌ base44.functions.invoke(fn, body, { headers })  — custom header DROPPED.
//   ❌ Base44-fn → same-deployment raw fetch            — 508 Loop Detected.
// The ONLY header-bearing transport is THIS worker → Base44 raw fetch (it
// crosses the deployment boundary, so a custom header lands on the wire).
//
// THEREFORE the BRAIN (gltvCascadeWorkerStep) decides + persists; THIS worker
// is the pure TRANSPORT that executes the producer HTTP call the brain asks
// for. The worker holds NO orchestration knowledge — it just relays HTTP and
// the brain's directives.
//
// ─── PER-TICK FLOW ────────────────────────────────────────────────────────
//   1. Call brain in DECIDE mode → get an action.
//   2. If action='call_producer':
//        a. POST the producer (directive.producer_fn) with directive.body +
//           BOTH headers: X-Gltv-System-JWT (directive.system_jwt, the auth-
//           bypass) and X-Worker-JWT (directive.gateway_jwt, gateway admission).
//        b. Call the brain again in RECORD mode with { producer_result } so the
//           brain persists the run-id + status transition (sole writer).
//        c. The RECORD response carries the real next action (advance/done/...).
//   3. Re-enqueue the next tick for continue/advance; exit for await_review/done.
//
// IDEMPOTENCY
// The brain short-circuits if DubbingApiJob.status is already terminal. Its
// directives are keyed by *_run_id, so a re-run never double-starts a phase.
//
// HEARTBEAT
// A producer call (e.g. runTranscription polling internally) can briefly exceed
// the BullMQ 30s stall window. We extend the job lock every 15s.
//
// AUTH MODEL
// • Worker→brain: scoped JWT (job.data.auth_token) bound to (system,
//   dubbing_api_job_id, 'gltvCascadeWorkerStep'). Forwarded as X-Worker-JWT.
// • Worker→producer: BOTH tokens are MINTED BY THE BRAIN and handed to the
//   worker in the directive. The worker never mints a producer token itself —
//   it only relays what the brain provides. Blast radius of a leaked directive
//   token: ONE producer fn, ONE job, ≤30 min.
//
// SOC 2 CC7.2 — resumable across pod death. CC8.1 — the brain is the sole
// writer of job.status / *_run_id / phase_history; the producer result is
// verified server-side (in the brain) BEFORE any status mutation.
// =============================================================================

import type { Job, Queue } from 'bullmq';
import type { GltvCascadeJobData } from '../../shared/queue-contracts.js';
import { QUEUE_NAMES, GLTV_CASCADE_JOB_OPTIONS } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';
import { env } from '../env.js';

const FUNCTION_CALL_TIMEOUT_MS = 90_000;   // One brain step (decide or record).
const PRODUCER_CALL_TIMEOUT_MS = 120_000;  // One producer POST (e.g. transcription start/poll).
const HEARTBEAT_MS = 15_000;
// Delay before the worker re-enqueues the NEXT tick. Approved cadence: 10s.
const TICK_DELAY_MS = 10_000;

interface CascadeStepResponse {
  action: 'continue' | 'advance' | 'await_review' | 'done' | 'call_producer';
  status?: string;
  phase?: string;
  progress_pct?: number;
  already_terminal?: boolean;
  result?: unknown;
  // call_producer directive fields (brain → worker):
  producer_fn?: string;
  body?: Record<string, unknown>;
  system_jwt?: string;
  gateway_jwt?: string;
  expected_result_contract?: string;
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
 * Execute the brain's call_producer directive: raw-fetch the producer with
 * BOTH the system-JWT (auth bypass) and the gateway-JWT (gateway admission)
 * on the wire. Returns the parsed producer response + HTTP status. The worker
 * does NOT interpret the result — it relays it back to the brain in RECORD mode.
 */
async function executeProducerDirective(directive: CascadeStepResponse): Promise<{ data: unknown; status: number }> {
  const url = `${env.BASE44_FUNCTION_URL}/${directive.producer_fn}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRODUCER_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Id': env.BASE44_APP_ID,
        // The producer's GLTV seam reads THIS — the auth-bypass token.
        'X-Gltv-System-JWT': directive.system_jwt!,
        // Gateway admission for an unauthenticated server-to-server call.
        // (Worker finding 2026-05-06: send the scoped JWT, NEVER Authorization.)
        'X-Worker-JWT': directive.gateway_jwt!,
      },
      body: JSON.stringify(directive.body ?? {}),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let data: unknown;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { _raw: text.slice(0, 500) }; }
    return { data, status: res.status };
  } finally {
    clearTimeout(timer);
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
      // ─── 1. DECIDE: ask the brain what to do next ──────────────────
      let step: CascadeStepResponse = await invokeBase44Function<CascadeStepResponse>({
        fn: 'gltvCascadeWorkerStep',
        authToken: auth_token,
        payload: { dubbing_api_job_id, project_id, request_id },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
      });

      // ─── 2. call_producer: relay the producer call, then RECORD ────
      if (step.action === 'call_producer') {
        await _log('info', 'gltv_cascade_producer_directive', {
          ...baseCtx, producer_fn: step.producer_fn, phase: step.phase,
          contract: step.expected_result_contract,
        }, `Brain directive: call producer ${step.producer_fn} for phase ${step.phase}.`);

        const producerResp = await executeProducerDirective(step);

        await _log('info', 'gltv_cascade_producer_done', {
          ...baseCtx, producer_fn: step.producer_fn, phase: step.phase,
          producer_http_status: producerResp.status,
        }, `Producer ${step.producer_fn} returned HTTP ${producerResp.status}.`);

        // RECORD: hand the producer result back to the brain so it persists
        // the run-id + status transition (the brain is the sole status writer).
        step = await invokeBase44Function<CascadeStepResponse>({
          fn: 'gltvCascadeWorkerStep',
          authToken: auth_token,
          payload: {
            dubbing_api_job_id,
            project_id,
            request_id,
            producer_result: {
              phase: step.phase,
              data: producerResp.data,
              status: producerResp.status,
            },
          },
          timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
        });

        await _log('info', 'gltv_cascade_record_done', {
          ...baseCtx, action: step.action, status: step.status, phase: step.phase,
        }, `Brain recorded transition → action=${step.action} (status=${step.status ?? '?'}).`);
      } else {
        await _log('info', 'gltv_cascade_step_done', {
          ...baseCtx,
          action: step.action,
          status: step.status,
          phase: step.phase,
          progress_pct: step.progress_pct,
          already_terminal: !!step.already_terminal,
          tick_ms: Date.now() - t0,
        }, `Step returned action=${step.action} (status=${step.status ?? '?'} phase=${step.phase ?? '?'}).`);
      }

      // ─── 3. Re-enqueue / exit per the (final) action ───────────────
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

      // await_review (checkpoint mode) — EXIT cleanly. gltvApproveDubbingJob
      // re-enqueues a fresh tick when the API caller approves.
      if (step.action === 'await_review') {
        await _log('info', 'gltv_cascade_awaiting_review', {
          ...baseCtx, total_duration_ms: Date.now() - t0, heartbeat_ticks: heartbeatTicks,
        }, 'Cascade parked at awaiting_review (checkpoint mode) — exiting until approval.');
        return { ok: true, action: 'await_review', status: step.status, duration_ms: Date.now() - t0 };
      }

      // done — terminal (completed/failed/cancelled).
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
