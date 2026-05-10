// =============================================================================
// VOICE-GEN PROCESSOR — Generates one dubbed segment via Base44.
// One job per segment so retries are surgical.
// =============================================================================

import type { Job } from 'bullmq';
import type { VoiceGenJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

export async function processVoiceGen(job: Job<VoiceGenJobData>) {
  const t0 = Date.now();
  const {
    project_id, segment_id, target_language, voice_id,
    voice_settings, voice_mode, is_cloned,
    previous_text, next_text, segment_duration_ms,
    performance_prompt, cue_stability,
    user_email, request_id, auth_token,
    job_run_id,
  } = job.data;
  try {
    if (!auth_token) {
      // Fail fast: jobs without a scoped JWT cannot be processed under the
      // current security model. (Old jobs from the legacy shared-token era
      // would land here — they should be re-enqueued by the producer.)
      throw new Error('voice-gen: missing auth_token (re-enqueue required)');
    }
    // generateOneSegment expects translation_id + target_language_code (not
    // segment_id + target_language). Map field names here so the queue
    // contract can stay stable while the function signature is unchanged.
    // The auth_token is forwarded as X-Worker-JWT — it's scoped to (user,
    // project_id, segment_id, 'generateOneSegment') and expires in 15 min.
    const result = await invokeBase44Function({
      fn: 'generateOneSegment',
      authToken: auth_token,
      payload: {
        project_id,
        translation_id: segment_id,
        target_language_code: target_language,
        voice_id,
        voice_settings: voice_settings || {},
        voice_mode: voice_mode || 'synthesis',
        is_cloned: !!is_cloned,
        previous_text: previous_text ?? null,
        next_text: next_text ?? null,
        segment_duration_ms: segment_duration_ms ?? 0,
        performance_prompt: performance_prompt ?? null,
        cue_stability: cue_stability ?? null,
        // Parent JobRun id — generateOneSegment ticks completion at the end
        // when all segments in the run reach a terminal state. Closes the
        // SOC 2 CC7.2 zombie-JobRun gap.
        job_run_id: job_run_id ?? null,
      },
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
