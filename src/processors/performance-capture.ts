// =============================================================================
// PERFORMANCE-CAPTURE PROCESSOR — Synthetic Performance Match capture pipeline.
// -----------------------------------------------------------------------------
// Synthetic Performance Match renders on a clean native v3 Synthesis voice while
// AUTO-CAPTURING the original speaker's delivery (emotion + inline events) and
// writing it as v3-native performance direction + inline cues onto each
// TranslationSegment — zero per-segment hand-annotation.
//
// This processor is the ISOLATED worker lane that drives a PerformanceCaptureRun
// to completion, tick by tick, independent of any browser or function budget —
// the SAME tick-resumable pattern as consensus-transcription / cc-cue-supersede.
//
// The loop calls performanceCaptureWorkerStep, which advances the run one SEGMENT
// per tick (resumable via checkpoint.cursor). That step — running INSIDE Base44
// where GEMINI_API_KEY lives — extracts the segment's ORIGINAL audio clip (Railway
// extractor), calls Gemini audio-native to detect delivery, DROPS every tag below
// its per-kind confidence floor (never hallucinate), and writes the result. Each
// 'continue' re-invokes the step; the loop terminates on 'done' (completed) or
// 'failed'. The step is idempotent per-segment (cursor-guarded), so a pod death
// mid-run resumes the exact segment from the row alone (SOC 2 CC7.2).
//
// AUTH: scoped JWT (30-min TTL) bound to (user, project, capture_run_id,
// 'performanceCaptureWorkerStep'), minted by enqueuePerformanceCapture. Forwarded
// verbatim as X-Worker-JWT on every call.
//
// ZOMBIE-KILL: every worker-step call runs inside runWithLockHeartbeat, so a lost
// BullMQ lock aborts the in-flight invocation instead of stranding a zombie.
//
// IDEMPOTENCY: performanceCaptureWorkerStep short-circuits on a terminal run
// (action='done', already_terminal), so a native BullMQ reclaim re-runs safely.
// =============================================================================

import type { Job } from 'bullmq';
import type { PerformanceCaptureJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat } from '../base44-client.js';

const FUNCTION_CALL_TIMEOUT_MS = 60_000;
// Total wall-clock cap for the whole run's tick loop. Each tick analyzes ONE
// segment (extract clip + one Gemini call ≈ a few seconds), so this covers a
// large program (hundreds of segments) without approaching BullMQ's job ceiling.
const WALL_CLOCK_CAP_MS = 25 * 60 * 1000;

interface CaptureStepResponse {
  action: 'continue' | 'done' | 'failed';
  phase?: string;
  status?: string;
  already_terminal?: boolean;
  cursor?: number;
  total_segments?: number;
  note?: string;
  error?: string;
}

async function _log(
  level: 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown>,
  message?: string,
) {
  const prefix = `[bullmq:performance-capture] ${event}`;
  const line = message ? `${prefix} — ${message} ${JSON.stringify(ctx)}` : `${prefix} ${JSON.stringify(ctx)}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    await logEvent({ function_name: 'bullmq:performance-capture', level, event, message: message || event, context: ctx });
  } catch (logErr) {
    console.error(`[bullmq:performance-capture] logEvent_failed event=${event} reason=${String((logErr as Error)?.message || logErr).slice(0, 200)}`);
  }
}

export async function processPerformanceCapture(job: Job<PerformanceCaptureJobData>) {
  const t0 = Date.now();
  const { project_id, capture_run_id, user_email, request_id, auth_token } = job.data;
  const baseCtx = {
    project_id,
    capture_run_id,
    user_email,
    request_id,
    bullmq_job_id: job.id,
    attempts: job.attemptsMade + 1,
  };

  if (!auth_token) {
    await _log('error', 'capture_missing_auth_token', baseCtx,
      'Job arrived without auth_token — producer schema is stale, re-enqueue required.');
    throw new Error('performance-capture: missing auth_token (job from a stale schema — re-enqueue required)');
  }

  await _log('info', 'capture_started', baseCtx,
    `Worker picked up job ${job.id} for capture_run ${capture_run_id} (attempt ${job.attemptsMade + 1}).`);

  let tickCount = 0;
  let lastStep: CaptureStepResponse | null = null;

  while (true) {
    if (Date.now() - t0 > WALL_CLOCK_CAP_MS) {
      throw new Error(`performance-capture: wall-clock cap ${WALL_CLOCK_CAP_MS}ms exceeded — letting BullMQ retry per policy`);
    }
    tickCount++;
    const tickT0 = Date.now();

    const step = await runWithLockHeartbeat(job, (signal) =>
      invokeBase44Function<CaptureStepResponse>({
        fn: 'performanceCaptureWorkerStep',
        authToken: auth_token,
        payload: { project_id, capture_run_id },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
        signal,
      }),
    );
    lastStep = step;

    await _log('info', 'capture_tick_done', {
      ...baseCtx,
      tick: tickCount,
      tick_ms: Date.now() - tickT0,
      action: step.action,
      phase: step.phase,
      status: step.status,
      cursor: step.cursor,
      total_segments: step.total_segments,
      already_terminal: !!step.already_terminal,
      note: step.note,
    }, `Tick ${tickCount} returned action=${step.action} (cursor=${step.cursor ?? '?'}/${step.total_segments ?? '?'}).`);

    if (step.action === 'failed') {
      // The step already finalized the run as failed before returning; surface
      // the error so BullMQ's retry/DLQ policy applies but the run row is truth.
      await _log('error', 'capture_step_failed', { ...baseCtx, error: step.error }, step.error || 'capture step failed');
      return { ok: false, phase: step.phase || 'failed', error: step.error || 'capture_step_failed', duration_ms: Date.now() - t0 };
    }

    if (step.action !== 'continue') break;
    // Small pause between ticks lets the platform write budget + Gemini rate recover.
    await new Promise((r) => setTimeout(r, 500));
  }

  await _log('info', 'capture_complete', {
    ...baseCtx,
    total_duration_ms: Date.now() - t0,
    tick_count: tickCount,
    final_phase: lastStep?.phase,
    final_status: lastStep?.status,
    note: lastStep?.note,
  }, `Capture job settled (${Date.now() - t0}ms total, phase=${lastStep?.phase ?? '?'}).`);

  return {
    ok: true,
    phase: lastStep?.phase ?? 'done',
    status: lastStep?.status ?? 'unknown',
    tick_count: tickCount,
    duration_ms: Date.now() - t0,
  };
}
