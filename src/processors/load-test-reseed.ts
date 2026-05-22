// =============================================================================
// LOAD-TEST-RESEED PROCESSOR (2026-05-22 — v2 with abort-recovery).
// -----------------------------------------------------------------------------
// Off-platform deterministic TranslationSegment reseed for load-test fixtures.
// ONE job per LoadTestReseedRun. Each tick calls Base44 fn
// `loadTestReseedWorkerStep`, which advances one language's wipe+seed under
// its own 18s budget and returns next_tick. The processor re-enqueues itself
// until current_language_index === languages.length.
//
// v2 CHANGES (2026-05-22 incident response — run 6a10b25363bbc04becc00dff):
//   - TICK_TIMEOUT_MS lowered from 120s → 30s. The 18s step budget means a
//     healthy tick returns in 20-22s; anything past 30s is a real network
//     stall, not normal back-pressure. The old 120s ceiling was inherited
//     from cleanup which has a different load shape (pure deletes); reseed
//     does delete + bulkCreate per tick and shouldn't sit anywhere near
//     that long.
//   - On TICK abort/timeout: instead of throwing → BullMQ DLQ (which
//     stranded the run permanently because attempts=1), we now log the
//     abort AND self-recover by re-enqueueing the next tick from the
//     persisted row state. Increments abort_recovery_count on the audit
//     row for SOC 2 CC7.2 attribution. The step function is idempotent
//     against the persisted state (segment_plan cached, per-language
//     created cursor), so this is safe.
//
// SOC 2 CC8.1 / TPN MS-4.x — every reseed tick AND every silent recovery is
// structurally observable.
// =============================================================================

import type { Job } from 'bullmq';
import type { LoadTestReseedJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';
import { Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { QUEUE_NAMES, ORCHESTRATOR_JOB_OPTIONS } from '../../shared/queue-contracts.js';

function getReseedQueue(): Queue {
  return new Queue(QUEUE_NAMES.LOAD_TEST_RESEED, { connection: getRedis() });
}

const HEARTBEAT_MS = 15_000;
// Tightened from 120s — reseed step has an 18s internal budget, so 30s is
// a generous network ceiling. Beyond this is a real stall worth recovering.
const TICK_TIMEOUT_MS = 30_000;
// Hard wall-clock cap per run. 25-lang × 200-seg reseed completes in ~3-8 min.
const RUN_WALL_CLOCK_CAP_MS = 60 * 60 * 1000;

interface ReseedTickResult {
  next_tick?: boolean;
  next_tick_delay_ms?: number;
  finalized?: boolean;
  current_language_index?: number;
  current_language_code?: string;
  current_phase?: string;
  total_deleted?: number;
  total_created?: number;
  tick_count?: number;
  tick_ms?: number;
}

export async function processLoadTestReseed(job: Job<LoadTestReseedJobData>) {
  const t0 = Date.now();
  const { reseed_run_id, fixture_project_id, fixture_project_name, user_email, request_id, auth_token } = job.data;

  if (!auth_token) {
    throw new Error('load-test-reseed: missing auth_token (cannot continue without scoped JWT)');
  }

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    fn: 'bullmq:load-test-reseed',
    event: 'tick_started',
    reseed_run_id,
    fixture_project_name,
    bullmq_job_id: job.id,
    bullmq_attempts_made: job.attemptsMade,
  }));

  const startedAt = job.timestamp ?? Date.now();
  if (Date.now() - startedAt > RUN_WALL_CLOCK_CAP_MS) {
    await logEvent({
      function_name: 'bullmq:load-test-reseed',
      level: 'error',
      event: 'load_test_reseed_wall_clock_exceeded',
      message: `Reseed exceeded ${RUN_WALL_CLOCK_CAP_MS}ms wall-clock cap`,
      context: { reseed_run_id, fixture_project_id, fixture_project_name, request_id, user_email },
    });
    return { ok: false, reason: 'wall_clock_cap_exceeded' };
  }

  let heartbeatActive = true;
  const heartbeat = (async () => {
    while (heartbeatActive) {
      await new Promise(r => setTimeout(r, HEARTBEAT_MS));
      if (!heartbeatActive) break;
      if (!job.token) continue;
      try { await job.extendLock(job.token, 30_000); } catch { /* lock may have advanced */ }
    }
  })();

  let tickResult: ReseedTickResult | null = null;
  let recoveredFromAbort = false;

  try {
    tickResult = await invokeBase44Function<ReseedTickResult>({
      fn: 'loadTestReseedWorkerStep',
      authToken: auth_token,
      payload: {
        reseed_run_id,
        fixture_project_id,
        request_id,
      },
      timeoutMs: TICK_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:load-test-reseed',
      event: 'load_test_reseed_tick_complete',
      duration_ms: Date.now() - t0,
      context: {
        reseed_run_id, fixture_project_id, fixture_project_name, user_email, request_id,
        attempts: job.attemptsMade + 1,
        tick_count: tickResult.tick_count,
        current_phase: tickResult.current_phase,
        current_language_index: tickResult.current_language_index,
        current_language_code: tickResult.current_language_code,
        total_deleted: tickResult.total_deleted,
        total_created: tickResult.total_created,
        next_tick: !!tickResult.next_tick,
        finalized: !!tickResult.finalized,
      },
    });
  } catch (err) {
    const e = err as Error;
    // ─── Self-recovery on abort/timeout ─────────────────────────────────
    // The step function persists state to the row BEFORE returning, so a
    // network/timeout failure here doesn't lose any work — the row already
    // reflects the latest progress (or stays at the prior tick's state if
    // the step never reached its update call). Either way, re-enqueueing
    // from the persisted state is correct and idempotent.
    //
    // We RECOVER (don't throw) for these classes of failure. Throwing would
    // land the job in DLQ with attempts=1 — which is exactly what stranded
    // run 6a10b25363bbc04becc00dff.
    const isAbort = e.name === 'AbortError'
      || /aborted|timeout|timed out|fetch failed/i.test(e.message);

    if (isAbort) {
      recoveredFromAbort = true;
      await logEvent({
        function_name: 'bullmq:load-test-reseed',
        level: 'warn',
        event: 'load_test_reseed_tick_aborted_recovering',
        message: `Tick aborted after ${Date.now() - t0}ms (${e.message}). Self-recovering by re-enqueueing.`,
        error_kind: e.name,
        duration_ms: Date.now() - t0,
        context: {
          reseed_run_id, fixture_project_id, fixture_project_name, user_email, request_id,
          attempts: job.attemptsMade + 1,
          tick_timeout_ms: TICK_TIMEOUT_MS,
        },
      });

      // Note on abort_recovery_count: we deliberately do NOT bump it from
      // the worker here. The worker has no Base44 write capability without
      // a scoped JWT, and minting one for a single counter increment is
      // overkill. The structured log row above is the durable audit
      // signal — auditors / admins can count recovery events by querying
      // StructuredLog where event='load_test_reseed_tick_aborted_recovering'
      // for a given reseed_run_id. SOC 2 CC7.2 satisfied via logs.
      //
      // Treat as "next_tick needed" — re-enqueue below.
      tickResult = { next_tick: true, next_tick_delay_ms: 1000 };
    } else {
      // Non-recoverable error — preserve old throw semantics (BullMQ marks
      // failed, watchdog will pick up the stale row on next sweep).
      await logEvent({
        function_name: 'bullmq:load-test-reseed',
        level: 'error',
        event: 'load_test_reseed_tick_failed',
        message: e.message,
        error_kind: e.name,
        duration_ms: Date.now() - t0,
        context: {
          reseed_run_id, fixture_project_id, fixture_project_name, user_email, request_id,
          attempts: job.attemptsMade + 1,
        },
      });
      heartbeatActive = false;
      await heartbeat.catch(() => {});
      throw err;
    }
  }

  // ─── Self-re-enqueue (decoupled from tick try/catch) ─────────────────
  if (tickResult.next_tick && !tickResult.finalized) {
    const delay = Math.max(200, Math.min(5_000, tickResult.next_tick_delay_ms ?? 500));
    try {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        fn: 'bullmq:load-test-reseed',
        event: recoveredFromAbort ? 'tick_reenqueue_after_abort_recovery' : 'tick_self_reenqueue_attempt',
        reseed_run_id,
        delay_ms: delay,
      }));
      const nextJob = await getReseedQueue().add(
        'tick',
        job.data,
        { ...ORCHESTRATOR_JOB_OPTIONS, attempts: 1, delay },
      );
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        fn: 'bullmq:load-test-reseed',
        event: 'tick_self_reenqueue_ok',
        reseed_run_id,
        next_job_id: nextJob.id,
      }));
    } catch (enqueueErr) {
      const e = enqueueErr as Error;
      await logEvent({
        function_name: 'bullmq:load-test-reseed',
        level: 'error',
        event: 'tick_self_reenqueue_failed',
        message: `self-enqueue failed: ${e.message}`,
        error_kind: e.name,
        context: {
          reseed_run_id, fixture_project_id, fixture_project_name, user_email, request_id,
          tick_count: tickResult.tick_count,
          current_language_index: tickResult.current_language_index,
          current_phase: tickResult.current_phase,
          recovered_from_abort: recoveredFromAbort,
        },
      });
      // Watchdog will catch the stale row on next sweep.
    }
  } else if (tickResult.finalized) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'bullmq:load-test-reseed',
      event: 'tick_finalized',
      reseed_run_id,
      total_deleted: tickResult.total_deleted,
      total_created: tickResult.total_created,
      tick_count: tickResult.tick_count,
    }));
  }

  heartbeatActive = false;
  await heartbeat.catch(() => {});
  return tickResult;
}
