// =============================================================================
// CONSENSUS-TRANSCRIPTION PROCESSOR — Dual-Model Consensus transcription pipeline
// (Phase 2 — full dual dispatch + word-level arbitration).
// -----------------------------------------------------------------------------
// Consensus mode transcribes ONE source with BOTH providers (AssemblyAI primary
// for diarization + ElevenLabs Scribe v2 secondary for word recovery) and merges
// them at the word level. This processor is the ISOLATED worker lane that drives
// a ConsensusTranscriptionRun to completion, tick by tick, independent of any
// browser or function budget — the same tick-resumable pattern as
// cc-cue-supersede / hls-ingest / gltv-cascade.
//
// The loop calls consensusTranscriptionWorkerStep, which advances the run's phase
// machine: queued → dispatch (submit AAI async + Scribe sync) → poll_providers
// (poll AAI once per tick, ~40s of polling, returns 'continue' until done) →
// awaiting_merge → arbitrating (timing-anchored alignment + confidence
// arbitration on the AAI diarization timeline) → persisting → done. Each 'continue'
// re-invokes the step; the loop terminates on 'done' (completed) or 'failed'.
// The step is idempotent per-phase (keyed by the run's status), so a pod death
// mid-run resumes the exact phase from the row alone (SOC 2 CC7.2).
//
// PARTIAL-FAILURE POLICY: a Scribe (secondary) failure degrades gracefully to an
// AAI-only transcript (degraded_to_primary_only=true) — never wastes the paid AAI
// leg. An AAI (primary) failure hard-fails (no diarization timeline to merge into).
//
// AUTH: scoped JWT (30-min TTL) bound to (user, project, consensus_run_id,
// 'consensusTranscriptionWorkerStep'), minted by enqueueConsensusTranscription.
// Forwarded verbatim as X-Worker-JWT on every call.
//
// ZOMBIE-KILL: every worker-step call runs inside runWithLockHeartbeat, so a
// lost BullMQ lock aborts the in-flight invocation instead of stranding a zombie
// (the shared primitive from base44-client). SOC 2 CC7.2.
//
// IDEMPOTENCY: consensusTranscriptionWorkerStep short-circuits on a terminal run
// (action='done', already_terminal), so a native BullMQ reclaim re-runs safely.
// =============================================================================

import type { Job } from 'bullmq';
import type { ConsensusTranscriptionJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat } from '../base44-client.js';
import { env } from '../env.js';

const FUNCTION_CALL_TIMEOUT_MS = 60_000;
// Total wall-clock cap for the whole run's tick loop. Phase 1 parks after one
// tick, so this is generous headroom for the Phase 2 dual-provider legs (each
// provider transcription of a feature can take several minutes) without
// approaching BullMQ's job ceiling on a pathological input.
const WALL_CLOCK_CAP_MS = 25 * 60 * 1000;

interface ConsensusStepResponse {
  action: 'continue' | 'done' | 'failed';
  phase?: string;
  status?: string;
  already_terminal?: boolean;
  tick_count?: number;
  note?: string;
  error?: string;
  needs_external_dispatch?: boolean;
  source_url?: string;
  state_get_url?: string;
  state_put_url?: string;
  raw_get_url?: string;
  raw_put_url?: string;
}

async function fetchJson(url: string, init: RequestInit = {}, allow404 = false): Promise<any> {
  const response = await fetch(url, init);
  if (allow404 && response.status === 404) return null;
  const text = await response.text();
  if (!response.ok) throw new Error(`provider HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
async function putJson(url: string, value: unknown): Promise<void> {
  const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  if (!response.ok) throw new Error(`consensus checkpoint upload failed: HTTP ${response.status}`);
}

async function _log(
  level: 'info' | 'warn' | 'error',
  event: string,
  ctx: Record<string, unknown>,
  message?: string,
) {
  const prefix = `[bullmq:consensus-transcription] ${event}`;
  const line = message ? `${prefix} — ${message} ${JSON.stringify(ctx)}` : `${prefix} ${JSON.stringify(ctx)}`;
  if (level === 'error') console.error(line);
  else console.log(line);
  try {
    await logEvent({ function_name: 'bullmq:consensus-transcription', level, event, message: message || event, context: ctx });
  } catch (logErr) {
    console.error(`[bullmq:consensus-transcription] logEvent_failed event=${event} reason=${String((logErr as Error)?.message || logErr).slice(0, 200)}`);
  }
}

export async function processConsensusTranscription(job: Job<ConsensusTranscriptionJobData>) {
  const t0 = Date.now();
  const { project_id, consensus_run_id, user_email, request_id, auth_token } = job.data;
  const baseCtx = {
    project_id,
    consensus_run_id,
    user_email,
    request_id,
    bullmq_job_id: job.id,
    attempts: job.attemptsMade + 1,
  };

  if (!auth_token) {
    await _log('error', 'consensus_missing_auth_token', baseCtx,
      'Job arrived without auth_token — producer schema is stale, re-enqueue required.');
    throw new Error('consensus-transcription: missing auth_token (job from a stale schema — re-enqueue required)');
  }

  await _log('info', 'consensus_started', baseCtx,
    `Worker picked up job ${job.id} for consensus_run ${consensus_run_id} (attempt ${job.attemptsMade + 1}).`);

  let tickCount = 0;
  let lastStep: ConsensusStepResponse | null = null;

  // Provider dispatch belongs on Railway. The Base44 step returns only signed
  // source/checkpoint URLs; this worker performs AAI + Scribe I/O and then pins
  // their durable IDs/results before the existing merge phase begins.
  await runWithLockHeartbeat(job, async (signal) => {
    const prep = await invokeBase44Function<ConsensusStepResponse>({
      fn: 'consensusTranscriptionWorkerStep', authToken: auth_token,
      payload: { project_id, consensus_run_id, operation: 'prepare_external' },
      timeoutMs: FUNCTION_CALL_TIMEOUT_MS, signal,
    });
    if (!prep.needs_external_dispatch) return;
    if (!env.ASSEMBLYAI_API_KEY || !env.ELEVENLABS_API_KEY) throw new Error('AAI and Scribe credentials must be configured in Railway');
    let state = await fetchJson(prep.state_get_url!, {}, true).catch(() => null);
    let rawStash = await fetchJson(prep.raw_get_url!, {}, true).catch(() => null);
    let aaiJobId = String(state?.aai_job_id || '');
    if (!aaiJobId) {
      const submitted = await fetchJson('https://api.assemblyai.com/v2/transcript', {
        method: 'POST', headers: { authorization: env.ASSEMBLYAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_url: prep.source_url, speaker_labels: true, speech_models: ['universal-3-5-pro'], punctuate: true, language_detection: true }),
        signal,
      });
      aaiJobId = String(submitted.id || '');
      if (!aaiJobId) throw new Error(`AssemblyAI returned no transcript id: ${submitted.error || 'unknown error'}`);
      state = { aai_job_id: aaiJobId, submitted_at: new Date().toISOString() };
      await putJson(prep.state_put_url!, state);
    }
    let scribeOk = !!rawStash?.raw;
    let scribeProviderId = String(rawStash?.raw?.request_id || '');
    let degradeReason = '';
    if (!scribeOk) {
      try {
        const form = new FormData();
        form.append('model_id', 'scribe_v2');
        form.append('source_url', prep.source_url!);
        form.append('diarize', 'true');
        form.append('tag_audio_events', 'true');
        form.append('timestamps_granularity', 'word');
        const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }, body: form, signal });
        const text = await response.text();
        if (!response.ok) throw new Error(`Scribe HTTP ${response.status}: ${text.slice(0, 300)}`);
        const raw = JSON.parse(text);
        rawStash = { raw };
        scribeProviderId = String(raw.request_id || `scribe_${Date.now()}`);
        await putJson(prep.raw_put_url!, rawStash);
        scribeOk = true;
      } catch (error) {
        degradeReason = `ElevenLabs Scribe leg failed on Railway: ${String((error as Error)?.message || error).slice(0, 240)}`;
      }
    }
    await invokeBase44Function({
      fn: 'consensusTranscriptionWorkerStep', authToken: auth_token,
      payload: { project_id, consensus_run_id, operation: 'mark_external_dispatched', aai_job_id: aaiJobId, scribe_ok: scribeOk, scribe_provider_job_id: scribeProviderId, degrade_reason: degradeReason },
      timeoutMs: FUNCTION_CALL_TIMEOUT_MS, signal,
    });
  });

  while (true) {
    if (Date.now() - t0 > WALL_CLOCK_CAP_MS) {
      throw new Error(`consensus-transcription: wall-clock cap ${WALL_CLOCK_CAP_MS}ms exceeded — letting BullMQ retry per policy`);
    }
    tickCount++;
    const tickT0 = Date.now();
    await _log('info', 'consensus_tick_start', { ...baseCtx, tick: tickCount }, `Tick ${tickCount} starting.`);

    const step = await runWithLockHeartbeat(job, (signal) =>
      invokeBase44Function<ConsensusStepResponse>({
        fn: 'consensusTranscriptionWorkerStep',
        authToken: auth_token,
        payload: { project_id, consensus_run_id },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
        signal,
      }),
    );
    lastStep = step;

    await _log('info', 'consensus_tick_done', {
      ...baseCtx,
      tick: tickCount,
      tick_ms: Date.now() - tickT0,
      action: step.action,
      phase: step.phase,
      status: step.status,
      already_terminal: !!step.already_terminal,
      note: step.note,
    }, `Tick ${tickCount} returned action=${step.action} (phase=${step.phase ?? '?'}).`);

    if (step.action === 'failed') {
      // The step already finalized the run as failed before returning; surface
      // the error so BullMQ's retry/DLQ policy applies but the run row is truth.
      await _log('error', 'consensus_step_failed', { ...baseCtx, error: step.error }, step.error || 'consensus step failed');
      return { ok: false, phase: step.phase || 'failed', error: step.error || 'consensus_step_failed', duration_ms: Date.now() - t0 };
    }

    if (step.action !== 'continue') break;
    // Small pause between ticks lets the platform write budget recover.
    await new Promise((r) => setTimeout(r, 500));
  }

  await _log('info', 'consensus_complete', {
    ...baseCtx,
    total_duration_ms: Date.now() - t0,
    tick_count: tickCount,
    final_phase: lastStep?.phase,
    final_status: lastStep?.status,
    note: lastStep?.note,
  }, `Consensus job settled (${Date.now() - t0}ms total, phase=${lastStep?.phase ?? '?'}).`);

  return {
    ok: true,
    phase: lastStep?.phase ?? 'done',
    status: lastStep?.status ?? 'unknown',
    tick_count: tickCount,
    duration_ms: Date.now() - t0,
  };
}
