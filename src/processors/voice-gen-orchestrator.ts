// =============================================================================
// VOICE-GEN ORCHESTRATOR PROCESSOR — Tick engine for the producer/orchestrator
// /per-segment fan-out pipeline (2026-05-18).
// -----------------------------------------------------------------------------
// One job per VOICE-GEN RUN (not per segment). Calls Base44's
// orchestrateVoiceGenerationRun function for each tick; that function:
//   • Reads inlined_plan + state from job.data (no Base44 read race)
//   • Dispatches up to VOICE_GEN_DISPATCH_PER_TICK voice-gen jobs per tick
//   • Returns next-tick state OR exits when all segments dispatched
//
// The voice-gen workers themselves are UNCHANGED — they still process one
// segment per job via processVoiceGen. This orchestrator only handles the
// FAN-OUT phase, which previously ran synchronously inside runVoiceGeneration
// and risked timing out on 5000+ segment films at the 180s function ceiling.
//
// Pattern mirrors processTranslateOrchestrator / processAIRewriteOrchestrator.
// =============================================================================

import type { Job } from 'bullmq';
import type { VoiceGenOrchestratorJobData } from '../../shared/queue-contracts.js';
import { QUEUE_NAMES, ORCHESTRATOR_JOB_OPTIONS } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';
import { Queue } from 'bullmq';
import { getRedis } from '../redis.js';

interface OrchestratorTickResult {
  ok: boolean;
  finalized?: boolean;
  next_tick?: boolean;
  next_tick_delay_ms?: number;
  next_state?: VoiceGenOrchestratorJobData['state'];
  dispatch_cursor?: number;
  chunk_total?: number;
  dispatched_this_tick?: number;
  tick_ms?: number;
}

let _selfQueue: Queue | null = null;
function getSelfQueue(): Queue {
  if (!_selfQueue) {
    _selfQueue = new Queue(QUEUE_NAMES.VOICE_GEN_ORCHESTRATOR, { connection: getRedis() });
  }
  return _selfQueue;
}

export async function processVoiceGenOrchestrator(job: Job<VoiceGenOrchestratorJobData>) {
  const t0 = Date.now();
  const { project_id, job_run_id, user_email, request_id, auth_token } = job.data;

  if (!auth_token) throw new Error('voice-gen-orchestrator: missing auth_token');

  // Heartbeat — extend lock during the (potentially) long tick.
  let heartbeatActive = true;
  const heartbeat = setInterval(() => {
    if (!heartbeatActive) return;
    job.extendLock(job.token || '', 60_000).catch(() => {});
  }, 15_000);

  try {
    const result = await invokeBase44Function<OrchestratorTickResult>({
      fn: 'orchestrateVoiceGenerationRun',
      authToken: auth_token,
      payload: {
        project_id,
        job_run_id,
        request_id,
        user_email,
        inlined_plan: job.data.inlined_plan,
        state: job.data.state,
      },
      timeoutMs: 90 * 1000, // 90s ceiling — tick budget is 45s, this is safety net
    });

    await logEvent({
      function_name: 'bullmq:voice-gen-orchestrator',
      event: 'tick_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id,
        job_run_id,
        tick_count: job.data.state?.tick_count || 0,
        dispatch_cursor: result.dispatch_cursor,
        chunk_total: result.chunk_total,
        dispatched_this_tick: result.dispatched_this_tick,
        finalized: !!result.finalized,
        next_tick: !!result.next_tick,
      },
    });

    // Self re-enqueue for next tick when more segments remain.
    if (result.next_tick && result.next_state) {
      const q = getSelfQueue();
      await q.add(
        QUEUE_NAMES.VOICE_GEN_ORCHESTRATOR,
        {
          schema_version: job.data.schema_version,
          project_id,
          job_run_id,
          user_email,
          request_id,
          auth_token,
          inlined_plan: job.data.inlined_plan,
          state: result.next_state,
        },
        {
          ...ORCHESTRATOR_JOB_OPTIONS,
          delay: result.next_tick_delay_ms ?? 500,
        },
      );
    }

    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:voice-gen-orchestrator',
      level: 'error',
      event: 'tick_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { project_id, job_run_id, attempts: job.attemptsMade + 1, request_id, user_email },
    });
    throw err;
  } finally {
    heartbeatActive = false;
    clearInterval(heartbeat);
  }
}
