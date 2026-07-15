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
    // Server-authoritative audit trigger from the producer. Forwarded verbatim;
    // generateOneSegment validates + trust-gates it (worker-JWT only, enum only).
    trigger,
    // Force overwrite — when the producer set this (operator explicitly asked
    // to re-render: performance direction, voice change, manual regenerate),
    // forward it so generateOneSegment bypasses its already-ready idempotency
    // guard. Omitted/false for fresh dubs. SOC 2 CC8.1.
    force,
    // Phase 3 Voice Consistency Engine: optional, additive, never throws.
    // When omitted the producer didn't request a consistency posture and
    // generateOneSegment will default to 'NONE' — bit-for-bit identical to
    // pre-Phase-3 behavior. Set only when the user opted into the per-segment
    // "Match surrounding voice" toggle (or project default flips it on).
    consistency_strategy,
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
        // Server-authoritative audit trigger — forwarded verbatim. generateOneSegment
        // honors it ONLY over the worker-JWT chain from the validated enum, so the
        // browser can never influence the audit classification. Undefined for legacy
        // producers → generateOneSegment classifies from server-side signals.
        trigger: trigger ?? undefined,
        // Bypass generateOneSegment's already-ready idempotency guard when the
        // operator explicitly requested a re-render. Defaults false for fresh dubs.
        force: !!force,
        // Phase 3 Voice Consistency Engine. Forwarded verbatim. Undefined
        // when the producer didn't set it (the common case — manual segment
        // regen with the toggle OFF, and ALL bulk runs).
        consistency_strategy: consistency_strategy ?? undefined,
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
