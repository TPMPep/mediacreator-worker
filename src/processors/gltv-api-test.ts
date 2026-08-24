// =============================================================================
// GLTV-API-TEST PROCESSOR — the internal harness that exercises the REAL public
// GLTV Dubbing API as a real external caller.
// -----------------------------------------------------------------------------
// ADDITIVE TEST INFRASTRUCTURE. It changes nothing about the production API; it
// CALLS it, over the public internet, with a real bearer credential, so the
// actual authentication, admission, rate limit, cost preflight, recipe
// resolution and cascade enqueue all run exactly as they do for a customer.
//
// WHY THE CALL ORIGINATES HERE. A Base44 function cannot make this request at
// all: a raw fetch from a function to our own public deployment returns 508 Loop
// Detected, and functions.invoke silently drops custom headers so it cannot
// carry a bearer key. Both were proven in _diagnoseGltvHeaderForward. This
// worker is genuinely off-platform, so its request crosses real DNS and TLS from
// a foreign origin — not a workaround, but the more faithful test.
//
// ─── THIS IS A FIXED-TARGET HARNESS, NOT A PROXY ────────────────────────────
// The job payload contains a run id and a callback JWT. It contains no URL, no
// host, no method, no header and no credential. Every endpoint the brain hands
// back is validated here against (a) this worker's OWN copy of the public origin
// and (b) a hardcoded three-entry function allow-list. A directive therefore
// cannot point this processor at an arbitrary host even if the brain were wrong.
//
// ─── THE CREDENTIAL ─────────────────────────────────────────────────────────
// The plaintext bearer secret exists ONLY in this worker's environment. It is
// selected by the run's credential_class through a map THIS FILE owns, so no
// caller ever names an environment variable. Before a single request is sent it
// is hashed and compared against the referenced ApiKey's own key_hash: a stale
// Railway secret left behind after a key rotation fails CLOSED rather than
// authenticating as some other credential and producing confident, meaningless
// results. The secret is never logged, never returned, never persisted.
//
// ─── WAITING WITHOUT HOLDING A SLOT ─────────────────────────────────────────
// Proving delivery means waiting for a whole cascade, which must not pin a
// worker slot. The run submits, persists the returned job ids, then reschedules
// ITSELF via job.moveToDelayed between polls — one persistent job, many ticks.
// It never re-adds itself against its own still-occupied deterministic id (the
// defect that once killed the cascade chain after a single tick), and it never
// sleeps in an active handler.
//
// SOC 2 CC6.1 (attributable to the launching admin) / CC7.4 (bounded burst,
// bounded window, no retry of a phase that already spent) / CC8.1
// (GltvApiTestRun holds the request, the response and the resulting job ids).
// =============================================================================

import { DelayedError } from 'bullmq';
import type { Job } from 'bullmq';
import { createHash } from 'node:crypto';
import type { GltvApiTestJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat, WorkerLockLostError } from '../base44-client.js';
import { decideTransientRetry, isTransientTickError, MAX_TRANSIENT_TICK_RETRIES } from '../gltv-tick-retry.js';
import { env } from '../env.js';

const BRAIN_FN = 'gltvApiTestWorkerStep';
const BRAIN_TIMEOUT_MS = 90_000;
const PUBLIC_CALL_TIMEOUT_MS = 60_000;
/** Bytes-download + PUT for the full-upload path needs a longer ceiling. */
const UPLOAD_CALL_TIMEOUT_MS = 5 * 60_000;
const MAX_DIRECTIVE_CHAIN_PER_TICK = 4;

/**
 * credential_class → env var. MIRRORS base44/shared/gltv-api-test-policy.ts and
 * is owned HERE deliberately: the directive carries only the class, so nothing
 * off-worker can select which secret is read. CI asserts the two copies match.
 */
const CREDENTIAL_ENV_BY_CLASS = {
  test: 'GLTV_TEST_API_KEY_TEST',
  live: 'GLTV_TEST_API_KEY_LIVE',
} as const;
type CredentialClass = keyof typeof CREDENTIAL_ENV_BY_CLASS;

/** The ONLY public functions this harness may call. */
const ALLOWED_PUBLIC_FUNCTIONS = ['gltvGetUploadUrl', 'gltvCreateDubbingJob', 'gltvGetDubbingJob'];

interface AttemptDirective {
  attempt_index: number;
  idempotency_key: string;
  create_body: Record<string, unknown>;
  /** Present only in full_upload mode. */
  upload?: { filename: string; content_type: string; source_download_url: string };
}

interface TestStepResponse {
  action: 'submit' | 'poll' | 'continue' | 'done';
  credential_class?: CredentialClass;
  expected_key_sha256?: string;
  endpoints?: Record<string, string>;
  attempts?: AttemptDirective[];
  job_ids?: string[];
  poll_delay_ms?: number;
  status?: string;
  next_auth_token?: string;
  result?: unknown;
}

async function _log(level: 'info' | 'warn' | 'error', event: string, ctx: Record<string, unknown>, message?: string) {
  const line = `[bullmq:gltv-api-test] ${event} ${JSON.stringify(ctx)}${message ? ` — ${message}` : ''}`;
  if (level === 'error') console.error(line); else console.log(line);
  try {
    await logEvent({ function_name: 'bullmq:gltv-api-test', level, event, message: message || event, context: ctx });
  } catch { /* logging must never fail a run */ }
}

/**
 * Resolve the bearer secret for a class and PROVE it is the credential the run
 * says it is. Returns a named failure instead of throwing so the brain can
 * record WHY the run was refused before spend.
 */
function resolveCredential(
  credentialClass: CredentialClass | undefined,
  expectedSha256: string | undefined,
): { ok: true; key: string } | { ok: false; code: 'env_secret_missing' | 'hash_mismatch' | 'bad_class' } {
  if (!credentialClass || !(credentialClass in CREDENTIAL_ENV_BY_CLASS)) return { ok: false, code: 'bad_class' };
  const varName = CREDENTIAL_ENV_BY_CLASS[credentialClass];
  const key = varName === 'GLTV_TEST_API_KEY_TEST' ? env.GLTV_TEST_API_KEY_TEST : env.GLTV_TEST_API_KEY_LIVE;
  if (!key) return { ok: false, code: 'env_secret_missing' };
  if (!expectedSha256) return { ok: false, code: 'hash_mismatch' };
  const actual = createHash('sha256').update(key, 'utf8').digest('hex');
  // Length-equal comparison of two hex digests; both are fixed-width, so a
  // simple compare leaks nothing useful about the secret itself.
  if (actual.toLowerCase() !== String(expectedSha256).toLowerCase()) return { ok: false, code: 'hash_mismatch' };
  return { ok: true, key };
}

/** Refuse any endpoint that is not our own public origin + an allow-listed fn. */
function assertAllowedEndpoint(url: string | undefined): string {
  const base = env.PUBLIC_API_BASE_URL.replace(/\/+$/, '');
  const prefix = `${base}/functions/`;
  if (!url || !url.startsWith(prefix)) {
    throw new Error(`gltv-api-test: endpoint outside the permitted public origin: ${String(url).slice(0, 120)}`);
  }
  const fn = url.slice(prefix.length);
  if (!ALLOWED_PUBLIC_FUNCTIONS.includes(fn)) {
    throw new Error(`gltv-api-test: function not on the allow-list: ${fn}`);
  }
  return url;
}

async function publicPost(
  url: string,
  key: string,
  body: unknown,
  signal: AbortSignal | undefined,
  timeoutMs = PUBLIC_CALL_TIMEOUT_MS,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    const res = await fetch(url, {
      method: 'POST',
      // The bearer key is the ONE thing that makes this a real customer call.
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let data: Record<string, unknown>;
    try { data = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { data = { _raw: text.slice(0, 400) }; }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Execute ONE attempt end-to-end exactly as a customer would. */
async function runAttempt(
  attempt: AttemptDirective,
  endpoints: Record<string, string>,
  key: string,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const record: Record<string, unknown> = {
    attempt_index: attempt.attempt_index,
    idempotency_key: attempt.idempotency_key,
  };
  const t0 = Date.now();
  try {
    let sourceMediaKey = String(attempt.create_body.source_media_key || '');

    // ─── full_upload mode: the complete customer path ───────────────────
    if (attempt.upload) {
      const upUrl = assertAllowedEndpoint(endpoints.gltvGetUploadUrl);
      const up = await publicPost(upUrl, key,
        { filename: attempt.upload.filename, content_type: attempt.upload.content_type }, signal);
      record.upload_url_http_status = up.status;
      if (up.status !== 200 || !up.data.upload_url) {
        record.error_code = String(up.data.code || 'upload_url_failed');
        record.error_message = String(up.data.error || `gltvGetUploadUrl returned HTTP ${up.status}`).slice(0, 300);
        record.create_latency_ms = Date.now() - t0;
        return record;
      }
      sourceMediaKey = String(up.data.source_media_key || '');

      // Read the fixture bytes (short-TTL signed GET the brain minted) and PUT
      // them to the presigned URL with the SAME content type the URL was signed
      // against — a mismatch is the most common real integration failure.
      const srcRes = await fetch(attempt.upload.source_download_url, { signal });
      if (!srcRes.ok) {
        record.error_code = 'fixture_read_failed';
        record.error_message = `fixture download returned HTTP ${srcRes.status}`;
        record.create_latency_ms = Date.now() - t0;
        return record;
      }
      const bytes = new Uint8Array(await srcRes.arrayBuffer());
      const putCtrl = new AbortController();
      const putTimer = setTimeout(() => putCtrl.abort(), UPLOAD_CALL_TIMEOUT_MS);
      try {
        const put = await fetch(String(up.data.upload_url), {
          method: 'PUT',
          headers: { 'Content-Type': attempt.upload.content_type },
          body: bytes,
          signal: putCtrl.signal,
        });
        record.upload_http_status = put.status;
        if (!put.ok) {
          record.error_code = 'upload_put_failed';
          record.error_message = `S3 PUT returned HTTP ${put.status}`;
          record.create_latency_ms = Date.now() - t0;
          return record;
        }
      } finally { clearTimeout(putTimer); }
    }

    // ─── create: the real public admission path ─────────────────────────
    const createUrl = assertAllowedEndpoint(endpoints.gltvCreateDubbingJob);
    const created = await publicPost(createUrl, key,
      { ...attempt.create_body, source_media_key: sourceMediaKey }, signal);
    record.source_media_key = sourceMediaKey;
    record.create_http_status = created.status;
    record.create_latency_ms = Date.now() - t0;
    if (created.data.job_id) {
      record.dubbing_api_job_id = String(created.data.job_id);
      if (created.data.recipe_slug) record.recipe_slug = String(created.data.recipe_slug);
      if (created.data.estimated_cost_usd !== undefined) record.estimated_cost_usd = Number(created.data.estimated_cost_usd);
    } else {
      record.error_code = String(created.data.code || `http_${created.status}`);
      record.error_message = String(created.data.error || created.data._raw || 'no job_id returned').slice(0, 300);
    }
    return record;
  } catch (err) {
    record.error_code = 'transport_error';
    record.error_message = String((err as Error)?.message || err).slice(0, 300);
    record.create_latency_ms = Date.now() - t0;
    return record;
  }
}

export async function processGltvApiTest(job: Job<GltvApiTestJobData>, token?: string) {
  const t0 = Date.now();
  const { test_run_id, user_email, request_id, auth_token } = job.data;
  const baseCtx = { test_run_id, user_email, request_id, bullmq_job_id: job.id };

  if (!auth_token) throw new Error('gltv-api-test: missing auth_token (stale producer schema)');

  await _log('info', 'gltv_api_test_tick_started', baseCtx);

  try {
    return await runWithLockHeartbeat(job, async (signal) => {
      let step = await invokeBase44Function<TestStepResponse>({
        fn: BRAIN_FN, authToken: auth_token, timeoutMs: BRAIN_TIMEOUT_MS, signal,
        payload: { test_run_id, request_id },
      });

      let chain = 0;
      while (step.action === 'submit' || step.action === 'poll') {
        if (++chain > MAX_DIRECTIVE_CHAIN_PER_TICK) {
          throw new Error(`gltv-api-test: directive chain exceeded ${MAX_DIRECTIVE_CHAIN_PER_TICK} for run ${test_run_id}`);
        }

        // Prove the credential BEFORE any request. A refusal here spends nothing.
        const cred = resolveCredential(step.credential_class, step.expected_key_sha256);
        if (!cred.ok) {
          await _log('error', 'gltv_api_test_credential_refused', { ...baseCtx, code: cred.code },
            'Worker credential does not match the referenced ApiKey — refusing to send any request.');
          step = await invokeBase44Function<TestStepResponse>({
            fn: BRAIN_FN, authToken: auth_token, timeoutMs: BRAIN_TIMEOUT_MS, signal,
            payload: {
              test_run_id, request_id,
              phase_result: { phase: 'credential_check', ok: false, code: cred.code, build_tag: process.env.WORKER_BUILD_TAG || undefined },
            },
          });
          continue;
        }

        const endpoints = step.endpoints || {};

        if (step.action === 'submit') {
          const attempts = step.attempts || [];
          await _log('info', 'gltv_api_test_submitting', { ...baseCtx, attempt_count: attempts.length });
          // PARALLEL by design — a sequential submit would not test concurrency.
          const results = await Promise.all(attempts.map((a) => runAttempt(a, endpoints, cred.key, signal)));
          await _log('info', 'gltv_api_test_submitted', {
            ...baseCtx,
            accepted: results.filter((r) => !!r.dubbing_api_job_id).length,
            statuses: results.map((r) => r.create_http_status),
          });
          step = await invokeBase44Function<TestStepResponse>({
            fn: BRAIN_FN, authToken: auth_token, timeoutMs: BRAIN_TIMEOUT_MS, signal,
            payload: { test_run_id, request_id, phase_result: { phase: 'submit', ok: true, results } },
          });
          continue;
        }

        // poll — read each non-terminal job through the real public endpoint.
        const pollUrl = assertAllowedEndpoint(endpoints.gltvGetDubbingJob);
        const ids = step.job_ids || [];
        const polled = await Promise.all(ids.map(async (id) => {
          try {
            const r = await publicPost(pollUrl, cred.key, { job_id: id }, signal);
            return {
              dubbing_api_job_id: id,
              http_status: r.status,
              status: r.data.status ? String(r.data.status) : undefined,
              progress_pct: r.data.progress_pct !== undefined ? Number(r.data.progress_pct) : undefined,
              failure_phase: r.data.failure_phase ? String(r.data.failure_phase) : undefined,
              error_message: r.data.error_message ? String(r.data.error_message).slice(0, 300) : undefined,
              output_size_bytes: r.data.output_size_bytes !== undefined ? Number(r.data.output_size_bytes) : undefined,
              output_wav_key: r.data.output_wav_key ? String(r.data.output_wav_key) : undefined,
            };
          } catch (err) {
            return { dubbing_api_job_id: id, http_status: 0, error_message: String((err as Error)?.message || err).slice(0, 200) };
          }
        }));
        await _log('info', 'gltv_api_test_polled', {
          ...baseCtx, polled: polled.length, statuses: polled.map((p) => p.status || `http_${p.http_status}`),
        });
        step = await invokeBase44Function<TestStepResponse>({
          fn: BRAIN_FN, authToken: auth_token, timeoutMs: BRAIN_TIMEOUT_MS, signal,
          payload: { test_run_id, request_id, phase_result: { phase: 'poll', ok: true, results: polled } },
        });
      }

      if (step.action === 'continue') {
        // Park in `delayed` — no active slot is held while the cascade runs.
        if (!token) throw new Error(`gltv-api-test: missing BullMQ lock token for run ${test_run_id} — cannot reschedule`);
        const delay = Number(step.poll_delay_ms) > 0 ? Number(step.poll_delay_ms) : 20_000;
        await job.updateData({
          schema_version: job.data.schema_version,
          test_run_id, user_email, request_id,
          auth_token: step.next_auth_token || auth_token,
          // A healthy tick returns the full transient budget: a run that recovered
          // gets its whole allowance back for a genuinely separate later incident,
          // rather than carrying a spent counter for the rest of its window.
          transient_retry_count: 0,
        });
        await _log('info', 'gltv_api_test_next_tick_scheduled', { ...baseCtx, delay_ms: delay, continuation: 'move_to_delayed' });
        await job.moveToDelayed(Date.now() + delay, token);
        throw new DelayedError();
      }

      await _log('info', 'gltv_api_test_done', { ...baseCtx, status: step.status, total_duration_ms: Date.now() - t0 });
      return step.result ?? { ok: true, status: step.status, duration_ms: Date.now() - t0 };
    });
  } catch (err) {
    if (err instanceof DelayedError) throw err;
    const e = err as Error;
    const lockLost = e instanceof WorkerLockLostError;
    // Read off the un-narrowed Error: narrowing via `instanceof WorkerLockLostError`
    // makes the false branch `never`, because it is structurally identical to Error.
    const errName: string = e.name;
    const errMessage: string = e.message;

    // ─── TRANSIENT PLATFORM BACK-PRESSURE → RESCHEDULE, DO NOT DIE ───────────
    // Identical reasoning to the cascade lane, and the same shared rule
    // (gltv-tick-retry), because it is the same failure: a worker→brain call
    // refused by the platform's own rate limiter says nothing about the run.
    //
    // A POLL IS EVEN SAFER TO REPLAY THAN A CASCADE TICK: it only READS job
    // status through the public endpoint and hands the readings to the brain,
    // which is the sole writer. It creates no job, uploads nothing and spends no
    // provider money, so re-running it is idempotent by construction.
    //
    // WHAT IT PROTECTS: the observation window, not the pipeline. The underlying
    // GLTV job keeps running regardless — the harm was that the harness stopped
    // WATCHING it, leaving the run row permanently disagreeing with the delivered
    // artifact. Bounded by the same small budget so a sustained outage terminalises
    // the run honestly (its own `timeout_at`, then stale-claim reclamation) instead
    // of rescheduling forever. A lock-loss is excluded: without the lock we cannot
    // legitimately reschedule, and BullMQ's reclaim already owns that case.
    //
    // DELIBERATELY NOT A SUBMIT-PHASE RETRY: isTransientTickError only matches
    // brain/transport back-pressure, and a submit that already reached
    // gltvCreateDubbingJob is recorded by the brain before this branch is reached.
    if (!lockLost && token && isTransientTickError(errMessage)) {
      const retry = decideTransientRetry(job.data.transient_retry_count);
      if (retry.retry) {
        await job.updateData({ ...job.data, transient_retry_count: retry.next_count });
        await _log('warn', 'gltv_api_test_tick_transient_retry', {
          ...baseCtx,
          error_kind: errName,
          transient_retry_count: retry.next_count,
          max_transient_retries: MAX_TRANSIENT_TICK_RETRIES,
          delay_ms: retry.delay_ms,
          reason: retry.reason,
        }, `Harness tick hit transient platform back-pressure — rescheduling in ${Math.round(retry.delay_ms / 1000)}s (${retry.reason}). No attempt consumed; the underlying GLTV job is untouched: ${errMessage}`);
        await job.moveToDelayed(Date.now() + retry.delay_ms, token);
        throw new DelayedError();
      }
      // Budget exhausted — fall through and fail loudly so the exhaustion is
      // visible rather than being absorbed as another quiet reschedule.
    }

    await _log(lockLost ? 'warn' : 'error', lockLost ? 'gltv_api_test_lock_lost' : 'gltv_api_test_failed', {
      ...baseCtx, total_duration_ms: Date.now() - t0, error_kind: errName,
      transient_retry_count: job.data.transient_retry_count ?? 0,
    }, String(errMessage || '').slice(0, 400));
    throw err;
  }
}
