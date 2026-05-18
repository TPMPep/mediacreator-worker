// =============================================================================
// LOAD-TEST-FANOUT PROCESSOR (2026-05-18)
// -----------------------------------------------------------------------------
// Off-platform fan-out for the admin load-test harness. ONE job per
// LoadTestRun. Each tick calls Base44 fn `loadTestFanoutWorkerStep`, which
// fires a bounded batch of producer calls (e.g. enqueueTranslation per
// target language) under its own 30s function budget. The orchestrator
// re-enqueues itself until dispatch_cursor === concurrency_target.
//
// Same architecture as processVoiceGenOrchestrator / processTranslateOrchestrator
// / processAIRewriteOrchestrator. Same heartbeat pattern, same scoped-JWT
// auth model, same attempts=1 retry policy (counter-drift safety).
//
// Why this exists:
//   The previous synchronous-in-Base44 fan-out got killed by the platform's
//   30s HTTP ceiling at N≈15+. That made it impossible to honestly load-test
//   the Base44 runtime at enterprise scale (N=50, N=100) — any "failure"
//   could have been the harness, not the system. Moving the fan-out to
//   Railway eliminates that ambiguity: when N=50 burst now fails, the
//   failure is unambiguously in the Base44 surface under test.
// =============================================================================

import type { Job } from 'bullmq';
import type { LoadTestFanoutJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';
import { Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { QUEUE_NAMES, ORCHESTRATOR_JOB_OPTIONS } from '../../shared/queue-contracts.js';

let _selfQueue: Queue | null = null;
function selfQueue(): Queue {
  if (!_selfQueue) {
    _selfQueue = new Queue(QUEUE_NAMES.LOAD_TEST_FANOUT, { connection: getRedis() });
  }
  return _selfQueue;
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
      try { await job.extendLock(job.token!, 30_000); } catch { /* lock may have advanced */ }
    }
  })();

  try {
    const result = await invokeBase44Function<FanoutTickResult>({
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

    // Re-enqueue for next tick if more work remains.
    if (result.next_tick && !result.finalized) {
      // The step function returns its own delay recommendation, derived
      // from the requested stagger_ms minus the time already spent in the
      // tick. This is how we honour user-configured stagger across ticks.
      const delay = Math.max(200, Math.min(60_000, result.next_tick_delay_ms ?? 500));
      await selfQueue().add(
        QUEUE_NAMES.LOAD_TEST_FANOUT,
        {
          ...job.data,
          state: {
            dispatch_cursor: result.dispatch_cursor ?? job.data.state.dispatch_cursor,
            tick_count: (job.data.state.tick_count ?? 0) + 1,
          },
        },
        // attempts=1 by design — same rationale as the other orchestrators:
        // a retry mid-tick after a partial batch would re-fire producer
        // calls and inflate the recorded concurrency. The step function
        // is responsible for being idempotent within a single tick; we
        // don't double down on that with BullMQ retries.
        { ...ORCHESTRATOR_JOB_OPTIONS, attempts: 1, delay },
      );
    }

    return result;
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
    throw err;
  } finally {
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}
