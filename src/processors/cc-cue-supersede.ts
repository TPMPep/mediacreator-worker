// =============================================================================
// CC-CUE-SUPERSEDE PROCESSOR — Bulk-supersede prior CaptionCue rows and (when
// the run is an initial_apply) hand off to the Railway transcription engine.
// -----------------------------------------------------------------------------
// REPLACES the in-band supersede + Railway POST that previously ran inside
// ccRunTranscription. The producer is now thin (<2s):
//
//   1. Producer (`ccRunTranscription`) creates CCFormatRun + JobRun in
//      status='running' with current_phase='queued', enqueues ONE job to
//      this queue, returns 202 with format_run_id.
//   2. Worker (this processor) calls ccCueSupersedeWorkerStep on Base44.
//      The step paginates ~500 active CaptionCue rows per tick, flips
//      is_active=true → false with bulkUpdate + 429-aware retry, updates
//      CCFormatRun.cue_supersede_progress, and returns:
//        • action='continue' → more cues remain; worker re-enqueues self
//        • action='dispatch_engine' → all cues superseded AND run.needs_engine_dispatch
//          → worker calls ccDispatchToEngine to do the Railway POST
//        • action='done' → terminal success (admin_cleanup / speaker_rename
//          paths that don't dispatch to the engine; CCFormatRun already
//          finalized status='completed' by the step itself)
//   3. After dispatch_engine, the worker exits. ccPollRailwayJobs (every
//      1min) drives the rest of the transcription lifecycle from Railway
//      ack → AAI completion → ccIngestRailwayResult.
//
// Pattern: same shape as load-test-cleanup (paginated tick-resumable) plus
// a single-shot engine-dispatch tail on completion.
//
// IDEMPOTENCY
// Re-running this processor on the same job is safe: ccCueSupersedeWorkerStep
// short-circuits if CCFormatRun.status is already terminal (returns
// action='done' with already_terminal=true).
//
// HEARTBEAT
// Each tick can take up to 22s on the largest fixtures (1500+ active cues
// being superseded under 429 pressure). Default BullMQ stalled-job
// detection trips at 30s. We extend the job lock every 15s during the
// function call.
//
// AUTH MODEL
// Scoped JWT (30-min TTL) bound to (user, project, format_run_id,
// 'ccCueSupersedeWorkerStep'). Worker forwards verbatim as X-Worker-JWT.
// The dispatch tail call (ccDispatchToEngine) uses the SAME JWT — its
// scope `fn` field is verified case-by-case by both target functions.
//
// SOC 2 CC8.1 — every superseded row carries (superseded_by_run_id,
// superseded_at) joining back to the CCFormatRun that obsoleted it; the
// Railway engine job_id is pinned on the run before this worker exits.
// =============================================================================

import type { Job } from 'bullmq';
import type { CCCueSupersedeJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

const FUNCTION_CALL_TIMEOUT_MS = 60_000;     // Per-tick step call.
const DISPATCH_CALL_TIMEOUT_MS = 60_000;     // Engine dispatch (signs S3 URL + Railway POST).
const HEARTBEAT_MS = 15_000;

interface SupersedeStepResponse {
  action: 'continue' | 'dispatch_engine' | 'done';
  phase?: string;
  already_terminal?: boolean;
  superseded_count?: number;
  total_to_supersede?: number;
  result?: unknown;
}

interface DispatchResponse {
  ok: boolean;
  engine_job_id?: string;
  error?: string;
}

async function _log(
  level: 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown>,
  message?: string,
) {
  const prefix = `[bullmq:cc-cue-supersede] ${event}`;
  const line = message ? `${prefix} — ${message} ${JSON.stringify(ctx)}` : `${prefix} ${JSON.stringify(ctx)}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    await logEvent({
      function_name: 'bullmq:cc-cue-supersede',
      level,
      event,
      message: message || event,
      context: ctx,
    });
  } catch (logErr) {
    console.error(`[bullmq:cc-cue-supersede] logEvent_failed event=${event} reason=${String((logErr as Error)?.message || logErr).slice(0, 200)}`);
  }
}

export async function processCCCueSupersede(job: Job<CCCueSupersedeJobData>) {
    const t0 = Date.now();
    const {
      project_id,
      format_run_id,
      job_run_id,
      needs_engine_dispatch,
      user_email,
      request_id,
      auth_token,
    } = job.data;
    const baseCtx = {
      project_id,
      format_run_id,
      job_run_id: job_run_id || null,
      needs_engine_dispatch,
      user_email,
      request_id,
      bullmq_job_id: job.id,
      attempts: job.attemptsMade + 1,
    };

    if (!auth_token) {
      await _log('error', 'cc_cue_supersede_missing_auth_token', baseCtx,
        'Job arrived without auth_token — producer schema is stale, re-enqueue required.');
      throw new Error('cc-cue-supersede: missing auth_token (job from a stale schema — re-enqueue required)');
    }

    await _log('info', 'cc_cue_supersede_started', baseCtx,
      `Worker picked up job ${job.id} for format_run ${format_run_id} (attempt ${job.attemptsMade + 1}).`);

    let heartbeatActive = true;
    let heartbeatTicks = 0;
    const heartbeat = (async () => {
      while (heartbeatActive) {
        await new Promise(r => setTimeout(r, HEARTBEAT_MS));
        if (!heartbeatActive) break;
        try {
          await job.extendLock(job.token!, 30_000);
          heartbeatTicks++;
        } catch (hbErr) {
          console.warn(`[bullmq:cc-cue-supersede] heartbeat_lock_extend_failed job=${job.id} reason=${String((hbErr as Error)?.message || hbErr).slice(0, 200)}`);
        }
      }
    })();

    try {
      // ─── Phase 1: paginated supersede ──────────────────────────────
      // Loop calling ccCueSupersedeWorkerStep until it returns a non-'continue'
      // action. Each call is bounded by its 22s self-budget inside the
      // function; we cap total wall-clock at 25min to ensure we don't
      // run past BullMQ's default 30min job ceiling on a pathological
      // project (1500+ cues × sustained 429 pressure).
      const SUPERSEDE_WALL_CLOCK_CAP_MS = 25 * 60 * 1000;
      let tickCount = 0;
      let lastStep: SupersedeStepResponse | null = null;
      while (true) {
        if (Date.now() - t0 > SUPERSEDE_WALL_CLOCK_CAP_MS) {
          throw new Error(`cc-cue-supersede: wall-clock cap ${SUPERSEDE_WALL_CLOCK_CAP_MS}ms exceeded — letting BullMQ retry per default policy`);
        }
        tickCount++;
        const tickT0 = Date.now();
        await _log('info', 'cc_cue_supersede_tick_start', { ...baseCtx, tick: tickCount }, `Tick ${tickCount} starting.`);

        const step: SupersedeStepResponse = await invokeBase44Function<SupersedeStepResponse>({
          fn: 'ccCueSupersedeWorkerStep',
          authToken: auth_token,
          payload: { project_id, format_run_id, job_run_id: job_run_id || null, needs_engine_dispatch },
          timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
        });
        lastStep = step;
        const tickMs = Date.now() - tickT0;

        await _log('info', 'cc_cue_supersede_tick_done', {
          ...baseCtx,
          tick: tickCount,
          tick_ms: tickMs,
          action: step.action,
          superseded_count: step.superseded_count,
          total_to_supersede: step.total_to_supersede,
          already_terminal: !!step.already_terminal,
        }, `Tick ${tickCount} returned action=${step.action} (${step.superseded_count ?? '?'}/${step.total_to_supersede ?? '?'}).`);

        if (step.action !== 'continue') break;
        // Small pause between ticks lets the platform write budget recover
        // before the next bulkUpdate burst.
        await new Promise(r => setTimeout(r, 500));
      }

      if (!lastStep) throw new Error('cc-cue-supersede: no step response observed');

      // ─── Phase 2: engine dispatch (when applicable) ─────────────────
      if (lastStep.action === 'dispatch_engine') {
        const dispatchT0 = Date.now();
        await _log('info', 'cc_cue_supersede_dispatch_start', baseCtx, 'Supersede complete — invoking ccDispatchToEngine.');

        const dispatch: DispatchResponse = await invokeBase44Function<DispatchResponse>({
          fn: 'ccDispatchToEngine',
          authToken: auth_token,
          payload: { project_id, format_run_id, job_run_id: job_run_id || null },
          timeoutMs: DISPATCH_CALL_TIMEOUT_MS,
        });
        const dispatchMs = Date.now() - dispatchT0;

        if (!dispatch.ok) {
          // ccDispatchToEngine already finalized the run as failed before
          // returning; we just surface the error for BullMQ retry decision.
          await _log('error', 'cc_cue_supersede_dispatch_failed', {
            ...baseCtx,
            dispatch_ms: dispatchMs,
            error: dispatch.error,
          }, `Engine dispatch failed: ${dispatch.error}`);
          // Dispatch failures are TERMINAL (the function already marks the
          // run failed). Returning successfully prevents BullMQ from
          // retrying with the same payload against an already-failed run.
          return {
            ok: false,
            phase: 'dispatching_engine',
            error: dispatch.error || 'engine_dispatch_failed',
            duration_ms: Date.now() - t0,
          };
        }

        await _log('info', 'cc_cue_supersede_complete_with_dispatch', {
          ...baseCtx,
          total_duration_ms: Date.now() - t0,
          dispatch_ms: dispatchMs,
          engine_job_id: dispatch.engine_job_id,
          tick_count: tickCount,
          heartbeat_ticks: heartbeatTicks,
        }, `Supersede + engine dispatch complete (engine_job_id=${dispatch.engine_job_id}).`);

        return {
          ok: true,
          phase: 'dispatched_to_engine',
          engine_job_id: dispatch.engine_job_id,
          tick_count: tickCount,
          duration_ms: Date.now() - t0,
        };
      }

      // ─── Phase 2 (alt): terminal completion (no engine handoff) ─────
      await _log('info', 'cc_cue_supersede_complete', {
        ...baseCtx,
        total_duration_ms: Date.now() - t0,
        tick_count: tickCount,
        heartbeat_ticks: heartbeatTicks,
        already_terminal: !!lastStep.already_terminal,
      }, `Job complete (${Date.now() - t0}ms total).`);

      return lastStep.result ?? { ok: true, phase: 'done', tick_count: tickCount };
    } catch (err) {
      const e = err as Error;
      console.error(`[bullmq:cc-cue-supersede] cc_cue_supersede_failure job=${job.id} format_run=${format_run_id} attempt=${job.attemptsMade + 1} duration_ms=${Date.now() - t0} error_kind=${e.name} message=${String(e.message || '').slice(0, 500)}`);
      if (e.stack) {
        console.error(`[bullmq:cc-cue-supersede] stack: ${e.stack.split('\n').slice(0, 5).join(' | ')}`);
      }
      await _log('error', 'cc_cue_supersede_failed', {
        ...baseCtx,
        total_duration_ms: Date.now() - t0,
        heartbeat_ticks: heartbeatTicks,
        error_kind: e.name,
      }, e.message);
      console.error(`[bullmq:cc-cue-supersede] throwing_to_bullmq job=${job.id} attempt=${job.attemptsMade + 1} — BullMQ will retry or DLQ per default policy.`);
      throw err;
    } finally {
      heartbeatActive = false;
      await heartbeat.catch(() => {});
    }
  }
