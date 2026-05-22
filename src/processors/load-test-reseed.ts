// =============================================================================
// LOAD-TEST-RESEED PROCESSOR (2026-05-22).
// -----------------------------------------------------------------------------
// Off-platform deterministic TranslationSegment reseed for load-test fixtures.
// ONE job per LoadTestReseedRun. Each tick calls Base44 fn
// `loadTestReseedWorkerStep`, which advances one language's
// delete-then-seed under its own 22s budget and returns next_tick. The
// processor re-enqueues itself until current_language_index ===
// languages.length.
//
// EXACT MIRROR of processLoadTestCleanup. Same architecture:
//   - attempts=1 by design (counter-drift safety — retrying mid-tick would
//     re-issue deletes or re-create rows already in flight).
//   - 120s network-side ceiling per tick (same as cleanup; absorbs 429
//     backoff amplification under sustained pressure).
//   - 1hr wall-clock cap per run.
//   - Heartbeat extends BullMQ job lock during long ticks.
//   - Self-re-enqueue decoupled from the tick try/catch — a Redis hiccup
//     never breaks the audit invariant (Base44 row always reflects ground
//     truth; admin can resume via watchdogLoadTestCleanup-style nudge if
//     needed — that's a P2 follow-up).
//
// SOC 2 CC8.1 / TPN MS-4.x — every reseed tick is structurally observable.
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
// Same posture as cleanup — 120s absorbs worst-case 429 backoff amplification.
const TICK_TIMEOUT_MS = 120_000;
// Hard wall-clock cap. 25-lang × 200-seg reseed completes in ~3-8 min under
// typical 429 pressure; anything past 1hr is pathological.
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

  // ─── Self-re-enqueue (decoupled from tick try/catch) ─────────────────
  // Same audit-invariant posture as cleanup: never lie about completed work,
  // never re-issue deletes/creates already in flight. If Redis hiccups,
  // emit a structured log and return ok — operator can resume manually.
  if (tickResult.next_tick && !tickResult.finalized) {
    const delay = Math.max(200, Math.min(5_000, tickResult.next_tick_delay_ms ?? 500));
    try {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        fn: 'bullmq:load-test-reseed',
        event: 'tick_self_reenqueue_attempt',
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
        },
      });
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
