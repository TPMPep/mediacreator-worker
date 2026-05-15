// =============================================================================
// EXPORT-PROJECT PROCESSOR — Step-loop messenger for user-triggered exports.
// -----------------------------------------------------------------------------
// AUDITOR FRAMING (SOC 2 CC8.1 / TPN MS-4.x — deliverable chain of custody):
//   This processor has NO Base44 SDK access and NO S3 client. It is a pure
//   step-loop messenger that calls exportProjectWorkerStep in a loop until
//   action='done'. The function does all entity reads + format building +
//   S3 writes inside Base44's 3-min function ceiling per tick.
//
// Pattern: identical to hls-ingest.ts. Idempotent.
// =============================================================================

import type { Job } from 'bullmq';
import type { ExportJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

const FUNCTION_CALL_TIMEOUT_MS = 150_000; // 2.5 min per tick (pagination + build)
const HEARTBEAT_MS = 15_000;
// Phases: queued → loading_<kind> → building → finalize. 4 ticks minimum,
// 12 is generous if loading_<kind> ever has to split.
const MAX_PHASE_ITERATIONS = 12;

interface PhaseStepResponse {
  action: 'recall_function' | 'done';
  phase?: string;
  done?: boolean;
  result?: unknown;
  carry?: unknown;
}

export async function processExportProject(job: Job<ExportJobData>) {
  const t0 = Date.now();
  const {
    kind, export_job_id, project_id, format, target_language_code,
    s3_bucket, s3_key, s3_region, credential_secret_prefix,
    suggested_filename, cc_options, user_email, request_id, auth_token,
  } = job.data;

  if (!auth_token) {
    throw new Error('export-project: missing auth_token (job from a stale schema — re-enqueue required)');
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
        fn: 'exportProjectWorkerStep',
        authToken: auth_token,
        payload: {
          export_job_id, project_id, kind, format,
          target_language_code: target_language_code || null,
          s3_bucket, s3_key, s3_region,
          credential_secret_prefix: credential_secret_prefix || '',
          suggested_filename,
          cc_options: cc_options || null,
          user_email, request_id, carry,
        },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
      });

      lastPhase = step.phase;

      await logEvent({
        function_name: 'bullmq:export-project',
        event: 'export_phase_tick',
        context: {
          export_job_id, project_id, kind, format, user_email, request_id,
          attempts: job.attemptsMade + 1,
          iteration: i,
          action: step.action,
          phase: step.phase,
        },
      });

      if (step.action === 'done') {
        await logEvent({
          function_name: 'bullmq:export-project',
          event: 'export_complete',
          duration_ms: Date.now() - t0,
          context: {
            export_job_id, project_id, kind, format,
            user_email, request_id,
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

      throw new Error(`export-project: unknown action: ${String(step.action)}`);
    }

    throw new Error(`export-project: phase machine exceeded ${MAX_PHASE_ITERATIONS} iterations (last phase: ${lastPhase ?? 'none'})`);
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:export-project',
      level: 'error',
      event: 'export_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { export_job_id, project_id, kind, user_email, request_id, attempts: job.attemptsMade + 1 },
    });

    try {
      await invokeBase44Function({
        fn: 'exportProjectWorkerStep',
        authToken: auth_token,
        payload: {
          fail: true,
          export_job_id, project_id, user_email, request_id,
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
