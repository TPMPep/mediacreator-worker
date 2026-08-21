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

import { DelayedError } from 'bullmq';
import type { Job, Queue } from 'bullmq';
import type { GltvCascadeJobData } from '../../shared/queue-contracts.js';
// QUEUE_NAMES is no longer needed here: the tick continues itself via
// job.moveToDelayed (ONE persistent job) instead of adding a new job.
import { invokeBase44Function, logEvent, runWithLockHeartbeat, WorkerLockLostError } from '../base44-client.js';
import { env } from '../env.js';

const FUNCTION_CALL_TIMEOUT_MS = 90_000;   // One brain step (decide or record).
const PRODUCER_CALL_TIMEOUT_MS = 120_000;  // One producer POST (e.g. transcription start/poll).
// Delay before the worker re-enqueues the NEXT tick. Approved cadence: 10s.
const TICK_DELAY_MS = 10_000;
// Safety cap on how many producer calls a SINGLE tick may chain. The brain
// can legitimately return a `call_producer` directive as the result of a
// RECORD step (e.g. the scan-clean RECORD writes status='transcribing' and
// then immediately directs runTranscription in the same response). The worker
// therefore loops: execute producer → RECORD → if the RECORD itself returns
// another `call_producer`, execute that too, until the brain returns a
// non-directive action (continue/advance/await_review/done). This cap is the
// belt-and-suspenders guard against a misbehaving brain spinning a tick
// forever — under correct operation a tick chains at most 2 producer calls
// (the phase's own + one RECORD-then-directive handoff). SOC 2 CC7.2.
const MAX_PRODUCER_CHAIN_PER_TICK = 4;

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
  // Fix A′ (2026-06-17): a FRESH worker auth_token the brain mints on every
  // non-terminal response (continue/advance/await_review). The worker uses it
  // for the NEXT re-enqueue so a long-running cascade never carries a stale,
  // about-to-expire token across ticks (root cause of the rewriting_cps freeze
  // with `jwt: expired`). Absent on terminal/done and on call_producer
  // directives (the in-tick RECORD reuses the token already held; the RECORD's
  // final non-directive response carries the renewed token forward).
  next_auth_token?: string;
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
async function executeProducerDirective(directive: CascadeStepResponse, lockSignal?: AbortSignal): Promise<{ data: unknown; status: number }> {
  const url = `${env.BASE44_FUNCTION_URL}/${directive.producer_fn}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PRODUCER_CALL_TIMEOUT_MS);
  // Zombie-kill (2026-06-16): if the BullMQ lock is lost mid-producer-call,
  // runWithLockHeartbeat aborts lockSignal → we abort this fetch immediately so
  // the producer POST cancels instead of the invocation running as a zombie
  // parallel to the reclaim. Whichever fires first (timeout or lock-loss) wins.
  const onLockLost = () => ctrl.abort();
  if (lockSignal) {
    if (lockSignal.aborted) ctrl.abort();
    else lockSignal.addEventListener('abort', onLockLost, { once: true });
  }
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
    if (lockSignal) lockSignal.removeEventListener('abort', onLockLost);
  }
}

/**
 * Process one GLTV cascade tick.
 *
 * ─── SELF-CONTINUATION: ONE PERSISTENT JOB, MANY TICKS (2026-08-21e) ────────
 * The tick does NOT add a successor job. It reschedules ITSELF via
 * job.moveToDelayed, so a cascade is represented by exactly ONE BullMQ job whose
 * deterministic id (gltv-cascade-<dubbing_api_job_id>) exists continuously from
 * the first tick until the cascade terminalises.
 *
 * WHY THIS REPLACED THE SELF-RE-ENQUEUE. The previous tick re-enqueued a new job
 * carrying the same deterministic id — while its OWN job was still `active` and
 * therefore still holding that id. BullMQ deduped the add against the incumbent
 * (itself), added nothing, and the tick then completed and was removed: the chain
 * died silently after exactly one tick. Measured on the W0 rerun (job
 * 6a886ec0bfeef21361f9928a): one tick advanced queued → scanning → transcribing
 * via the directive chain, returned `continue`, and the queue went to 0 active /
 * 0 waiting / 0 delayed with the job frozen at 10% and updated_date never
 * advancing again. Single-flight was correct; liveness was not.
 *
 * moveToDelayed makes the two properties inseparable rather than traded off:
 *   • LIVENESS — the job is rescheduled, never re-created, so nothing can dedupe
 *     the continuation against itself.
 *   • SINGLE-FLIGHT — the id is occupied for the WHOLE cascade, including while
 *     the tick is waiting in `delayed`, so an add from gltvEnqueueCascade or
 *     watchdogGltvCascade is collapsed by BullMQ at every instant. The previous
 *     design left the id free between ticks, which is exactly the window the
 *     watchdog resumed into on the original W0 baseline (it cannot see `delayed`),
 *     producing the two concurrent deciders that double-rendered 17 lines.
 *   • The renewed per-tick auth token (Fix A′) is carried by job.updateData, so a
 *     long cascade still never runs on an expiring JWT.
 *
 * A DelayedError is BullMQ's contract for "this job has been rescheduled, do not
 * treat the handler's exit as success or failure" — it consumes no attempt and
 * writes no failure. SOC 2 CC7.2 (bounded, resumable, no silent stall) / CC7.4
 * (one decider ⇒ paid producer work is never issued twice).
 *
 * The queue-handle factory argument is retained so index.ts's registration stays
 * unchanged; the processor no longer needs it.
 */
export function makeGltvCascadeProcessor(_getQueue: (name: string) => Queue) {
  return async function processGltvCascade(job: Job<GltvCascadeJobData>, token?: string) {
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

    // runWithLockHeartbeat (base44-client) owns the lock-renewal loop AND aborts
    // the in-flight brain/producer call the instant the BullMQ lock is lost.
    // This closes the unbounded active/reclaim zombie loop root-caused on the
    // GLTV cold-start (run 6a310a7b…, chunk 2701): a hung invocation kept
    // running parallel to BullMQ's stalled-reclaim, never terminalising, so the
    // job looped `active` forever and wedged the cascade. See the
    // runWithLockHeartbeat header for the full mechanism + SOC 2 rationale.
    try {
      return await runWithLockHeartbeat(job, async (signal) => {
      // ─── 1. DECIDE: ask the brain what to do next ──────────────────
      let step: CascadeStepResponse = await invokeBase44Function<CascadeStepResponse>({
        fn: 'gltvCascadeWorkerStep',
        authToken: auth_token,
        payload: { dubbing_api_job_id, project_id, request_id },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
        signal,
      });

      // ─── 2. call_producer: relay the producer call, then RECORD ────
      // LOOP, not a single `if`: the brain may return a `call_producer`
      // directive as the result of EITHER a DECIDE step OR a RECORD step. The
      // scan-clean RECORD is the canonical case — it persists status='transcribing'
      // and then directs runTranscription in the SAME response. A single `if`
      // executed only the first directive and silently dropped a directive that
      // came back from the RECORD, wedging the cascade at the scan→transcription
      // handoff (the run-id never got pinned, no next tick was enqueued). The
      // loop drains the directive chain until the brain returns a non-directive
      // action, bounded by MAX_PRODUCER_CHAIN_PER_TICK so a misbehaving brain can
      // never spin a tick forever. SOC 2 CC7.2 — resumable + non-wedging.
      let producerChainCount = 0;
      while (step.action === 'call_producer') {
        producerChainCount++;
        if (producerChainCount > MAX_PRODUCER_CHAIN_PER_TICK) {
          // The brain kept asking for producer calls past the safe ceiling.
          // Throw so BullMQ retries the tick / the watchdog resumes — never
          // silently drop the directive (that's the exact bug we are fixing).
          await _log('error', 'gltv_cascade_producer_chain_overflow', {
            ...baseCtx, producer_fn: step.producer_fn, phase: step.phase,
            chain_count: producerChainCount,
          }, `Producer chain exceeded ${MAX_PRODUCER_CHAIN_PER_TICK} in one tick — aborting tick for retry.`);
          throw new Error(`gltv-cascade: producer chain exceeded ${MAX_PRODUCER_CHAIN_PER_TICK} for job ${dubbing_api_job_id} (last producer ${step.producer_fn})`);
        }

        await _log('info', 'gltv_cascade_producer_directive', {
          ...baseCtx, producer_fn: step.producer_fn, phase: step.phase,
          chain_count: producerChainCount,
          contract: step.expected_result_contract,
        }, `Brain directive: call producer ${step.producer_fn} for phase ${step.phase}.`);

        const producerResp = await executeProducerDirective(step, signal);
        const directivePhase = step.phase; // pin before `step` is reassigned by RECORD

        await _log('info', 'gltv_cascade_producer_done', {
          ...baseCtx, producer_fn: step.producer_fn, phase: directivePhase,
          producer_http_status: producerResp.status,
        }, `Producer ${step.producer_fn} returned HTTP ${producerResp.status}.`);

        // RECORD: hand the producer result back to the brain so it persists
        // the run-id + status transition (the brain is the sole status writer).
        // The RECORD response may itself be another `call_producer` directive —
        // the while-loop executes it on the next iteration.
        step = await invokeBase44Function<CascadeStepResponse>({
          fn: 'gltvCascadeWorkerStep',
          authToken: auth_token,
          payload: {
            dubbing_api_job_id,
            project_id,
            request_id,
            producer_result: {
              phase: directivePhase,
              data: producerResp.data,
              status: producerResp.status,
            },
          },
          timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
          signal,
        });

        await _log('info', 'gltv_cascade_record_done', {
          ...baseCtx, action: step.action, status: step.status, phase: step.phase,
          chain_count: producerChainCount,
          chained_directive: step.action === 'call_producer',
        }, `Brain recorded transition → action=${step.action} (status=${step.status ?? '?'}).`);
      }
      if (producerChainCount === 0) {
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
        // Fix A′ (2026-06-17): use the FRESH token the brain minted on THIS
        // response for the next tick. Falls back to the current token only if
        // the brain didn't supply one (older brain build) — that fallback keeps
        // the cascade running on a pre-A′ brain, it just can't self-renew. With
        // the A′ brain, every re-enqueued tick starts its own fresh 30-min clock
        // so a slow cascade can never expire its own auth mid-run.
        const renewed = !!step.next_auth_token;
        const nextAuthToken = step.next_auth_token || auth_token;

        // The lock token is what proves THIS worker still owns the job, and
        // moveToDelayed cannot be performed without it. Its absence is not a
        // condition to paper over with a fallback `add` — an add would carry the
        // job's own still-occupied id and be deduped into a dead chain, which is
        // the exact defect this design replaced. Throw instead: the failure is
        // loud, and watchdogGltvCascade resumes the cascade under its bounded
        // 5-recovery budget.
        if (!token) {
          await _log('error', 'gltv_cascade_missing_lock_token', {
            ...baseCtx, action: step.action,
          }, 'Tick cannot self-reschedule without a BullMQ lock token — failing loudly so the watchdog resumes.');
          throw new Error(`gltv-cascade: missing BullMQ lock token for job ${dubbing_api_job_id} — cannot reschedule tick`);
        }

        // Carry the renewed auth token onto THIS job before rescheduling it, so
        // the next tick of the same job runs on a fresh 30-min clock.
        await job.updateData({
          schema_version: job.data.schema_version,
          dubbing_api_job_id,
          project_id,
          request_id,
          auth_token: nextAuthToken,
        });

        await _log('info', renewed ? 'gltv_cascade_auth_renewed' : 'gltv_cascade_next_tick_scheduled', {
          ...baseCtx, action: step.action, delay_ms: TICK_DELAY_MS, auth_token_renewed: renewed,
          continuation: 'move_to_delayed',
        }, `Rescheduled THIS cascade job for the next tick (delay ${TICK_DELAY_MS}ms${renewed ? ', with renewed auth token' : ''}).`);

        // Reschedule self, then signal BullMQ that the job was delayed rather
        // than finished. Done LAST so the lock-heartbeat loop never extends a
        // lock we have already released.
        await job.moveToDelayed(Date.now() + TICK_DELAY_MS, token);
        throw new DelayedError();
      }

      // await_review (checkpoint mode) — EXIT cleanly. gltvApproveDubbingJob
      // re-enqueues a fresh tick when the API caller approves.
      if (step.action === 'await_review') {
        await _log('info', 'gltv_cascade_awaiting_review', {
          ...baseCtx, total_duration_ms: Date.now() - t0,
        }, 'Cascade parked at awaiting_review (checkpoint mode) — exiting until approval.');
        return { ok: true, action: 'await_review', status: step.status, duration_ms: Date.now() - t0 };
      }

      // done — terminal (completed/failed/cancelled).
      await _log('info', 'gltv_cascade_done', {
        ...baseCtx,
        total_duration_ms: Date.now() - t0,
        status: step.status,
        already_terminal: !!step.already_terminal,
      }, `Cascade terminal (status=${step.status ?? '?'}).`);

      return step.result ?? { ok: true, action: 'done', status: step.status, duration_ms: Date.now() - t0 };
      }); // end runWithLockHeartbeat body
    } catch (err) {
      // A DelayedError is the successful self-reschedule path, not a failure:
      // rethrow it untouched so BullMQ parks the job in `delayed` without
      // consuming an attempt or writing a failure record.
      if (err instanceof DelayedError) throw err;
      const e = err as Error;
      const lockLost = e instanceof WorkerLockLostError;
      // Read .name/.stack/.message off the un-narrowed Error. (Narrowing `e` via
      // `instanceof WorkerLockLostError` makes the false branch `never` because
      // WorkerLockLostError is structurally identical to Error.)
      const errName: string = e.name;
      const errStack: string | undefined = e.stack;
      const errMessage: string = e.message;
      console.error(`[bullmq:gltv-cascade] ${lockLost ? 'gltv_cascade_lock_lost' : 'gltv_cascade_failure'} job=${job.id} dubbing_api_job=${dubbing_api_job_id} attempt=${job.attemptsMade + 1} duration_ms=${Date.now() - t0} error_kind=${errName} message=${String(errMessage || '').slice(0, 500)}`);
      if (errStack && !lockLost) {
        console.error(`[bullmq:gltv-cascade] stack: ${errStack.split('\n').slice(0, 5).join(' | ')}`);
      }
      await _log(lockLost ? 'warn' : 'error', lockLost ? 'gltv_cascade_lock_lost' : 'gltv_cascade_failed', {
        ...baseCtx,
        total_duration_ms: Date.now() - t0,
        error_kind: lockLost ? 'lock_lost' : errName,
      }, errMessage);
      // Re-throw so BullMQ owns the SINGLE reclaim. A lock-loss abort is a clean
      // exit of THIS tick, not a real failure — the brain is the sole status
      // writer and every step is idempotent/resumable, so the reclaim (or
      // watchdogGltvCascade) re-runs the tick exactly once with no double-write.
      console.error(`[bullmq:gltv-cascade] throwing_to_bullmq job=${job.id} attempt=${job.attemptsMade + 1} — BullMQ will retry or DLQ per GLTV_CASCADE_JOB_OPTIONS; watchdogGltvCascade resumes a stalled cascade.`);
      throw err;
    }
  };
}
