// =============================================================================
// SRT-TRANSLATE PROCESSOR — Simple Translation module async translate.
// -----------------------------------------------------------------------------
// FULLY ISOLATED to the Translation module (project_type='simple_translation' +
// TranslationCue + SimpleTranslationRun). Never shares state, queue, or
// concurrency lane with the AI-Dubbing translate pipeline.
//
// PIPELINE:
//   1. Producer (Base44 fn `translateSrtProject` mode='translate') resets every
//      cue to 'pending', creates a SimpleTranslationRun, mints a scoped JWT,
//      enqueues ONE job to this queue, returns 202 with { run_id }.
//   2. Worker (this processor) calls `srtTranslateWorkerStep` on Base44 in a
//      LOOP. Each tick translates a bounded batch (~120 cues) in parallel via
//      the run's pinned provider and writes the results back inside its own
//      ~22s budget, then returns:
//        • action='continue' → more cues remain; this processor calls again
//        • action='done'     → all cues processed; SimpleTranslationRun finalized
//   3. watchdogSimpleTranslationRuns (every 2 min) re-enqueues a stalled run.
//
// WHY A LOOP HERE (not re-enqueue per tick): the ticks are cheap and back-to-
// back (a batch of provider calls + bounded write-back), so looping inside one
// job avoids per-tick Redis round-trips. The wall-clock cap below bounds the job
// so a pathological run (3000 cues × slow LLM) can't run past BullMQ's job
// ceiling — it exits and the watchdog/native-reclaim resumes from the cursor.
//
// IDEMPOTENCY: srtTranslateWorkerStep short-circuits on a terminal
// SimpleTranslationRun (returns action='done', already_terminal) and only
// translates 'pending' cues past checkpoint.cursor, so a reclaimed/retried job
// re-runs safely exactly where it left off.
//
// ZOMBIE-KILL: every Base44 call runs inside runWithLockHeartbeat — the instant
// the BullMQ lock is lost (reclaim), the in-flight invocation is aborted so no
// zombie runs parallel to the reclaim. Mirrors cc-cue-supersede / gltv-cascade.
//
// AUTH: scoped JWT (30-min TTL) bound to (user, project, run_id,
// 'srtTranslateWorkerStep'). Worker forwards verbatim as X-Worker-JWT.
//
// SOC 2 CC7.2 — resumable; CC8.1 — provider + per-cue provenance join back to
// the SimpleTranslationRun.
// =============================================================================

import type { Job } from 'bullmq';
import type { SrtTranslateJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat, WorkerLockLostError } from '../base44-client.js';

const FUNCTION_CALL_TIMEOUT_MS = 60_000;        // Per-tick step call.
// Bound the whole job so a pathological run can't run past BullMQ's job ceiling.
// On exit (cap reached) the watchdog / native-reclaim resumes from the cursor.
const JOB_WALL_CLOCK_CAP_MS = 25 * 60 * 1000;   // 25 min
const MAX_TICKS = 400;                          // hard loop guard (3000 cues ≈ 25 ticks)

interface StepResponse {
  action: 'continue' | 'done';
  already_terminal?: boolean;
  status?: string;
  processed_count?: number;
  total_count?: number;
  translated_count?: number;
  failed_count?: number;
  reason?: string;
}

async function _log(
  level: 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown>,
  message?: string,
) {
  const prefix = `[bullmq:srt-translate] ${event}`;
  const line = message ? `${prefix} — ${message} ${JSON.stringify(ctx)}` : `${prefix} ${JSON.stringify(ctx)}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    await logEvent({ function_name: 'bullmq:srt-translate', level, event, message: message || event, context: ctx });
  } catch (logErr) {
    console.error(`[bullmq:srt-translate] logEvent_failed event=${event} reason=${String((logErr as Error)?.message || logErr).slice(0, 200)}`);
  }
}

export async function processSrtTranslate(job: Job<SrtTranslateJobData>) {
  const t0 = Date.now();
  const { project_id, run_id, user_email, request_id, auth_token } = job.data;
  const baseCtx = {
    project_id,
    run_id,
    user_email,
    request_id,
    bullmq_job_id: job.id,
    attempts: job.attemptsMade + 1,
  };

  if (!auth_token) {
    await _log('error', 'srt_translate_missing_auth_token', baseCtx,
      'Job arrived without auth_token — producer schema is stale, re-enqueue required.');
    throw new Error('srt-translate: missing auth_token (job from a stale schema — re-enqueue required)');
  }

  await _log('info', 'srt_translate_started', baseCtx,
    `Worker picked up job ${job.id} for run ${run_id} (attempt ${job.attemptsMade + 1}).`);

  try {
    let tick = 0;
    let last: StepResponse | null = null;
    while (true) {
      if (Date.now() - t0 > JOB_WALL_CLOCK_CAP_MS) {
        await _log('warn', 'srt_translate_wall_clock_cap', { ...baseCtx, tick, elapsed_ms: Date.now() - t0 },
          'Job wall-clock cap reached — exiting; watchdog/native-reclaim resumes from cursor.');
        // Throw so BullMQ retries (idempotent — cursor + pending-only resume).
        throw new Error(`srt-translate: wall-clock cap ${JOB_WALL_CLOCK_CAP_MS}ms exceeded — letting BullMQ retry from cursor`);
      }
      if (tick >= MAX_TICKS) {
        throw new Error(`srt-translate: MAX_TICKS (${MAX_TICKS}) exceeded — letting BullMQ retry from cursor`);
      }
      tick++;
      const tickT0 = Date.now();

      const step: StepResponse = await runWithLockHeartbeat(job, (signal) =>
        invokeBase44Function<StepResponse>({
          fn: 'srtTranslateWorkerStep',
          authToken: auth_token,
          payload: { project_id, run_id },
          timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
          signal,
        }),
      );
      last = step;

      await _log('info', 'srt_translate_tick_done', {
        ...baseCtx,
        tick,
        tick_ms: Date.now() - tickT0,
        action: step.action,
        processed_count: step.processed_count,
        total_count: step.total_count,
        already_terminal: !!step.already_terminal,
      }, `Tick ${tick} returned action=${step.action} (${step.processed_count ?? '?'}/${step.total_count ?? '?'}).`);

      if (step.action !== 'continue') break;
      // Small pause between ticks lets the per-app write budget recover before
      // the next batch's write-back burst.
      await new Promise((r) => setTimeout(r, 300));
    }

    await _log('info', 'srt_translate_complete', {
      ...baseCtx,
      total_duration_ms: Date.now() - t0,
      tick_count: tick,
      status: last?.status,
      translated_count: last?.translated_count,
      failed_count: last?.failed_count,
    }, `Run complete (${Date.now() - t0}ms total, status=${last?.status}).`);

    return {
      ok: true,
      run_id,
      status: last?.status ?? 'done',
      tick_count: tick,
      translated_count: last?.translated_count ?? null,
      failed_count: last?.failed_count ?? null,
      duration_ms: Date.now() - t0,
    };
  } catch (err) {
    // Lock-loss is a benign reclaim — re-throw so BullMQ's single reclaim owns
    // the re-run; the resume is idempotent (cursor + pending-only).
    if (err instanceof WorkerLockLostError) {
      await _log('warn', 'srt_translate_lock_lost', { ...baseCtx, total_duration_ms: Date.now() - t0 },
        'Lock lost — BullMQ reclaim will resume from cursor.');
      throw err;
    }
    const e = err as Error;
    console.error(`[bullmq:srt-translate] srt_translate_failure job=${job.id} run=${run_id} attempt=${job.attemptsMade + 1} duration_ms=${Date.now() - t0} error_kind=${e.name} message=${String(e.message || '').slice(0, 500)}`);
    await _log('error', 'srt_translate_failed', {
      ...baseCtx,
      total_duration_ms: Date.now() - t0,
      error_kind: e.name,
    }, e.message);
    // Throw to BullMQ — retries are idempotent (cursor + pending-only resume).
    throw err;
  }
}
