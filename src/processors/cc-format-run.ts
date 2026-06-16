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
// Re-running this processor on the same job is safe: ccFormatRunWorkerStep
// short-circuits if CCFormatRun.status is already terminal (returns
// action='done' with already_terminal=true).
//
// HEARTBEAT
// The function call can take up to 3 min on a 1,100-cue project (~22s for
// deletes + ~5s for bulkCreate + engine). Default BullMQ stalled-job
// detection trips at 30s. We extend the job lock every 15s.
//
// INSTRUMENTATION (2026-05-19) — auditor-grade lifecycle telemetry.
// Every phase of the worker-side lifecycle emits BOTH:
//   • A StructuredLog row via logEvent() (Base44-side audit trail).
//   • A console.error/log line (Railway stdout — survives even when the
//     Base44 platform gateway is in a 403/429 storm and logEvent() fails).
// The console.* fallback closes the "silent failure" gap from incident
// 2026-05-19: a worker can complete a full job-failure cycle without ever
// emitting a StructuredLog row if the platform gateway is rejecting writes.
// Railway's log drain captures stdout/stderr unconditionally, so an
// auditor can always reconstruct what happened to a job from the Railway
// log alone.
//
// ISOLATED to the CC Creation module.
// =============================================================================

import type { Job } from 'bullmq';
import type { CCFormatRunJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat, WorkerLockLostError } from '../base44-client.js';

// The function ceiling on Base44 is 3 min. Give it 5 min of network slack
// for slow cold starts; if the function genuinely hangs longer than that,
// BullMQ retries.
const FUNCTION_CALL_TIMEOUT_MS = 5 * 60 * 1000;

interface StepResponse {
  action: 'done';
  phase?: string;
  done?: boolean;
  result?: unknown;
  already_terminal?: boolean;
}

// INSTRUMENTATION (2026-05-19) — dual-channel logger. Writes a Base44
// StructuredLog row AND a Railway stdout/stderr line. The stdout line
// uses a stable prefix so it's grep-able in the Railway log drain.
async function _log(
  level: 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown>,
  message?: string,
) {
  const prefix = `[bullmq:cc-format-run] ${event}`;
  const line = message ? `${prefix} — ${message} ${JSON.stringify(ctx)}` : `${prefix} ${JSON.stringify(ctx)}`;
  // Railway captures stdout/stderr unconditionally — this is the canary log.
  if (level === 'error') console.error(line);
  else console.log(line);
  // Base44 StructuredLog — best-effort, never blocks the hot path.
  try {
    await logEvent({
      function_name: 'bullmq:cc-format-run',
      level,
      event,
      message: message || event,
      context: ctx,
    });
  } catch (logErr) {
    // If logEvent itself fails (gateway 403/429 storm), at least the
    // console line above survives in Railway's log drain.
    console.error(`[bullmq:cc-format-run] logEvent_failed event=${event} reason=${String((logErr as Error)?.message || logErr).slice(0, 200)}`);
  }
}

export async function processCCFormatRun(job: Job<CCFormatRunJobData>) {
  const t0 = Date.now();
  const { project_id, format_run_id, user_email, request_id, auth_token } = job.data;
  const baseCtx = {
    project_id,
    format_run_id,
    user_email,
    request_id,
    bullmq_job_id: job.id,
    attempts: job.attemptsMade + 1,
  };

  if (!auth_token) {
    // Pre-flight failure — no JWT means we can't even call the function.
    // This is a programmer error in the producer, not a transient failure,
    // so we log + throw a non-retryable shape.
    await _log('error', 'cc_format_run_missing_auth_token', baseCtx,
      'Job arrived without auth_token — producer schema is stale, re-enqueue required.');
    throw new Error('cc-format-run: missing auth_token (job from a stale schema — re-enqueue required)');
  }

  // INSTRUMENTATION (2026-05-19) — START lifecycle log.
  await _log('info', 'cc_format_run_started', baseCtx,
    `Worker picked up job ${job.id} for format_run ${format_run_id} (attempt ${job.attemptsMade + 1}).`);

  // ZOMBIE-KILL (2026-06-16): runWithLockHeartbeat owns the lock-renewal loop
  // AND aborts the in-flight Base44 call the instant the BullMQ lock is lost
  // (extendLock throws = reclaim). Replaces the old swallow-the-error heartbeat
  // that let a pod-recycle orphan run as a zombie holding worker concurrency
  // forever. SOC 2 CC7.2.
  try {
    // INSTRUMENTATION (2026-05-19) — function-call START lifecycle log.
    const fnT0 = Date.now();
    await _log('info', 'cc_format_run_function_call_start', {
      ...baseCtx,
      fn: 'ccFormatRunWorkerStep',
      timeout_ms: FUNCTION_CALL_TIMEOUT_MS,
    }, `Invoking ccFormatRunWorkerStep (timeout ${FUNCTION_CALL_TIMEOUT_MS}ms).`);

    // invokeBase44Function has its own AbortController bound to timeoutMs,
    // plus the platform gateway 403/429 internal retry envelope (see
    // base44-client.ts). If the function genuinely hangs past timeoutMs,
    // the fetch aborts and this await rejects — caught below.
    const step: StepResponse = await runWithLockHeartbeat<StepResponse>(job, (signal) =>
      invokeBase44Function<StepResponse>({
        fn: 'ccFormatRunWorkerStep',
        authToken: auth_token,
        payload: { project_id, format_run_id },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
        signal,
      }),
    );

    const fnDurationMs = Date.now() - fnT0;

    // INSTRUMENTATION (2026-05-19) — function-call SUCCESS lifecycle log.
    await _log('info', 'cc_format_run_function_call_success', {
      ...baseCtx,
      fn: 'ccFormatRunWorkerStep',
      function_duration_ms: fnDurationMs,
      action: step.action,
      phase: step.phase,
      already_terminal: !!step.already_terminal,
    }, `Function returned action=${step.action} after ${fnDurationMs}ms.`);

    if (step.action !== 'done') {
      throw new Error(`cc-format-run: unexpected action from ccFormatRunWorkerStep: ${String(step.action)}`);
    }

    // INSTRUMENTATION (2026-05-19) — COMPLETE lifecycle log (terminal success).
    await _log('info', 'cc_format_run_complete', {
      ...baseCtx,
      total_duration_ms: Date.now() - t0,
      function_duration_ms: fnDurationMs,
      phase: step.phase,
      already_terminal: !!step.already_terminal,
      result: step.result,
    }, `Job complete (${Date.now() - t0}ms total).`);

    return step.result ?? { ok: true, phase: step.phase };
  } catch (err) {
    const e = err as Error;
    // Capture name/stack BEFORE the instanceof narrowing below. TS narrows `e`
    // to `never` in the false-branch of a ternary keyed on `instanceof` a
    // subclass that adds no members (WorkerLockLostError), so reading e.name
    // inside such a ternary errors (TS2339). Reading it here keeps it a string.
    const errName = e.name;
    const errStack = e.stack;
    const errMessage = e.message;
    // WorkerLockLostError = clean reclaim exit (the heartbeat aborted us because
    // BullMQ took the job), NOT a real failure. Log warn + re-throw so the SINGLE
    // BullMQ reclaim owns the re-run — ccFormatRunWorkerStep short-circuits on a
    // terminal CCFormatRun, so the reclaim re-runs safely. SOC 2 CC7.2.
    const lockLost = e instanceof WorkerLockLostError;
    // INSTRUMENTATION (2026-05-19) — function-call FAILURE lifecycle log.
    // First channel: console.error (Railway-guaranteed evidence trail).
    console.error(`[bullmq:cc-format-run] cc_format_run_function_call_failure job=${job.id} format_run=${format_run_id} attempt=${job.attemptsMade + 1} duration_ms=${Date.now() - t0} error_kind=${lockLost ? 'lock_lost' : errName} message=${String(errMessage || '').slice(0, 500)}`);
    if (errStack && !lockLost) {
      console.error(`[bullmq:cc-format-run] stack: ${errStack.split('\n').slice(0, 5).join(' | ')}`);
    }
    // Second channel: StructuredLog (best-effort — may itself fail under
    // gateway storm, which is exactly why the console.error above exists).
    await _log(lockLost ? 'warn' : 'error', lockLost ? 'cc_format_run_lock_lost' : 'cc_format_run_failed', {
      ...baseCtx,
      total_duration_ms: Date.now() - t0,
      error_kind: lockLost ? 'lock_lost' : errName,
    }, errMessage);
    // INSTRUMENTATION (2026-05-19) — explicit THROW lifecycle log so the
    // BullMQ retry decision is auditable. We re-throw to let BullMQ apply
    // its DEFAULT_JOB_OPTIONS retry policy (3 attempts → DLQ).
    console.error(`[bullmq:cc-format-run] cc_format_run_throwing_to_bullmq job=${job.id} attempt=${job.attemptsMade + 1}/3 — BullMQ will retry or DLQ per default policy.`);
    throw err;
  }
}
