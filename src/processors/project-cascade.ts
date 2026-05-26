// =============================================================================
// PROJECT-CASCADE PROCESSOR — Step-loop messenger for project cascade delete.
// -----------------------------------------------------------------------------
// AUDITOR FRAMING (SOC 2 CC6.7 / CC7.2 / CC8.1, TPN MS-1.x / MS-4.x):
//   This processor has NO Base44 SDK access and NO S3 client. It is a pure
//   step-loop messenger that calls projectCascadeWorkerStep in a loop until
//   action='done'. The function does all S3 + entity deletes inside Base44's
//   3-min function ceiling per tick.
//
// Pattern: identical to hls-ingest.ts. Idempotent — re-running on the same
// job is safe because the function's phase machine short-circuits when the
// Project row is already deleted.
//
// HEARTBEAT: 15s lock extension. A big cascade with 5000+ rows can take
// 5-10 minutes across many ticks; heartbeat keeps the BullMQ lock alive.
// =============================================================================

import type { Job } from 'bullmq';
import type { ProjectCascadeJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

const FUNCTION_CALL_TIMEOUT_MS = 150_000; // 2.5 min per tick (pagination + deletes)
const HEARTBEAT_MS = 15_000;
// Phases: queued → deleting_s3 → deleting_entities (×N) → deleting_project → finalize.
// 32 entities × up to a few ticks each + overhead. 200 is a generous guard.
const MAX_PHASE_ITERATIONS = 200;
// Wall-clock kill switch. If a single cascade job has been running for longer
// than this, abort and let BullMQ retry. Auditor-grade: prevents a stuck
// fetch / hung platform call from holding the queue's single worker slot
// indefinitely (the 2026-05-26 incident — job stuck "active" for 15+ min
// with no tick logs, blocking every subsequent cascade on the queue).
// 12 minutes = comfortable headroom for the largest cascade observed
// (Job Interview _Test: 354s = ~6 min) with 2× safety margin.
const WALL_CLOCK_KILL_MS = 12 * 60 * 1000;

interface PhaseStepResponse {
  action: 'recall_function' | 'done';
  phase?: string;
  done?: boolean;
  result?: unknown;
  carry?: unknown;
}

export async function processProjectCascade(job: Job<ProjectCascadeJobData>) {
  const t0 = Date.now();
  const { project_id, project_name, user_email, request_id, storage, auth_token } = job.data;

  if (!auth_token) {
    throw new Error('project-cascade: missing auth_token (job from a stale schema — re-enqueue required)');
  }

  // Heartbeat
  let heartbeatActive = true;
  const heartbeat = (async () => {
    while (heartbeatActive) {
      await new Promise(r => setTimeout(r, HEARTBEAT_MS));
      if (!heartbeatActive) break;
      try { await job.extendLock(job.token!, 30_000); } catch { /* lock may have advanced */ }
    }
  })();

  try {
    let carry: unknown = undefined;
    let lastPhase: string | undefined;

    for (let i = 0; i < MAX_PHASE_ITERATIONS; i++) {
      // Wall-clock kill — auditor-defensible safety belt against a stuck
      // fetch / hung platform call. If we've burned more than
      // WALL_CLOCK_KILL_MS on this single cascade, throw → BullMQ retry
      // path → next attempt starts cleanly (pre-flight check inside the
      // function will short-circuit if the project already got deleted by
      // another path in the meantime).
      const elapsedMs = Date.now() - t0;
      if (elapsedMs > WALL_CLOCK_KILL_MS) {
        throw new Error(
          `project-cascade: wall-clock kill at ${elapsedMs}ms ` +
          `(limit ${WALL_CLOCK_KILL_MS}ms, iteration ${i}, last phase ${lastPhase ?? 'none'})`,
        );
      }

      const step = await invokeBase44Function<PhaseStepResponse>({
        fn: 'projectCascadeWorkerStep',
        authToken: auth_token,
        payload: {
          project_id, project_name, user_email, request_id, storage, carry,
        },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
      });

      lastPhase = step.phase;

      await logEvent({
        function_name: 'bullmq:project-cascade',
        event: 'cascade_phase_tick',
        context: {
          project_id, project_name, user_email, request_id,
          attempts: job.attemptsMade + 1,
          iteration: i,
          action: step.action,
          phase: step.phase,
        },
      });

      if (step.action === 'done') {
        await logEvent({
          function_name: 'bullmq:project-cascade',
          event: 'cascade_complete',
          duration_ms: Date.now() - t0,
          context: {
            project_id, project_name, user_email, request_id,
            attempts: job.attemptsMade + 1,
            iterations: i + 1,
            phase: step.phase,
            result: step.result,
          },
        });
        return step.result ?? { ok: true, phase: step.phase };
      }

      if (step.action === 'recall_function') {
        carry = step.carry;
        continue;
      }

      throw new Error(`project-cascade: unknown action: ${String(step.action)}`);
    }

    throw new Error(`project-cascade: phase machine exceeded ${MAX_PHASE_ITERATIONS} iterations (last phase: ${lastPhase ?? 'none'})`);
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:project-cascade',
      level: 'error',
      event: 'cascade_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { project_id, project_name, user_email, request_id, attempts: job.attemptsMade + 1 },
    });

    try {
      await invokeBase44Function({
        fn: 'projectCascadeWorkerStep',
        authToken: auth_token,
        payload: {
          fail: true,
          project_id, project_name, user_email, request_id,
          error_message: e.message,
          duration_ms: Date.now() - t0,
        },
        timeoutMs: 30_000,
      });
    } catch { /* nothing to do */ }

    throw err;
  } finally {
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}
