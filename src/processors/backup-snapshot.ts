// =============================================================================
// BACKUP-SNAPSHOT PROCESSOR — Step-loop messenger for weekly DB backup.
// -----------------------------------------------------------------------------
// AUDITOR FRAMING (SOC 2 CC7.4 / A.12.3 — backup integrity & retention):
//   This processor has NO Base44 SDK access and NO S3 client. It is a pure
//   step-loop messenger that calls backupSnapshotWorkerStep in a loop until
//   action='done'. The function does all entity reads + S3 writes inside
//   Base44's 3-min function ceiling per tick.
//
// Pattern: identical to hls-ingest.ts. Worker calls fn with `carry`, fn
// returns next phase + new carry, worker forwards it back. Idempotent.
//
// HEARTBEAT: 15s lock extension. Pagination of all ~40 entities at current
// scale completes in <5 min total (well under the BullMQ stalled-job ceiling
// once we heartbeat). Heartbeat keeps the lock alive between ticks.
// =============================================================================

import type { Job } from 'bullmq';
import type { BackupSnapshotJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

const FUNCTION_CALL_TIMEOUT_MS = 120_000; // 2 min per tick (pagination)
const HEARTBEAT_MS = 15_000;
// 40 entities + 4 phase ticks (queued, uploading, pruning, finalize) = ~50.
// 100 is a generous stuck-loop guard.
const MAX_PHASE_ITERATIONS = 100;

interface PhaseStepResponse {
  action: 'recall_function' | 'done';
  phase?: string;
  done?: boolean;
  result?: unknown;
  carry?: unknown;
}

export async function processBackupSnapshot(job: Job<BackupSnapshotJobData>) {
  const t0 = Date.now();
  const {
    date_stamp, s3_bucket, s3_region, entity_names, keep_last_n,
    user_email, request_id, auth_token,
  } = job.data;

  if (!auth_token) {
    throw new Error('backup-snapshot: missing auth_token (job from a stale schema — re-enqueue required)');
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
      const step = await invokeBase44Function<PhaseStepResponse>({
        fn: 'backupSnapshotWorkerStep',
        authToken: auth_token,
        payload: {
          date_stamp, s3_bucket, s3_region, entity_names, keep_last_n,
          user_email, request_id, carry,
        },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
      });

      lastPhase = step.phase;

      await logEvent({
        function_name: 'bullmq:backup-snapshot',
        event: 'backup_phase_tick',
        context: {
          date_stamp, user_email, request_id,
          attempts: job.attemptsMade + 1,
          iteration: i,
          action: step.action,
          phase: step.phase,
        },
      });

      if (step.action === 'done') {
        await logEvent({
          function_name: 'bullmq:backup-snapshot',
          event: 'backup_complete',
          duration_ms: Date.now() - t0,
          context: {
            date_stamp, user_email, request_id,
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

      throw new Error(`backup-snapshot: unknown action: ${String(step.action)}`);
    }

    throw new Error(`backup-snapshot: phase machine exceeded ${MAX_PHASE_ITERATIONS} iterations (last phase: ${lastPhase ?? 'none'})`);
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:backup-snapshot',
      level: 'error',
      event: 'backup_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { date_stamp, user_email, request_id, attempts: job.attemptsMade + 1 },
    });

    // Best-effort failure notice to the finalizer (so it writes the audit log).
    try {
      await invokeBase44Function({
        fn: 'backupSnapshotWorkerStep',
        authToken: auth_token,
        payload: {
          fail: true,
          date_stamp, user_email, request_id,
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
