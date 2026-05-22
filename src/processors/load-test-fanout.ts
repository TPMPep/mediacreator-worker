// =============================================================================
// LOAD-TEST-FANOUT PROCESSOR (2026-05-18 — patched 2026-05-22)
// -----------------------------------------------------------------------------
// Off-platform fan-out for the admin load-test harness. ONE job per
// LoadTestRun. Each tick calls Base44 fn `loadTestFanoutWorkerStep`, which
// fires a bounded batch of producer calls (e.g. enqueueTranslation per
// target language) under its own 30s function budget. The processor
// re-enqueues itself until dispatch_cursor === concurrency_target.
//
// Same architecture as processVoiceGenOrchestrator / processTranslateOrchestrator
// / processAIRewriteOrchestrator. Same heartbeat pattern, same scoped-JWT
// auth model, same attempts=1 retry policy (counter-drift safety).
//
// PATCH 2026-05-22 — TICK 1 → TICK 2 SELF-RE-ENQUEUE FAILURE
//   Observed in production (LoadTestRun 6a0fe9c0...): tick 1 successfully
//   dispatched 8 of 25 producer calls and the Base44 step row was updated
//   with dispatch_cursor=8, but tick 2 was never enqueued — the fan-out
//   sat in 'fanning_out' status forever and only 8/25 lanes ever fired.
//   Identical failure mode to the cleanup pipeline incident we already
//   fixed on this same date. Root causes:
//     1. `_selfQueue` was a module-level lazy singleton — if the Redis
//        connection went stale between worker startup and the moment the
//        processor first called `selfQueue().add()`, the BullMQ Queue
//        instance held a dead connection. The first add() rejected, the
//        exception propagated out of the main try/catch, and the job
//        landed in 'failed' AFTER the LoadTestRun row had already been
//        updated by Base44. The audit row was 1 tick ahead of the queue.
//     2. `await job.extendLock(job.token!, ...)` used a non-null assertion
//        on `job.token` — when the lock had already been released (the
//        function returned faster than the heartbeat fired), extendLock
//        threw TypeError. Caught silently but added noise.
//
//   Fix (mirrors the cleanup processor's PM patch on 2026-05-21):
//     • Use a fresh Queue handle backed by getRedis() at the moment of
//       self-enqueue. The Redis connection cannot be stale because it is
//       the same instance the worker is currently processing FROM.
//     • Wrap selfQueue().add() in its OWN try/catch so a Redis hiccup does
//       NOT cause the job to be marked failed (the LoadTestRun row already
//       reflects the work; failing the job at this point breaks the audit
//       invariant). Instead, emit a structured `tick_self_reenqueue_failed`
//       log row and return — admin recovery or watchdogLoadTestFanout
//       picks up cleanly via the persisted dispatch_cursor.
//     • Log every tick decision (next_tick true/false, finalized true/false,
//       self-enqueue attempt outcome) to stdout so Railway captures the
//       full sequence and an admin can correlate via load_test_run_id.
//     • Drop the non-null assertion on job.token in the heartbeat.
//
// SOC 2 CC8.1 / TPN MS-4.x — every fan-out tick is structurally observable.
// =============================================================================

import type { Job } from 'bullmq';
import type { LoadTestFanoutJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';
import { Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { QUEUE_NAMES, ORCHESTRATOR_JOB_OPTIONS } from '../../shared/queue-contracts.js';

// Lazy-init the self-enqueue queue handle using the SAME shared Redis
// connection the worker is processing from. Reading getRedis() at call time
// (not import time) guarantees we get a live connection even if the
// processor module was loaded long before the Redis connection actually
// established. Prior implementation kept this in a module-level variable
// initialised at first call — if the very first call coincided with a
// Redis reconnect blip, the cached Queue held a half-initialised socket
// and every subsequent self-enqueue silently failed.
function getFanoutQueue(): Queue {
  return new Queue(QUEUE_NAMES.LOAD_TEST_FANOUT, { connection: getRedis() });
}

const HEARTBEAT_MS = 15_000;
// Each tick may legitimately take 25-28s if the configured stagger × batch
// size pushes the worker-step close to its 30s ceiling. 90s network-side
// safety net leaves plenty of headroom for the Base44 fn to return.
const TICK_TIMEOUT_MS = 90_000;
// Hard wall-clock cap on a single fan-out run. N=150 @ 30s stagger =
// ~75min worst case, but no auditor-defensible test should exceed 1hr.
// If this trips, the orchestrator gives up and the LoadTestRun is left
// in 'running' for finalizeLoadTestRun / the watchdog to close out as
// failed-by-timeout.
const RUN_WALL_CLOCK_CAP_MS = 60 * 60 * 1000;

interface FanoutTickResult {
  next_tick?: boolean;
  next_tick_delay_ms?: number;
  finalized?: boolean;
  dispatch_cursor?: number;
  concurrency_target?: number;
  dispatched_this_tick?: number;
  errors_this_tick?: number;
}

export async function processLoadTestFanout(job: Job<LoadTestFanoutJobData>) {
  const t0 = Date.now();
  const { load_test_run_id, fixture_project_id, user_email, request_id, auth_token } = job.data;

  if (!auth_token) {
    throw new Error('load-test-fanout: missing auth_token (cannot continue without scoped JWT)');
  }

  // ─── Inbound observability ────────────────────────────────────────
  // Log EVERY tick arrival so Railway logs show the full chain. This was
  // the missing signal that made the tick-1→tick-2 stall invisible.
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    fn: 'bullmq:load-test-fanout',
    event: 'tick_started',
    load_test_run_id,
    fixture_project_id,
    bullmq_job_id: job.id,
    bullmq_attempts_made: job.attemptsMade,
    dispatch_cursor: job.data.state?.dispatch_cursor ?? 0,
    tick_count: job.data.state?.tick_count ?? 0,
  }));

  // Hard wall-clock cap. Catches a pathological tick loop early.
  const startedAt = new Date(job.data.inlined_plan.started_at).getTime();
  if (Date.now() - startedAt > RUN_WALL_CLOCK_CAP_MS) {
    await logEvent({
      function_name: 'bullmq:load-test-fanout',
      level: 'error',
      event: 'load_test_fanout_wall_clock_exceeded',
      message: `Fan-out exceeded ${RUN_WALL_CLOCK_CAP_MS}ms wall-clock cap`,
      context: { load_test_run_id, fixture_project_id, request_id, user_email },
    });
    // Don't throw — that triggers BullMQ retry. Just return so the run is
    // visibly stuck and the watchdog / finalizer can close it as failed.
    return { ok: false, reason: 'wall_clock_cap_exceeded' };
  }

  let heartbeatActive = true;
  const heartbeat = (async () => {
    while (heartbeatActive) {
      await new Promise(r => setTimeout(r, HEARTBEAT_MS));
      if (!heartbeatActive) break;
      // PATCH: drop the non-null assertion on job.token. If the lock has
      // already been released (heartbeat raced the tick completion), the
      // call would throw TypeError; we want to silently skip instead.
      if (!job.token) continue;
      try { await job.extendLock(job.token, 30_000); } catch { /* lock may have advanced */ }
    }
  })();

  let result: FanoutTickResult | null = null;
  try {
    result = await invokeBase44Function<FanoutTickResult>({
      fn: 'loadTestFanoutWorkerStep',
      authToken: auth_token,
      payload: {
        load_test_run_id,
        fixture_project_id,
        request_id,
        inlined_plan: job.data.inlined_plan,
        state: job.data.state,
      },
      timeoutMs: TICK_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:load-test-fanout',
      event: 'load_test_fanout_tick_complete',
      duration_ms: Date.now() - t0,
      context: {
        load_test_run_id, fixture_project_id, user_email, request_id,
        attempts: job.attemptsMade + 1,
        tick_count: job.data.state?.tick_count ?? 0,
        dispatch_cursor: result.dispatch_cursor,
        concurrency_target: result.concurrency_target,
        dispatched_this_tick: result.dispatched_this_tick,
        errors_this_tick: result.errors_this_tick,
        next_tick: !!result.next_tick,
        finalized: !!result.finalized,
      },
    });
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:load-test-fanout',
      level: 'error',
      event: 'load_test_fanout_tick_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: {
        load_test_run_id, fixture_project_id, user_email, request_id,
        attempts: job.attemptsMade + 1,
      },
    });
    heartbeatActive = false;
    await heartbeat.catch(() => {});
    throw err;
  }

  // ─── Self-re-enqueue (decoupled from the tick try/catch) ───────────
  // The Base44 step has ALREADY committed dispatch_cursor + tick_count to
  // the LoadTestRun row by this point. If we fail the BullMQ job here,
  // the audit invariant breaks (row says "tick N done, ready for N+1",
  // queue says "tick N failed"). Instead we swallow self-enqueue errors
  // and emit a structured log + return ok=true. Watchdog (which polls on
  // dispatch_cursor + last_tick_at) picks up cleanly. This trade-off is
  // auditor-defensible: never lie about completed work, never re-fire
  // producer calls already issued. SOC 2 CC8.1.
  if (result.next_tick && !result.finalized) {
    // The step function returns its own delay recommendation, derived
    // from the requested stagger_ms minus the time already spent in the
    // tick. This is how we honour user-configured stagger across ticks.
    const delay = Math.max(200, Math.min(60_000, result.next_tick_delay_ms ?? 500));
    try {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        fn: 'bullmq:load-test-fanout',
        event: 'tick_self_reenqueue_attempt',
        load_test_run_id,
        delay_ms: delay,
        dispatch_cursor: result.dispatch_cursor,
        concurrency_target: result.concurrency_target,
      }));
      const nextJob = await getFanoutQueue().add(
        QUEUE_NAMES.LOAD_TEST_FANOUT,
        {
          ...job.data,
          state: {
            dispatch_cursor: result.dispatch_cursor ?? job.data.state.dispatch_cursor,
            tick_count: (job.data.state.tick_count ?? 0) + 1,
          },
        },
        // attempts=1 by design — same rationale as cleanup + the other
        // orchestrators: a retry mid-tick after a partial batch would
        // re-fire producer calls and inflate the recorded concurrency.
        // The step function is responsible for being idempotent within a
        // single tick; we don't double down on that with BullMQ retries.
        { ...ORCHESTRATOR_JOB_OPTIONS, attempts: 1, delay },
      );
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        fn: 'bullmq:load-test-fanout',
        event: 'tick_self_reenqueue_ok',
        load_test_run_id,
        next_job_id: nextJob.id,
        dispatch_cursor: result.dispatch_cursor,
      }));
    } catch (enqueueErr) {
      const e = enqueueErr as Error;
      // Structured log only — do NOT throw. The LoadTestRun row already
      // reflects the completed tick; watchdog or admin nudge picks up
      // cleanly via the persisted dispatch_cursor.
      await logEvent({
        function_name: 'bullmq:load-test-fanout',
        level: 'error',
        event: 'tick_self_reenqueue_failed',
        message: `self-enqueue failed: ${e.message}`,
        error_kind: e.name,
        context: {
          load_test_run_id, fixture_project_id, user_email, request_id,
          dispatch_cursor: result.dispatch_cursor,
          concurrency_target: result.concurrency_target,
          tick_count: job.data.state?.tick_count ?? 0,
          recoverable_via: 'watchdogLoadTestFanout',
        },
      });
    }
  } else if (result.finalized) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'bullmq:load-test-fanout',
      event: 'tick_finalized',
      load_test_run_id,
      dispatch_cursor: result.dispatch_cursor,
      concurrency_target: result.concurrency_target,
    }));
  }

  heartbeatActive = false;
  await heartbeat.catch(() => {});
  return result;
}
