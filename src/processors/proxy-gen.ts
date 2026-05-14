// =============================================================================
// PROXY-GEN PROCESSOR — v2 proxy generation pipeline (2026-05-14).
// -----------------------------------------------------------------------------
// Replaces the legacy fire-and-forget /generate-proxy + webhook-callback
// architecture with the same synchronous worker pattern hls-ingest uses.
//
// Why the rewrite (auditor-grade rationale):
//   The legacy architecture had Railway return 202 immediately, run ffmpeg
//   in the background under execSync (which blocks Node's event loop), then
//   POST a webhook callback back to Base44 when done. Three failure modes:
//     1. execSync starved the event loop — /health couldn't answer mid-
//        transcode; Base44's diagnostic probe saw HTTP 30s aborts.
//     2. The 202 response and the ffmpeg kickoff raced on the socket buffer
//        flush — Base44's caller could time out before the 202 was visible.
//     3. The webhook callback chain (proxyGenerationCallback + RAILWAY_-
//        CALLBACK_SECRET + Base44-App-Id header dance) had no retries, no
//        observability, no DLQ. A single dropped webhook left the Project
//        stuck in 'generating' forever.
//
// New architecture (this processor):
//   1. Producer (generateProxy) enqueues a ProxyGenJobData here.
//   2. We POST to Railway /generate-proxy-sync — SYNCHRONOUS endpoint that
//      holds the HTTP connection open until ffmpeg finishes + S3 uploads
//      complete + Railway returns 200 with the result.
//   3. 15s heartbeat extends our BullMQ job lock so the 4hr Railway call
//      doesn't trip stalled-job detection (which fires at 30s by default).
//   4. On Railway 200 → call proxyGenWorkerStep to finalize the Project
//      entity (proxy_status='ready' + keys).
//   5. On Railway 4xx/5xx OR network failure → throw → BullMQ retries once
//      (PROXY_GEN_JOB_OPTIONS) or DLQs.
//   6. On UnrecoverableError → skip retry, DLQ immediately + call
//      proxyGenWorkerStep with action='fail'.
//
// SECURITY MODEL — mirrors hls-ingest exactly:
//   • Scoped JWT (60-min TTL) bound to (user, project, project_id,
//     'proxyGenWorkerStep'). Worker forwards verbatim as X-Worker-JWT.
//   • Railway api_key forwarded from the producer via job.data so the worker
//     never holds it in env — single source of truth lives on Base44.
//   • Signed source URL has its own 6h S3 TTL — minimal blast radius.
//
// HEARTBEAT — same pattern as hls-ingest. Railway proxy gen can take 30+ min
// on long sources at the 720p/2Mbps profile, vastly longer than BullMQ's 30s
// stalled-job default. We extend the lock every 15s.
//
// IDEMPOTENCY — single-shot job. Re-running the same job on the same project
// re-runs Railway and overwrites the S3 keys (deterministic for the same
// source). proxyGenWorkerStep short-circuits if the Project is already in
// proxy_status='ready' (operator can pass force=true to override).
// =============================================================================

import { UnrecoverableError, type Job } from 'bullmq';
import type { ProxyGenJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

// Per-call budgets.
const FINALIZER_TIMEOUT_MS = 90_000;
// Railway proxy-gen ceiling. ffmpeg at the 720p/2Mbps profile on a small
// Railway dyno runs at ~4× realtime, so a 60-min source = ~15 min compute.
// The legacy code held a 4hr ffmpeg ceiling; we hold the HTTP call at 3.5hr
// to give Railway some headroom for the S3 upload after ffmpeg returns.
const RAILWAY_CALL_TIMEOUT_MS = 3.5 * 60 * 60 * 1000;
// Lock heartbeat — Railway calls dwarf BullMQ's 30s default stalled detection.
const HEARTBEAT_MS = 15_000;

interface RailwayProxyResponse {
  proxy_video_key: string;
  proxy_audio_key: string;
  bytes_video?: number;
  bytes_audio?: number;
  // Echo fields are optional but useful for audit cross-correlation.
  project_id?: string;
}

async function callRailway(
  data: ProxyGenJobData,
  signal: AbortSignal,
): Promise<RailwayProxyResponse> {
  const url = `${data.railway_url.replace(/\/+$/, '')}/generate-proxy-sync`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${data.railway_api_key}`,
      'X-Request-Id': data.request_id,
    },
    body: JSON.stringify({
      project_id: data.project_id,
      source_url: data.source_url,
      bucket: data.bucket,
      region: data.region,
      proxy_video_key: data.proxy_video_key,
      proxy_audio_key: data.proxy_audio_key,
      credential_secret_prefix: data.credential_secret_prefix || '',
    }),
    signal,
  });

  // Bad input → don't retry. ffmpeg non-zero exit, malformed source media,
  // missing S3 keys: all deterministic, retry wastes another 5-15min of
  // Railway compute and produces another identical failure row (auditor
  // red flag). Throw UnrecoverableError so BullMQ marks the job failed
  // without scheduling another attempt.
  if (res.status >= 400 && res.status < 500) {
    const body = await res.text().catch(() => '');
    throw new UnrecoverableError(
      `railway /generate-proxy-sync → HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }
  // Transient (5xx / network) → throw plain Error so BullMQ retries per
  // PROXY_GEN_JOB_OPTIONS.attempts.
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`railway /generate-proxy-sync → HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const json = (await res.json()) as RailwayProxyResponse;
  if (!json.proxy_video_key || !json.proxy_audio_key) {
    throw new UnrecoverableError(
      `railway /generate-proxy-sync → malformed response: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return json;
}

export async function processProxyGen(job: Job<ProxyGenJobData>) {
  const t0 = Date.now();
  const data = job.data;
  const { project_id, user_email, request_id, auth_token } = data;

  if (!auth_token) {
    throw new UnrecoverableError(
      'proxy-gen: missing auth_token (job from a stale schema — re-enqueue required)',
    );
  }
  if (!data.railway_url || !data.railway_api_key) {
    throw new UnrecoverableError(
      'proxy-gen: missing railway_url / railway_api_key (producer must inline these)',
    );
  }

  // ─── Heartbeat — keeps job lock alive during the long Railway call ───
  let heartbeatActive = true;
  const heartbeat = (async () => {
    while (heartbeatActive) {
      await new Promise((r) => setTimeout(r, HEARTBEAT_MS));
      if (!heartbeatActive) break;
      try {
        await job.extendLock(job.token!, 30_000);
      } catch {
        /* lock may have already advanced */
      }
    }
  })();

  // AbortController so the heartbeat can abort the Railway fetch on shutdown.
  const ctrl = new AbortController();
  const railwayTimer = setTimeout(() => ctrl.abort(), RAILWAY_CALL_TIMEOUT_MS);

  try {
    await logEvent({
      function_name: 'bullmq:proxy-gen',
      event: 'proxy_gen_railway_dispatch',
      context: {
        project_id,
        user_email,
        request_id,
        attempts: job.attemptsMade + 1,
        proxy_video_key: data.proxy_video_key,
        proxy_audio_key: data.proxy_audio_key,
      },
    });

    // ─── 1. Long synchronous call to Railway ───
    const railwayRes = await callRailway(data, ctrl.signal);

    await logEvent({
      function_name: 'bullmq:proxy-gen',
      event: 'proxy_gen_railway_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id,
        request_id,
        proxy_video_key: railwayRes.proxy_video_key,
        proxy_audio_key: railwayRes.proxy_audio_key,
        bytes_video: railwayRes.bytes_video || null,
        bytes_audio: railwayRes.bytes_audio || null,
      },
    });

    // ─── 2. Finalize on Base44 — write proxy_status='ready' + keys ───
    const finalizeRes = await invokeBase44Function<{ ok: boolean }>({
      fn: 'proxyGenWorkerStep',
      authToken: auth_token,
      payload: {
        project_id,
        action: 'complete',
        proxy_video_key: railwayRes.proxy_video_key,
        proxy_audio_key: railwayRes.proxy_audio_key,
        bytes_video: railwayRes.bytes_video || null,
        bytes_audio: railwayRes.bytes_audio || null,
      },
      timeoutMs: FINALIZER_TIMEOUT_MS,
    });

    await logEvent({
      function_name: 'bullmq:proxy-gen',
      event: 'proxy_gen_complete',
      duration_ms: Date.now() - t0,
      context: {
        project_id,
        user_email,
        request_id,
        attempts: job.attemptsMade + 1,
        finalize_ok: finalizeRes?.ok ?? null,
      },
    });

    return {
      ok: true,
      proxy_video_key: railwayRes.proxy_video_key,
      proxy_audio_key: railwayRes.proxy_audio_key,
      duration_ms: Date.now() - t0,
    };
  } catch (err) {
    const e = err as Error;
    const isUnrecoverable = e instanceof UnrecoverableError;
    const willRetry = !isUnrecoverable && job.attemptsMade + 1 < (job.opts.attempts ?? 1);

    await logEvent({
      function_name: 'bullmq:proxy-gen',
      level: 'error',
      event: 'proxy_gen_failed',
      message: e.message,
      error_kind: isUnrecoverable ? 'UnrecoverableError' : e.name,
      duration_ms: Date.now() - t0,
      context: {
        project_id,
        user_email,
        request_id,
        attempts: job.attemptsMade + 1,
        will_retry: willRetry,
      },
    });

    // On TERMINAL failure (no more retries OR unrecoverable), tell Base44 to
    // mark the Project as proxy_status='failed' with the error. We do NOT
    // call this on intermediate retries — the Project stays in 'generating'
    // until the retry succeeds or exhausts. Same pattern as hls-ingest's
    // failRun() but invoked from the worker side because proxy gen has no
    // ProxyGenRun entity (Project.proxy_status IS the audit row).
    if (!willRetry) {
      try {
        await invokeBase44Function({
          fn: 'proxyGenWorkerStep',
          authToken: auth_token,
          payload: {
            project_id,
            action: 'fail',
            error_message: String(e.message || e).slice(0, 500),
          },
          timeoutMs: FINALIZER_TIMEOUT_MS,
        });
      } catch (finErr) {
        // Best-effort — if the finalizer also fails, watchdogProxyGeneration
        // will catch the stuck Project on its next 15-min scan. We log loud.
        const fe = finErr as Error;
        await logEvent({
          function_name: 'bullmq:proxy-gen',
          level: 'error',
          event: 'proxy_gen_finalize_fail_unreachable',
          message: `Could not invoke proxyGenWorkerStep(action=fail): ${fe.message}`,
          context: { project_id, request_id },
        });
      }
    }
    throw err; // BullMQ retries per PROXY_GEN_JOB_OPTIONS, or DLQs.
  } finally {
    clearTimeout(railwayTimer);
    heartbeatActive = false;
    await heartbeat.catch(() => {});
  }
}
