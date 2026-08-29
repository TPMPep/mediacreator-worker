// =============================================================================
// CONSENSUS-TRANSCRIPTION PROCESSOR — Duo Verification pipeline
// (Universal-3.5 Pro authoritative + Scribe shadow verification).
// -----------------------------------------------------------------------------
// Duo Verification transcribes ONE source with BOTH providers. AssemblyAI 3.5
// is the sole transcript writer; ElevenLabs Scribe v2 is immutable shadow evidence
// used only to flag disagreements. Scribe never changes deliverable words or timing. This processor is the ISOLATED worker lane that drives
// a ConsensusTranscriptionRun to completion, tick by tick, independent of any
// browser or function budget — the same tick-resumable pattern as
// cc-cue-supersede / hls-ingest / gltv-cascade.
//
// Railway owns both provider calls, AAI polling, immutable raw-result archival,
// and dual forced-alignment evidence. Base44 only signs scoped storage access and
// performs the bounded, release-gated database cutover: queued → awaiting_merge →
// acoustic arbitration on the AAI diarization timeline → persisting → done. Each 'continue'
// re-invokes the step; the loop terminates on 'done' (completed) or 'failed'.
// The step is idempotent per-phase (keyed by the run's status), so a pod death
// mid-run resumes the exact phase from the row alone (SOC 2 CC7.2).
//
// PARTIAL-FAILURE POLICY: a Scribe (secondary) failure degrades gracefully to an
// AAI-only transcript (degraded_to_primary_only=true) — never wastes the paid AAI
// leg. An AAI (primary) failure hard-fails (no diarization timeline to merge into).
//
// AUTH: scoped JWT bound to (user, project, consensus_run_id,
// 'consensusTranscriptionWorkerStep'), minted by enqueueConsensusTranscription
// with a 12-HOUR TTL, and re-minted at the same TTL by watchdogConsensusRuns on
// every recovery. Forwarded verbatim as X-Worker-JWT on every call.
//
// THE TTL IS LOAD-BEARING, WHICH IS WHY IT IS STATED ACCURATELY HERE. This header
// previously said 30 minutes. A feature-length AAI leg alone can run 15-20
// minutes, so a reader trusting that number would conclude that long programmes
// must be hitting the JWT-expiry path — which terminalises the run AFTER both
// paid provider legs have been spent, and is not watchdog-recoverable because the
// run is already terminal. That is precisely the failure an auditor would chase,
// and the comment would have sent them at a bound that does not exist.
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
import { invokeBase44Function, logEvent, runWithLockHeartbeat, WorkerLockLostError } from '../base44-client.js';
import { env } from '../env.js';
import { buildConsensusAcousticEvidence } from '../consensus-acoustic-evidence.js';

const FUNCTION_CALL_TIMEOUT_MS = 60_000;
// Total wall-clock cap for the whole run's tick loop. Phase 1 parks after one
// tick, so this is generous headroom for the Phase 2 dual-provider legs (each
// provider transcription of a feature can take several minutes) without
// approaching BullMQ's job ceiling on a pathological input.
const WALL_CLOCK_CAP_MS = 2 * 60 * 60 * 1000;

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
  primary_raw_get_url?: string;
  primary_raw_put_url?: string;
  acoustic_get_url?: string;
  acoustic_put_url?: string;
  primary_model?: string;
  source_language?: string;
}

async function fetchJson(url: string, init: RequestInit = {}, allow404 = false): Promise<any> {
  const response = await fetch(url, init);
  if (allow404 && response.status === 404) return null;
  const text = await response.text();
  if (!response.ok) throw new Error(`provider HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
async function putJson(url: string, value: unknown): Promise<void> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    if (response.ok) return;
    lastStatus = response.status;
    if (response.status < 500 && response.status !== 429) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(8000, 500 * (2 ** attempt))));
  }
  throw new Error(`consensus checkpoint upload failed after bounded retries: HTTP ${lastStatus}`);
}
function assemblyLanguage(raw?: string): string | null {
  if (!raw || raw === 'auto') return null;
  const value = raw.toLowerCase().replace(/_/g, '-');
  const aliases: Record<string, string> = { 'en-us': 'en_us', 'en-gb': 'en_uk', 'en-au': 'en_au', nb: 'no', nn: 'no', no: 'no', he: 'he', iw: 'he' };
  return aliases[value] || value.split('-')[0];
}
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('worker lock lost')); }, { once: true });
  });
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
  const reportExternalProgress = async (signal: AbortSignal, phase: 'dispatch_primary' | 'dispatch_secondary' | 'poll_providers' | 'aligning', progressPct: number) => {
    try {
      await invokeBase44Function({
        fn: 'consensusTranscriptionWorkerStep', authToken: auth_token,
        payload: { project_id, consensus_run_id, operation: 'external_progress', phase, progress_pct: progressPct },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS, signal,
      });
    } catch (error) {
      await _log('warn', 'consensus_progress_heartbeat_failed', { ...baseCtx, phase, progress_pct: progressPct, error: String((error as Error)?.message || error).slice(0, 240) });
    }
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

  // Provider dispatch belongs on Railway. Any terminal provider, archive, or
  // acoustic failure is written back before the job is allowed to retry/DLQ.
  try {
    await runWithLockHeartbeat(job, async (signal) => {
    const prep = await invokeBase44Function<ConsensusStepResponse>({
      fn: 'consensusTranscriptionWorkerStep', authToken: auth_token,
      payload: { project_id, consensus_run_id, operation: 'prepare_external' },
      timeoutMs: FUNCTION_CALL_TIMEOUT_MS, signal,
    });
    if (prep.status === 'failed' || prep.status === 'cancelled') throw new Error(`consensus run is terminal: ${prep.status}`);
    if (!prep.needs_external_dispatch) return;
    if (!env.ASSEMBLYAI_API_KEY) throw new Error('ASSEMBLYAI_API_KEY must be configured in Railway');
    let state = await fetchJson(prep.state_get_url!, {}, true);
    let rawStash = await fetchJson(prep.raw_get_url!, {}, true);
    let aaiJobId = String(state?.aai_job_id || '');
    if (!aaiJobId) {
      if (state?.aai_dispatch_state === 'submitting') throw new Error('AssemblyAI dispatch outcome is uncertain; refusing duplicate provider spend');
      state = { ...(state || {}), aai_dispatch_state: 'submitting', aai_submit_started_at: new Date().toISOString() };
      await putJson(prep.state_put_url!, state);
      const pinnedLanguage = assemblyLanguage(prep.source_language);
      const submitted = await fetchJson('https://api.assemblyai.com/v2/transcript', {
        method: 'POST', headers: { authorization: env.ASSEMBLYAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_url: prep.source_url, speaker_labels: true, speech_models: [prep.primary_model || 'universal-3-5-pro'], punctuate: true, ...(pinnedLanguage ? { language_code: pinnedLanguage } : { language_detection: true }) }),
        signal,
      });
      aaiJobId = String(submitted.id || '');
      if (!aaiJobId) throw new Error(`AssemblyAI returned no transcript id: ${submitted.error || 'unknown error'}`);
      state = { ...(state || {}), aai_job_id: aaiJobId, aai_dispatch_state: 'submitted', submitted_at: new Date().toISOString() };
      await putJson(prep.state_put_url!, state);
    }
    await reportExternalProgress(signal, 'dispatch_secondary', 20);
    let scribeOk = !!rawStash?.raw;
    let scribeProviderId = String(rawStash?.raw?.request_id || '');
    let degradeReason = '';
    if (!scribeOk) {
      try {
        if (state?.scribe_dispatch_state === 'submitting') throw new Error('Scribe dispatch outcome is uncertain; refusing duplicate provider spend');
        if (!env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not configured in Railway');
        state = { ...(state || {}), scribe_dispatch_state: 'submitting', scribe_submit_started_at: new Date().toISOString() };
        await putJson(prep.state_put_url!, state);
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
        state = { ...(state || {}), scribe_dispatch_state: 'completed', scribe_provider_job_id: scribeProviderId, scribe_completed_at: new Date().toISOString() };
        await putJson(prep.state_put_url!, state);
        scribeOk = true;
      } catch (error) {
        degradeReason = `ElevenLabs Scribe leg failed on Railway: ${String((error as Error)?.message || error).slice(0, 240)}`;
      }
    }
    await reportExternalProgress(signal, 'poll_providers', 35);
    let aaiRaw = await fetchJson(prep.primary_raw_get_url!, {}, true);
    const primaryAlreadyArchived = aaiRaw?.status === 'completed';
    while (!aaiRaw || aaiRaw.status !== 'completed') {
      aaiRaw = await fetchJson(`https://api.assemblyai.com/v2/transcript/${aaiJobId}`, { headers: { authorization: env.ASSEMBLYAI_API_KEY }, signal });
      if (aaiRaw.status === 'error') throw new Error(`AssemblyAI transcription failed: ${aaiRaw.error || 'unknown provider error'}`);
      if (aaiRaw.status !== 'completed') await sleep(5000, signal);
    }
    if (!primaryAlreadyArchived) await putJson(prep.primary_raw_put_url!, aaiRaw);
    await reportExternalProgress(signal, 'aligning', 55);

    let acousticVerified = false;
    if (scribeOk) {
      let acousticEvidence = await fetchJson(prep.acoustic_get_url!, {}, true);
      if (!acousticEvidence?.verified) {
        acousticEvidence = await buildConsensusAcousticEvidence({
          requestId: request_id, audioUrl: prep.source_url!, aaiRaw, scribeRaw: rawStash.raw,
          sourceLanguage: aaiRaw.language_code, signal,
          onProgress: async phase => reportExternalProgress(signal, 'aligning', phase === 'primary_aligned' ? 62 : 70),
        });
        await putJson(prep.acoustic_put_url!, acousticEvidence);
      }
      acousticVerified = !!acousticEvidence?.verified;
      if (!acousticVerified) throw new Error('Consensus acoustic verification did not produce verified evidence');
    }
    await invokeBase44Function({
      fn: 'consensusTranscriptionWorkerStep', authToken: auth_token,
      payload: { project_id, consensus_run_id, operation: 'mark_external_dispatched', aai_job_id: aaiJobId, aai_completed: true, acoustic_verified: acousticVerified, scribe_ok: scribeOk, scribe_provider_job_id: scribeProviderId, degrade_reason: degradeReason },
      timeoutMs: FUNCTION_CALL_TIMEOUT_MS, signal,
    });
    });
  } catch (error) {
    if (error instanceof WorkerLockLostError || (error as Error)?.name === 'WorkerLockLostError') throw error;
    const message = String((error as Error)?.message || error).slice(0, 500);
    const transient = /HTTP 429|HTTP 50[234]|timeout|timed out|ECONNRESET|fetch failed|network|aborted/i.test(message);
    const maxAttempts = Number(job.opts.attempts || 1);
    const finalAttempt = job.attemptsMade + 1 >= maxAttempts;
    if (!transient || finalAttempt) {
      await invokeBase44Function({
        fn: 'consensusTranscriptionWorkerStep', authToken: auth_token,
        payload: { project_id, consensus_run_id, operation: 'external_failure', error_message: message },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
      }).catch(() => undefined);
    }
    await _log(finalAttempt || !transient ? 'error' : 'warn', finalAttempt || !transient ? 'consensus_external_phase_failed' : 'consensus_external_phase_retrying', { ...baseCtx, error: message, transient, final_attempt: finalAttempt }, message);
    throw error;
  }

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

    if (step.action === 'failed' || step.status === 'failed' || step.status === 'cancelled') {
      const terminalError = step.error || `consensus run is terminal: ${step.status || step.phase || 'failed'}`;
      await _log('error', 'consensus_step_failed', { ...baseCtx, error: terminalError }, terminalError);
      throw new Error(terminalError);
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
