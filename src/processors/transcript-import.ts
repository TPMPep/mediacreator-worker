// =============================================================================
// TRANSCRIPT-IMPORT PROCESSOR — AI-Dubbing transcript REPLACE stage-then-flip.
// =============================================================================
// REPLACES the in-band destructive replace that previously ran inside
// importTranscript. On a 400+ row TTML the synchronous path paginated +
// deleted every TranscriptSegment / TranslationSegment / Speaker then
// bulk-created the new segments in-band, blowing past the gateway timeout
// and stranding the project mid-destruction (incident 2026-06-09).
//
// STAGE-THEN-FLIP (the explicit "old transcript stays visible until
// the replacement is staged" requirement): this queue is single-shot per
// TranscriptImportRun and the worker step is tick-resumable. Each tick:
//   • Phase 'staging_new': bulk-create up to ~150 NEW TranscriptSegment
//     rows as is_active=false (tagged import_run_id) from the frozen
//     parsed-segments snapshot in S3. Resumes from checkpoint.stage_cursor.
//     Old rows stay is_active=true and fully visible in the editor —
//     there is NEVER an empty-transcript window.
//   • Phase 'cutover': flip THIS run's staged rows is_active=false→true
//     AND supersede the old TranscriptSegment / TranslationSegment /
//     Speaker rows (is_active=true→false + superseded_by_run_id +
//     superseded_at). The editor's is_active read flips old→new with
//     no observable gap.
//   • Phase 'finalizing': update Project status/workflow/counters,
//     write ActivityLog, mark run completed.
//
// Pattern: identical to cc-cue-supersede (paginated tick-resumable).
//
// IDEMPOTENCY
// Re-running on the same job is safe: transcriptImportWorkerStep
// short-circuits if TranscriptImportRun.status is already terminal.
//
// HEARTBEAT
// Each tick can take up to 22s on large fixtures under 429 pressure.
// We extend the job lock every 15s during the function call.
//
// AUTH MODEL
// Scoped JWT (30-min TTL) bound to (user, project, transcript_import_run_id,
// 'transcriptImportWorkerStep'). Worker forwards verbatim as X-Worker-JWT.
//
// SOC 2 CC8.1 — every superseded row carries (superseded_by_run_id,
// superseded_at) joining back to the TranscriptImportRun that obsoleted it.
// =============================================================================

import type { Job } from 'bullmq';
import type { TranscriptImportJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat, WorkerLockLostError } from '../base44-client.js';

const FUNCTION_CALL_TIMEOUT_MS = 60_000;

interface ImportStepResponse {
  action: 'continue' | 'done';
  phase?: string;
  already_terminal?: boolean;
  staged_count?: number;
  total_to_stage?: number;
  result?: unknown;
}

async function _log(
  level: 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown>,
  message?: string,
) {
  const prefix = `[bullmq:transcript-import] ${event}`;
  const line = message ? `${prefix} — ${message} ${JSON.stringify(ctx)}` : `${prefix} ${JSON.stringify(ctx)}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    await logEvent({
      function_name: 'bullmq:transcript-import',
      level,
      event,
      message: message || event,
      context: ctx,
    });
  } catch (logErr) {
    console.error(`[bullmq:transcript-import] logEvent_failed event=${event} reason=${String((logErr as Error)?.message || logErr).slice(0, 200)}`);
  }
}

export async function processTranscriptImport(job: Job<TranscriptImportJobData>) {
  const t0 = Date.now();
  const {
    project_id,
    transcript_import_run_id,
    user_email,
    request_id,
    auth_token,
  } = job.data;
  const baseCtx = {
    project_id,
    transcript_import_run_id,
    user_email,
    request_id,
    bullmq_job_id: job.id,
    attempts: job.attemptsMade + 1,
  };

  if (!auth_token) {
    await _log('error', 'transcript_import_missing_auth_token', baseCtx,
      'Job arrived without auth_token — producer schema is stale, re-enqueue required.');
    throw new Error('transcript-import: missing auth_token (job from a stale schema — re-enqueue required)');
  }

  await _log('info', 'transcript_import_started', baseCtx,
    `Worker picked up job ${job.id} for transcript_import_run ${transcript_import_run_id} (attempt ${job.attemptsMade + 1}).`);

  // ZOMBIE-KILL (2026-06-16): runWithLockHeartbeat owns the lock-renewal loop
  // AND aborts the in-flight Base44 call the instant the BullMQ lock is lost
  // (extendLock throws = reclaim). Replaces the old swallow-the-error heartbeat
  // that let a pod-recycle orphan run as a zombie holding worker concurrency
  // forever. Each invokeBase44 call below runs inside this wrapper via the
  // passed `signal`. SOC 2 CC7.2.
  try {
    // ─── Paginated stage-then-flip lifecycle ──────────────────────────
    // Loop calling transcriptImportWorkerStep until it returns
    // action='done'. Each call is bounded by its 22s self-budget inside
    // the function; we cap total wall-clock at 25min to ensure we don't
    // run past BullMQ's default 30min job ceiling on a pathological
    // 5000+ line replace.
    const REPLACE_WALL_CLOCK_CAP_MS = 25 * 60 * 1000;
    let tickCount = 0;
    let lastStep: ImportStepResponse | null = null;
    while (true) {
      if (Date.now() - t0 > REPLACE_WALL_CLOCK_CAP_MS) {
        throw new Error(`transcript-import: wall-clock cap ${REPLACE_WALL_CLOCK_CAP_MS}ms exceeded — letting BullMQ retry per default policy`);
      }
      tickCount++;
      const tickT0 = Date.now();
      await _log('info', 'transcript_import_tick_start', { ...baseCtx, tick: tickCount }, `Tick ${tickCount} starting.`);

      const step: ImportStepResponse = await runWithLockHeartbeat<ImportStepResponse>(job, (signal) =>
        invokeBase44Function<ImportStepResponse>({
          fn: 'transcriptImportWorkerStep',
          authToken: auth_token,
          payload: { project_id, transcript_import_run_id },
          timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
          signal,
        }),
      );
      lastStep = step;
      const tickMs = Date.now() - tickT0;

      await _log('info', 'transcript_import_tick_done', {
        ...baseCtx,
        tick: tickCount,
        tick_ms: tickMs,
        action: step.action,
        phase: step.phase,
        staged_count: step.staged_count,
        total_to_stage: step.total_to_stage,
        already_terminal: !!step.already_terminal,
      }, `Tick ${tickCount} returned action=${step.action} phase=${step.phase} (${step.staged_count ?? '?'}/${step.total_to_stage ?? '?'}).`);

      if (step.action !== 'continue') break;
      // Small pause between ticks lets the platform write budget recover.
      await new Promise(r => setTimeout(r, 500));
    }

    if (!lastStep) throw new Error('transcript-import: no step response observed');

    // ─── Completion ──────────────────────────────────────────────────
    await _log('info', 'transcript_import_complete', {
      ...baseCtx,
      total_duration_ms: Date.now() - t0,
      tick_count: tickCount,
      already_terminal: !!lastStep.already_terminal,
    }, `Job complete — stage-then-flip finished (${Date.now() - t0}ms total).`);

    return lastStep.result ?? { ok: true, phase: 'done', tick_count: tickCount };
  } catch (err) {
    const e = err as Error;
    // WorkerLockLostError = clean reclaim exit (the heartbeat aborted us because
    // BullMQ took the job), NOT a real failure. Log warn + re-throw so the SINGLE
    // BullMQ reclaim owns the re-run — transcriptImportWorkerStep is idempotent +
    // resumable (short-circuits on terminal run, resumes from checkpoint cursor),
    // so the reclaim re-runs safely. SOC 2 CC7.2.
    const lockLost = e instanceof WorkerLockLostError;
    console.error(`[bullmq:transcript-import] transcript_import_failure job=${job.id} run=${transcript_import_run_id} attempt=${job.attemptsMade + 1} duration_ms=${Date.now() - t0} error_kind=${lockLost ? 'lock_lost' : e.name} message=${String(e.message || '').slice(0, 500)}`);
    if (e.stack && !lockLost) {
      console.error(`[bullmq:transcript-import] stack: ${e.stack.split('\n').slice(0, 5).join(' | ')}`);
    }
    await _log(lockLost ? 'warn' : 'error', lockLost ? 'transcript_import_lock_lost' : 'transcript_import_failed', {
      ...baseCtx,
      total_duration_ms: Date.now() - t0,
      error_kind: lockLost ? 'lock_lost' : e.name,
    }, e.message);
    console.error(`[bullmq:transcript-import] throwing_to_bullmq job=${job.id} attempt=${job.attemptsMade + 1} — BullMQ will retry or DLQ per default policy.`);
    throw err;
  }
}
