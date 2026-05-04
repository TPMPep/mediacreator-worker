// =============================================================================
// VOICE-GEN PROCESSOR — Generates one dubbed segment via Base44.
// One job per segment so retries are surgical.
// =============================================================================

import type { Job } from 'bullmq';
import type { VoiceGenJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

export async function processVoiceGen(job: Job<VoiceGenJobData>) {
  const t0 = Date.now();
  const { project_id, segment_id, target_language, voice_id, user_email, request_id } = job.data;
  try {
    const result = await invokeBase44Function({
      fn: 'generateOneSegment',
      payload: { project_id, segment_id, target_language, voice_id },
      timeoutMs: 5 * 60 * 1000,
    });
    await logEvent({
      function_name: 'bullmq:voice-gen',
      event: 'voice_generation_complete',
      duration_ms: Date.now() - t0,
      context: { project_id, segment_id, target_language, attempts: job.attemptsMade + 1, request_id, user_email },
    });
    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:voice-gen',
      level: 'error',
      event: 'voice_generation_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { project_id, segment_id, target_language, attempts: job.attemptsMade + 1, request_id, user_email },
    });
    throw err; // let BullMQ retry
  }
}