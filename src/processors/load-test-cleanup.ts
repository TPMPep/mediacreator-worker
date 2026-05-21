// =============================================================================
// LOAD-TEST-CLEANUP PROCESSOR (B8, 2026-05-21)
// -----------------------------------------------------------------------------
// Off-platform bulk cleanup for load-test fixtures. ONE job per
// LoadTestCleanupRun. Each tick calls Base44 fn `loadTestCleanupWorkerStep`,
// which deletes ONE bounded page (≤200 rows) of ONE entity bucket and
// returns next_tick. The processor re-enqueues itself until done.
//
// Same architecture as processLoadTestFanout / processVoiceGenOrchestrator
// / processTranslateOrchestrator / processAIRewriteOrchestrator. Same
// heartbeat pattern, same scoped-JWT auth model, same attempts=1 retry
// policy (counter-drift safety — re-running mid-tick would re-issue
// deletes already in flight; the step function is idempotent within its
// own boundary but we don't double down with BullMQ retries).
//
// Why this exists:
//   The in-platform `cleanupLoadTestArtifacts` function exceeded Base44's
//   30s HTTP ceiling on any fixture with >~2k accumulated rows — exactly
//   the failure mode that motivated B8 (504 timeout during artifact
//   deletion after the N=25 run). Moving cleanup to Railway eliminates
//   the ceiling: the worker's 1hr job budget grinds through arbitrarily
//   large fixtures.
//
// AUDIT POSTURE (SOC 2 CC8.1 / TPN MS-4.x):
//   Every fixture cleanup is provably attributable (LoadTestCleanupRun.
//   triggered_by + started_at + per-entity counts + final disposition).
//   The processor emits load_test_cleanup_tick_complete /
//   load_test_cleanup_tick_failed StructuredLog rows on every tick.
//   BullMQ retains failed jobs for 7 days — every failed cleanup is
//   queryable from the Compliance DLQ panel.
// =============================================================================

import type { Job } from 'bullmq';
import type { LoadTestCleanupJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';
import { Queue } from 'bullmq';
import { getRedis } from '../redis.js';
import { QUEUE_NAMES, ORCHESTRATOR_JOB_OPTIONS } from '../../shared/queue-contracts.js';

let _selfQueue: Queue | null = null;
function selfQueue(): Queue {
  if (!_selfQueue) {
    _selfQueue = new Queue(QUEUE_NAMES.LOAD_TEST_CLEANUP, { connection: getRedis() });
  }
  return _selfQueue;
}

const HEARTBEAT_MS = 15_000;
// Each cleanup tick targets a 22s budget on the Base44 side; 60s network-
// side ceiling gives comfortable headroom for the function to return.
const TICK_TIMEOUT_MS = 60_000;
// Hard wall-clock cap on a single cleanup run. A 5k-row cleanup completes
// in ~3-8 min under typical 429 pressure; anything past 1hr is pathological
// and should fail visibly so an admin notices.
const RUN_WALL_CLOCK_CAP_MS = 60 * 60 * 1000;

interface CleanupTickResult {
  next_tick?: boolean;
  next_tick_delay_ms?: number;
  finalized?: boolean;
  current_phase?: string;
  total_deleted?: number;
  tick_count?: number;
  tick_ms?: number;
}

export async function processLoadTestCleanup(job: Job<LoadTestCleanupJobData>) {
  const t0 = Date.now();
  const { cleanup_run_id, fixture_project_id, fixture_project_name, user_email, request_id, auth_token } = job.data;

  if (!auth_token) {
    throw new Error('load-test-cleanup: missing auth_token (cannot continue without scoped JWT)');
  }

  // Hard wall-clock cap. BullMQ's job.timestamp is set at the ORIGINAL
  // enqueue time and survives across self-re-enqueues, so this correctly
  // measures the cumulative wall-clock of the cleanup pass.
  const startedAt = job.timestamp ?? Date.now();
  if (Date.now() - startedAt > RUN_WALL_CLOCK_CAP_MS) {
    await logEvent({
      function_name: 'bullmq:load-test-cleanup',
      level: 'error',
      event: 'load_test_cleanup_wall_clock_exceeded',
      message: `Cleanup exceeded ${RUN_WALL_CLOCK_CAP_MS}ms wall-clock cap`,
      context: { cleanup_run_id, fixture_project_id, fixture_project_name, request_id, user_email },
    });
    // Don't throw — that triggers BullMQ retry. Just return so the run
    // is visibly stuck and an admin can mark it failed manually.
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
    const result = await invokeBase44Function<CleanupTickResult>({
      fn: 'loadTestCleanupWorkerStep',
      authToken: auth_token,
      payload: {
        cleanup_run_id,
        fixture_project_id,
        request_id,
      },
      timeoutMs: TICK_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:load-test-cleanup',
      event: 'load_test_cleanup_tick_complete',
      duration_ms: Date.now() - t0,
      context: {
        cleanup_run_id, fixture_project_id, fixture_project_name, user_email, request_id,
        attempts: job.attemptsMade + 1,
        tick_count: result.tick_count,
        current_phase: result.current_phase,
        total_deleted: result.total_deleted,
        next_tick: !!result.next_tick,
        finalized: !!result.finalized,
      },
    });

    // Re-enqueue for next tick if more work remains. The step function
    // returns its own delay recommendation; cap at 5s so a stalled phase
    // can't slow cleanup more than necessary while still being polite
    // to the Base44 rate limiter.
    if (result.next_tick && !result.finalized) {
      const delay = Math.max(200, Math.min(5_000, result.next_tick_delay_ms ?? 500));
      await selfQueue().add(
        QUEUE_NAMES.LOAD_TEST_CLEANUP,
        job.data,
        // attempts=1 by design — same rationale as load-test-fanout:
        // retrying mid-tick would re-issue deletes already in flight.
        // The step function is idempotent within its own boundary
        // (it page-fetches BEFORE deleting), so we don't double down
        // with BullMQ retries.
        { ...ORCHESTRATOR_JOB_OPTIONS, attempts: 1, delay },
      );
    }

    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:load-test-cleanup',
      level: 'error',
      event: 'load_test_cleanup_tick_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: {
        cleanup_run_id, fixture_project_id, fixture_project_name, user_email, request_id,
        attempts: job.attemptsMade + 1,
      },
    });
    throw err;
  } finally {
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}
