// =============================================================================
// EXPORT-PROJECT PROCESSOR — Step-loop messenger for user-triggered exports.
// -----------------------------------------------------------------------------
// AUDITOR FRAMING (SOC 2 CC8.1 / TPN MS-4.x — deliverable chain of custody):
//   This processor has NO Base44 SDK access and NO S3 client. It is a pure
//   step-loop messenger that calls exportProjectWorkerStep in a loop until
//   action='done'. The function does all entity reads + format building +
//   S3 writes inside Base44's 3-min function ceiling per tick.
//
// Pattern: identical to hls-ingest.ts. Idempotent.
// =============================================================================

import type { Job } from 'bullmq';
import type { ExportJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';
import { env } from '../env.js';
// Zero-dependency WebCrypto SigV4 signer (replaces @aws-sdk/@smithy — incident
// 2026-07-07/08). STS session-token aware. See ../s3-signer.ts.
import { presignS3Url, putS3File, putS3Object, storageFromEnv, type StorageHandle } from '../s3-signer.js';
import { createSegmentZipWriter } from '../segment-zip-writer.js';

const FUNCTION_CALL_TIMEOUT_MS = 150_000; // 2.5 min per tick (pagination + build)
const HEARTBEAT_MS = 15_000;
// Phases: queued → loading_<kind> → building → finalize. 4 ticks minimum,
// 12 is generous if loading_<kind> ever has to split. Audio adds
// prepare_audio → (worker render) → finalize_audio, still well under 12.
const MAX_PHASE_ITERATIONS = 12;

// The Railway /mix-final render can take minutes for a feature-length program.
// The worker (unlike a Base44 function tick) has no hard ceiling — it heartbeat-
// extends the BullMQ lock for the duration. 30 min covers the longest expected
// single mix; per-speaker runs N serial calls but each is bounded by this.
const RAILWAY_MIX_TIMEOUT_MS = 30 * 60 * 1000;

interface PhaseStepResponse {
  action: 'recall_function' | 'done' | 'render_audio' | 'burn_subtitles';
  phase?: string;
  done?: boolean;
  result?: unknown;
  carry?: unknown;
  // Present only when action='burn_subtitles' — the signed source video + the
  // signed compiled ASS document the worker hands to Railway /burn-subtitles.
  burn_job?: {
    video_url: string;
    subtitles_url: string;
    source_res: 'original' | 'proxy';
    cue_count: number;
  };
  // Present only when action='render_audio' — the signed clip list + render
  // params the worker needs to call Railway /mix-final and upload to S3.
  audio_job?: {
    mode: 'full_mix' | 'per_speaker' | 'per_segment_zip' | 'video_dub_me' | 'video_mux';
    clips: Array<{ url: string; start_ms: number; speaker_id: string; max_duration_ms?: number | null; playback_rate?: number; overrun_ms?: number; filename?: string; snapshot_id?: string; take_id?: string | null; translation_id?: string }>;
    duration_ms: number;
    me_track_url: string | null;
    loudness_target_lufs: number | null;
    segment_output_format?: 'wav' | 'flac' | 'mp3';
    speaker_labels: Record<string, string>;
    clip_count: number;
    // ── video_mux mode only ──────────────────────────────────────────────
    // The 3-stem mixing-console recipe + the signed source video to mux onto.
    // dub_gain_db is applied UNIFORMLY to every dubbed clip (the "Dubbed"
    // fader); me_gain_db rides the M&E bed; the optional vocals stem carries
    // the "Original Dialogue" fader. The worker renders the mix via /mix-final
    // then muxes via /mux-video — one audio code path, what-you-hear == ships.
    video_url?: string | null;
    vocals_track_url?: string | null;
    dub_gain_db?: number;
    me_gain_db?: number;
    vocals_gain_db?: number | null;
  };
}

// ─── Railway /mix-final caller (worker-side — no function ceiling) ───
// Mirrors functions/buildFinalMix.callMixFinal byte-for-byte on the request
// contract (8ms/12ms asymmetric fades, sample rate, loudness target) so the
// produced WAV is identical to the legacy path. Returns the raw bytes.
async function callMixFinal(opts: {
  railwayUrl: string;
  railwayKey: string;
  clips: Array<{ url: string; start_ms: number; gain_db?: number; max_duration_ms?: number | null; playback_rate?: number }>;
  durationMs: number;
  meTrackUrl?: string | null;
  loudnessTargetLufs?: number | null;
  // ── 3-stem mixing-console params (video_mux) ──
  // meGainDb overrides the default -6 dB M&E bed. vocalsTrackUrl + vocalsGainDb
  // add the original-dialogue stem. When omitted the call behaves exactly as
  // the legacy full_mix / video_dub_me path (M&E at -6, no vocals).
  meGainDb?: number;
  vocalsTrackUrl?: string | null;
  vocalsGainDb?: number | null;
}): Promise<Uint8Array> {
  const base = opts.railwayUrl.replace(/\/+$/, '');
  const meGain = opts.meGainDb != null ? opts.meGainDb : -6;
  const body: Record<string, unknown> = {
    clips: opts.clips,
    duration_ms: opts.durationMs,
    output_format: 'wav',
    sample_rate: 48000,
    fade_in_ms: 8,
    fade_out_ms: 12,
    ...(opts.meTrackUrl ? { me_track: { url: opts.meTrackUrl, gain_db: meGain } } : {}),
    ...(opts.vocalsTrackUrl ? { vocals_track: { url: opts.vocalsTrackUrl, gain_db: opts.vocalsGainDb ?? -18 } } : {}),
    ...(opts.loudnessTargetLufs != null ? { loudness_target_lufs: opts.loudnessTargetLufs } : {}),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RAILWAY_MIX_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/mix-final`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.railwayKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Railway /mix-final failed (${res.status}): ${errText.slice(0, 500)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function transcodeSegment(opts: {
  railwayUrl: string;
  railwayKey: string;
  sourceUrl: string;
  outputFormat: 'wav' | 'flac' | 'mp3';
  loudnessTargetLufs: number | null;
}): Promise<Uint8Array> {
  const base = opts.railwayUrl.replace(/\/+$/, '');
  const filter = opts.loudnessTargetLufs == null ? 'anull' : `loudnorm=I=${opts.loudnessTargetLufs}:TP=-1:LRA=11`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${base}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.railwayKey}` },
      body: JSON.stringify({ source_url: opts.sourceUrl, filters: filter, output_format: opts.outputFormat, delivery_profile: 'segment_export' }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Segment transcode failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// ─── S3 upload (worker-side) ───
// buildWorkerS3 now returns a plain storage handle (STS-aware, no SDK client).
function buildWorkerS3(region: string, credentialSecretPrefix?: string): StorageHandle {
  return storageFromEnv({ region, bucket: '__unused__', prefix: credentialSecretPrefix || '' });
}
async function uploadWav(storage: StorageHandle, bucket: string, key: string, bytes: Uint8Array, filename: string) {
  await putS3Object({ ...storage, bucket }, key, bytes, {
    contentType: 'audio/wav',
    contentDisposition: `attachment; filename="${filename}"`,
  });
}
async function uploadMp4(storage: StorageHandle, bucket: string, key: string, bytes: Uint8Array, filename: string) {
  await putS3Object({ ...storage, bucket }, key, bytes, {
    contentType: 'video/mp4',
    contentDisposition: `attachment; filename="${filename}"`,
  });
}

// ─── Railway /mux-video caller (worker-side — no function ceiling) ───
// Takes a signed source video URL + a signed finished-mix-audio URL and returns
// the muxed MP4 bytes (-c:v copy, audio re-encoded to AAC). The mix audio is
// ALWAYS produced by callMixFinal first, so the audio baked into the MP4 is
// byte-identical to what the audio-only WAV export would produce.
async function callMuxVideo(opts: {
  railwayUrl: string;
  railwayKey: string;
  videoUrl: string;
  audioUrl: string;
}): Promise<Uint8Array> {
  const base = opts.railwayUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RAILWAY_MIX_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/mux-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.railwayKey}` },
      body: JSON.stringify({ video_url: opts.videoUrl, audio_url: opts.audioUrl, output_format: 'mp4', audio_codec: 'aac', audio_bitrate: '256k' }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Railway /mux-video failed (${res.status}): ${errText.slice(0, 500)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// Upload the worker's rendered mix WAV to a stable intermediate S3 key, then
// return a fresh signed GET URL Railway /mux-video can read. The video_mux
// flow renders audio → uploads it → re-signs → mux. We can't pass raw bytes to
// /mux-video (it fetches URLs), so the mix WAV gets a short-lived S3 home.
// 1h expiry preserved — Railway /mux-video needs the full mux window.
async function uploadAndSign(storage: StorageHandle, bucket: string, key: string, bytes: Uint8Array): Promise<string> {
  const scoped: StorageHandle = { ...storage, bucket };
  await putS3Object(scoped, key, bytes, { contentType: 'audio/wav' });
  return presignS3Url({ method: 'GET', storage: scoped, key, expiresIn: 3600 });
}

// ─── Railway /burn-subtitles caller (worker-side — no function ceiling) ───
// Takes a signed source video URL + a signed compiled-ASS URL and returns the
// hardsub MP4 bytes (video RE-ENCODED via the subtitles filter, audio copied).
// This is a minutes-long re-encode on a feature-length program — the worker's
// heartbeat-extended lock (not a function tick) is what makes it viable.
async function callBurnSubtitles(opts: {
  railwayUrl: string;
  railwayKey: string;
  videoUrl: string;
  subtitlesUrl: string;
}): Promise<Uint8Array> {
  const base = opts.railwayUrl.replace(/\/+$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RAILWAY_MIX_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/burn-subtitles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.railwayKey}` },
      body: JSON.stringify({ video_url: opts.videoUrl, subtitles_url: opts.subtitlesUrl, output_format: 'mp4' }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Railway /burn-subtitles failed (${res.status}): ${errText.slice(0, 500)}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function slugifyLabel(s: string) {
  return String(s || 'speaker').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
}

export async function processExportProject(job: Job<ExportJobData>) {
  const t0 = Date.now();
  const {
    kind, export_job_id, project_id, format, target_language_code,
    s3_bucket, s3_key, s3_region, credential_secret_prefix,
    suggested_filename, cc_options, module_options, user_email, request_id, auth_token,
    audio_mode, loudness_target_lufs, mix_recipe, source_res,
    cc_mode, cc_burn_source_res,
  } = job.data as ExportJobData & {
    railway_url?: string; railway_api_key?: string;
  };
  const railwayUrl = (job.data as { railway_url?: string }).railway_url;
  const railwayKey = (job.data as { railway_api_key?: string }).railway_api_key;

  if (!auth_token) {
    throw new Error('export-project: missing auth_token (job from a stale schema — re-enqueue required)');
  }

  // Heartbeat — extends the BullMQ lock AND stamps a liveness beat + coarse
  // render_phase onto the ExportJob row every 15s for the ENTIRE long render.
  // The worker has no SDK, so it calls the exportRenderHeartbeat Base44 fn
  // (scoped by the SAME worker JWT it already holds). currentPhase is advanced
  // at real transitions below (rendering_mix → muxing_video → uploading, etc.)
  // so the editor toast can tell 'working' (fresh beat) from 'stuck' (frozen
  // beat). Best-effort — a heartbeat hiccup NEVER interrupts the render.
  // SOC 2 CC7.2 — the render's liveness is provable from the row, not a client
  // timer that a page refresh would lose.
  let currentPhase: string = 'rendering_mix';
  const postRenderHeartbeat = async () => {
    try {
      const base = (env.BASE44_FUNCTION_URL || '').replace(/\/+$/, '');
      if (!base || !auth_token) return;
      await fetch(`${base}/exportRenderHeartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Worker-JWT': auth_token },
        body: JSON.stringify({ export_job_id, phase: currentPhase }),
      });
    } catch { /* advisory — never fail the render on a heartbeat write */ }
  };
  let heartbeatActive = true;
  const heartbeat = (async () => {
    while (heartbeatActive) {
      await new Promise(r => setTimeout(r, HEARTBEAT_MS));
      if (!heartbeatActive) break;
      try { await job.extendLock(job.token!, 30_000); } catch { /* lock may have advanced */ }
      await postRenderHeartbeat();
    }
  })();

  try {
    let carry: unknown = undefined;
    let lastPhase: string | undefined;

    for (let i = 0; i < MAX_PHASE_ITERATIONS; i++) {
      const step = await invokeBase44Function<PhaseStepResponse>({
        fn: 'exportProjectWorkerStep',
        authToken: auth_token,
        payload: {
          export_job_id, project_id, kind, format,
          target_language_code: target_language_code || null,
          s3_bucket, s3_key, s3_region,
          credential_secret_prefix: credential_secret_prefix || '',
          suggested_filename,
          cc_options: cc_options || null,
          module_options: module_options || null,
          audio_mode: audio_mode || null,
          loudness_target_lufs: loudness_target_lufs ?? null,
          mix_recipe: mix_recipe ?? null,
          source_res: source_res || null,
          cc_mode: cc_mode || null,
          cc_burn_source_res: cc_burn_source_res || null,
          user_email, request_id, carry,
          // Echoed back when the worker calls finalize_audio after rendering.
          audio_result: (carry as { _audio_result?: unknown } | undefined)?._audio_result,
          // Echoed back when the worker calls finalize_burn after hardsub.
          burn_result: (carry as { _burn_result?: unknown } | undefined)?._burn_result,
        },
        timeoutMs: FUNCTION_CALL_TIMEOUT_MS,
      });

      lastPhase = step.phase;

      // ── render_audio: do the long Railway /mix-final call + S3 upload here ──
      // The worker (not the function) owns this because the render can exceed
      // the 150s function-tick ceiling. We heartbeat the BullMQ lock throughout
      // (the heartbeat loop above runs the whole time). After rendering we set
      // carry._audio_result and continue the loop, which re-calls the step at
      // phase='finalize_audio' to record the result onto the ExportJob.
      if (step.action === 'render_audio') {
        const aj = step.audio_job!;
        if (!railwayUrl || !railwayKey) {
          throw new Error('export-project(audio): Railway URL/key not provided in job payload');
        }
        // Final defense-in-depth: even if a stale producer bypassed preflight,
        // the worker refuses any timed clip that would be truncated by Railway.
        const timedOverruns = aj.clips.filter(c => Number(c.overrun_ms || 0) > 80);
        if (timedOverruns.length > 0) {
          throw new Error(`Timed-audio integrity refusal: ${timedOverruns.length} clip(s) exceed their authored window; render not started.`);
        }
        const baseKeyPrefix = `dubflow/exports/${project_id}/${export_job_id}/`;
        const s3 = buildWorkerS3(s3_region, credential_secret_prefix);
        // Entering the Railway /mix-final render — advance the coarse phase +
        // fire an immediate beat so the editor toast flips to "Rendering mix"
        // without waiting for the next 15s tick. SOC 2 CC7.2.
        currentPhase = aj.mode === 'per_segment_zip' ? 'packaging_segments' : 'rendering_mix';
        await postRenderHeartbeat();

        let audioResult: unknown;
        if (aj.mode === 'per_segment_zip') {
          const outputFormat = aj.segment_output_format || 'wav';
          const contentType = outputFormat === 'mp3' ? 'audio/mpeg' : `audio/${outputFormat}`;
          const archive = await createSegmentZipWriter(export_job_id);
          try {
            for (let index = 0; index < aj.clips.length; index++) {
              const clip = aj.clips[index];
              const filename = clip.filename || `${String(index + 1).padStart(4, '0')}_segment.${outputFormat}`;
              const bytes = await transcodeSegment({
                railwayUrl: railwayUrl!, railwayKey: railwayKey!, sourceUrl: clip.url,
                outputFormat, loudnessTargetLufs: aj.loudness_target_lufs,
              });
              const individualKey = `${baseKeyPrefix}segments/${filename}`;
              await putS3Object({ ...s3, bucket: s3_bucket }, individualKey, bytes, {
                contentType, contentDisposition: `attachment; filename="${filename}"`,
              });
              await archive.add(filename, bytes);
            }
            const completedArchive = await archive.close();
            currentPhase = 'uploading';
            await postRenderHeartbeat();
            const key = `${baseKeyPrefix}${suggested_filename}`;
            const uploaded = await putS3File({ ...s3, bucket: s3_bucket }, key, completedArchive.path, {
              contentType: 'application/zip', contentDisposition: `attachment; filename="${suggested_filename}"`, timeoutMs: 30 * 60 * 1000,
            });
            audioResult = { s3_key: key, file_size_bytes: uploaded.size, mime_type: 'application/zip' };
          } finally {
            await archive.cleanup();
          }
        } else if (aj.mode === 'per_speaker') {
          // Group clips by speaker, render one WAV per group (serial — gentle
          // on Railway, matches legacy buildFinalMix per_speaker behavior).
          const groups: Record<string, Array<{ url: string; start_ms: number; max_duration_ms?: number | null; playback_rate?: number }>> = {};
          for (const c of aj.clips) {
            // RENDER PARITY (A′): carry per-clip trim + Speed-to-Fit rate through grouping.
            (groups[c.speaker_id] ||= []).push({ url: c.url, start_ms: c.start_ms, max_duration_ms: c.max_duration_ms, playback_rate: c.playback_rate });
          }
          const speaker_files: Array<Record<string, unknown>> = [];
          for (const spId of Object.keys(groups)) {
            const label = aj.speaker_labels[spId] || spId;
            const bytes = await callMixFinal({
              railwayUrl, railwayKey,
              clips: groups[spId], durationMs: aj.duration_ms,
              loudnessTargetLufs: null, // never normalize stems
            });
            const filename = `${slugifyLabel(label)}_${target_language_code}.wav`;
            const key = `${baseKeyPrefix}${filename}`;
            await uploadWav(s3, s3_bucket, key, bytes, filename);
            speaker_files.push({
              speaker_id: spId, speaker_label: label, s3_key: key, filename,
              file_size_bytes: bytes.length, clip_count: groups[spId].length,
            });
          }
          audioResult = { speaker_files };
        } else if (aj.mode === 'video_mux') {
          // ── 3-stem mix → mux onto video → MP4 ──────────────────────────
          // 1) Render the mix WAV with the operator's fader recipe:
          //    • dub_gain_db applied UNIFORMLY to every dubbed clip
          //    • me_gain_db on the M&E bed
          //    • optional original-dialogue (vocals) stem at vocals_gain_db
          //    • loudnorm as the final stage (absolute delivery loudness)
          const dubGain = aj.dub_gain_db ?? 0;
          const mixBytes = await callMixFinal({
            railwayUrl, railwayKey,
            clips: aj.clips.map(c => ({ url: c.url, start_ms: c.start_ms, gain_db: dubGain, max_duration_ms: c.max_duration_ms, playback_rate: c.playback_rate })),
            durationMs: aj.duration_ms,
            meTrackUrl: aj.me_track_url,
            meGainDb: aj.me_gain_db,
            vocalsTrackUrl: aj.vocals_track_url || null,
            vocalsGainDb: aj.vocals_gain_db ?? null,
            loudnessTargetLufs: aj.loudness_target_lufs,
          });
          // 2) Park the mix WAV in S3 + sign it so /mux-video can fetch it.
          const mixKey = `${baseKeyPrefix}_mix_intermediate.wav`;
          const mixSignedUrl = await uploadAndSign(s3, s3_bucket, mixKey, mixBytes);
          // 3) Mux the mix onto the source video (-c:v copy) → MP4. Advance the
          // phase so the editor toast shows "Muxing video", not a stale "mix".
          currentPhase = 'muxing_video';
          await postRenderHeartbeat();
          if (!aj.video_url) throw new Error('video_mux: no source video URL provided');
          const mp4Bytes = await callMuxVideo({
            railwayUrl, railwayKey, videoUrl: aj.video_url, audioUrl: mixSignedUrl,
          });
          const key = `${baseKeyPrefix}${suggested_filename}`;
          await uploadMp4(s3, s3_bucket, key, mp4Bytes, suggested_filename);
          audioResult = { s3_key: key, file_size_bytes: mp4Bytes.length, mime_type: 'video/mp4' };
        } else {
          const bytes = await callMixFinal({
            railwayUrl, railwayKey,
            clips: aj.clips.map(c => ({ url: c.url, start_ms: c.start_ms, max_duration_ms: c.max_duration_ms, playback_rate: c.playback_rate })),
            durationMs: aj.duration_ms,
            meTrackUrl: aj.me_track_url,
            loudnessTargetLufs: aj.loudness_target_lufs,
          });
          const key = `${baseKeyPrefix}${suggested_filename}`;
          await uploadWav(s3, s3_bucket, key, bytes, suggested_filename);
          audioResult = { s3_key: key, file_size_bytes: bytes.length };
        }

        await logEvent({
          function_name: 'bullmq:export-project',
          event: 'audio_render_complete',
          context: { export_job_id, project_id, audio_mode: aj.mode, clip_count: aj.clip_count, user_email, request_id },
        });

        // Carry the result into the next tick (finalize_audio reads audio_result).
        carry = { ...(step.carry as object), _audio_result: audioResult };
        continue;
      }

      // ── burn_subtitles: do the long Railway /burn-subtitles hardsub here ──
      // Same worker-owned-render pattern as render_audio: the function prepared
      // a signed source video + a signed compiled ASS; the worker calls Railway
      // (which re-encodes the video with the captions baked in — minutes-long),
      // uploads the MP4 to S3, then re-calls the step at phase='finalize_burn'.
      if (step.action === 'burn_subtitles') {
        if (!railwayUrl || !railwayKey) {
          throw new Error('export-project(cc burn_in): Railway URL/key not provided in job payload');
        }
        const bj = step.burn_job!;
        const s3 = buildWorkerS3(s3_region, credential_secret_prefix);
        const key = `dubflow/exports/${project_id}/${export_job_id}/${suggested_filename}`;
        // Hardsub re-encode — advance the phase so the editor toast shows
        // "Burning subtitles" for the whole minutes-long encode. SOC 2 CC7.2.
        currentPhase = 'burning_subtitles';
        await postRenderHeartbeat();
        const mp4Bytes = await callBurnSubtitles({
          railwayUrl, railwayKey, videoUrl: bj.video_url, subtitlesUrl: bj.subtitles_url,
        });
        await uploadMp4(s3, s3_bucket, key, mp4Bytes, suggested_filename);
        await logEvent({
          function_name: 'bullmq:export-project',
          event: 'cc_burn_complete',
          context: { export_job_id, project_id, source_res: bj.source_res, cue_count: bj.cue_count, user_email, request_id },
        });
        carry = {
          ...(step.carry as object),
          _burn_result: { s3_key: key, file_size_bytes: mp4Bytes.length, mime_type: 'video/mp4' },
        };
        continue;
      }

      await logEvent({
        function_name: 'bullmq:export-project',
        event: 'export_phase_tick',
        context: {
          export_job_id, project_id, kind, format, user_email, request_id,
          attempts: job.attemptsMade + 1,
          iteration: i,
          action: step.action,
          phase: step.phase,
        },
      });

      if (step.action === 'done') {
        await logEvent({
          function_name: 'bullmq:export-project',
          event: 'export_complete',
          duration_ms: Date.now() - t0,
          context: {
            export_job_id, project_id, kind, format,
            user_email, request_id,
            attempts: job.attemptsMade + 1,
            iterations: i + 1,
            phase: step.phase,
            result: step.result,
          },
        });
        return step.result ?? { ok: true, phase: step.phase };
      }

      if (step.action === 'recall_function') {
        carry = step.carry;
        continue;
      }

      throw new Error(`export-project: unknown action: ${String(step.action)}`);
    }

    throw new Error(`export-project: phase machine exceeded ${MAX_PHASE_ITERATIONS} iterations (last phase: ${lastPhase ?? 'none'})`);
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:export-project',
      level: 'error',
      event: 'export_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { export_job_id, project_id, kind, user_email, request_id, attempts: job.attemptsMade + 1 },
    });

    try {
      await invokeBase44Function({
        fn: 'exportProjectWorkerStep',
        authToken: auth_token,
        payload: {
          fail: true,
          export_job_id, project_id, user_email, request_id,
          error_message: e.message,
          duration_ms: Date.now() - t0,
        },
        timeoutMs: 30_000,
      });
    } catch { /* nothing to do */ }

    throw err;
  } finally {
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}
