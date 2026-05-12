// =============================================================================
// CC-FORMAT-RUN PROCESSOR — CC Creation rules-engine apply pipeline.
// -----------------------------------------------------------------------------
// Single-shot job. The worker calls ccFormatRunWorkerStep ONCE; the function
// runs the rules engine end-to-end (load cues → engine → persist → finalize)
// inside its function budget. The function reports progress by updating
// CCFormatRun.progress_pct / current_phase before returning so the editor's
// subscription paints live progress.
//
// Pattern: same shape as hls-ingest (single-shot, scoped JWT, heartbeat).
//
// IDEMPOTENCY
//   Re-running this processor on the same job is safe: ccFormatRunWorkerStep
//   short-circuits if CCFormatRun.status is already terminal (returns
//   action='done' with already_terminal=true).
//
// HEARTBEAT
//   The function call can take up to 3 min on a 1,100-cue project (~22s for
//   deletes + ~5s for bulkCreate + engine). Default BullMQ stalled-job
//   detection trips at 30s. We extend the job lock every 15s.
//
// ISOLATED to the CC Creation module.
// =============================================================================

import type { Job } from 'bullmq';
import type { CCFormatRunJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

// The function ceiling on Base44 is 3 min. Give it 5 min of network slack
// for slow cold starts; if the function genuinely hangs longer than that,
// BullMQ retries.
const FUNCTION_CALL_TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 15_000;

interface StepResponse {
  action: 'done';
  phase?: string;
  done?: boolean;
  result?: unknown;
  already_terminal?: boolean;
}

export async function processCCFormatRun(job: Job<CCFormatRunJobData>) {
  const t0 = Date.now();
  const { project_id, format_run_id, user_email, request_id, auth_token } = job.data;

  if (!auth_token) {
    throw new Error('cc-format-run: missing auth_token (job from a stale schema — re-enqueue required)');
  }

  // ─── Heartbeat — keeps job lock alive during the long function call ───
  let heartbeatActive = true;
  const heartbeat = (async () => {
    while (heartbeatActive) {
      await new Promise(r => setTimeout(r, HEARTBEAT_MS));
      if (!heartbeatActive) break;
      try { await job.extendLock(job.token!, 30_000); } catch { /* lock may have already advanced */ }
    }
  })();

  try {
    await logEvent({
      function_name: 'bullmq:cc-format-run',
      event: 'cc_format_run_started',
      context: { project_id, format_run_id, user_email, request_id, attempts: job.attemptsMade + 1 },
    });

    const step = await invokeBase44Function<StepResponse>({
      fn: 'ccFormatRunWorkerStep',
      authToken: auth_token,
      payload: { project_id, format_run_id },
      timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
    });

    if (step.action !== 'done') {
      throw new Error(`cc-format-run: unexpected action from ccFormatRunWorkerStep: ${String(step.action)}`);
    }

    await logEvent({
      function_name: 'bullmq:cc-format-run',
      event: 'cc_format_run_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id, format_run_id, user_email, request_id,
        attempts: job.attemptsMade + 1,
        phase: step.phase,
        already_terminal: !!step.already_terminal,
        result: step.result,
      },
    });

    return step.result ?? { ok: true, phase: step.phase };
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:cc-format-run',
      level: 'error',
      event: 'cc_format_run_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { project_id, format_run_id, user_email, request_id, attempts: job.attemptsMade + 1 },
    });
    throw err; // BullMQ retries per DEFAULT_JOB_OPTIONS (3 attempts → DLQ).
  } finally {
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}
