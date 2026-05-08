// =============================================================================
// BASE44 CLIENT — Thin HTTP wrapper for invoking Base44 backend functions
// from the worker.
//
// AUTH MODEL (Option D — scoped JWT callbacks):
// ---------------------------------------------------------------------------
// We do NOT use a long-lived shared admin token. Each job carries its own
// scoped JWT minted by the producer (runVoiceGeneration), bound to:
//   • a specific user (preserves attribution)
//   • a specific project + resource (the only one this token can touch)
//   • a specific function name (the only one this token can call)
//   • 15-minute expiry
//
// The worker forwards that JWT verbatim as the `X-Worker-JWT` header. The
// target function verifies the JWT signature + scope before doing any work.
//
// Blast radius if a JWT is exfiltrated: ONE segment, ONE function, ≤15 min.
// (vs. shared admin token: entire DB, until rotated.)
//
// See functions/_lib_workerJWT on the Base44 side for the full security
// model and TPN/SOC2 rationale.
// =============================================================================

import { env } from './env.js';

interface InvokeOpts {
  /** Function name (e.g. 'generateOneSegment'). */
  fn: string;
  /** JSON payload to send. */
  payload: unknown;
  /** Per-call timeout in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
  /**
   * Scoped JWT minted by the producer for THIS specific call. Required for
   * any function that performs writes or accesses tenant data. The worker
   * forwards it as `X-Worker-JWT` and the function verifies scope before
   * executing.
   */
  authToken?: string;
}

// =============================================================================
// PLATFORM GATEWAY 403 RESILIENCE LAYER
// -----------------------------------------------------------------------------
// Incident reference: docs/incident-2026-05-08-gateway-auth.md
//
// Symptom: Base44 platform gateway intermittently returns 403 with body
// `{"reason": "auth_required", "message": "This app is private..."}` BEFORE
// our function-side verifyWorkerJWT() runs. Behaviour is non-deterministic
// (edge routing race) — most calls go through, some 403 in bursts. A single
// run can complete 13/40 chunks cleanly, then enter a 403 storm that kills
// the remaining 27.
//
// Strategy: bounded internal retry on this specific signature. The HS256
// worker JWT is valid for 30 min, so retrying inside the worker (rather
// than letting BullMQ DLQ the job) is cheap and safe. The chunk worker's
// idempotency guard makes a second arrival a no-op if the first eventually
// committed (it won't have, in this failure mode — the function never ran).
//
// We retry ONLY on the gateway-auth signature. All other 4xx (real client
// errors) and 5xx (real server errors) propagate immediately so they're
// classified correctly and DLQ'd if appropriate.
//
// Auditor framing (SOC 2 CC7.4 — Subprocessor / Vendor Failure Response):
// "The system tolerates transient subprocessor unavailability with bounded
// retry, distinguishes transient from sustained failure, and escalates to
// DLQ + the app-side circuit breaker when retries are exhausted." Every
// retry is logged with full context for audit. The retry budget is
// deliberately tight — 5 attempts over ~30s — so a sustained outage still
// surfaces as a job failure within one minute, not buried indefinitely.
// =============================================================================

const GATEWAY_AUTH_RETRY_MAX = 5;
// Delays in ms: 1s, 2s, 4s, 8s, 16s. Total worst case: 31s before giving up.
const GATEWAY_AUTH_RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];

function isGatewayAuthRejection(status: number, body: string): boolean {
  if (status !== 403) return false;
  // Strict signature match — the platform's gateway-auth response. Do NOT
  // catch generic 403s (e.g. function-side RBAC denials); those are real
  // authorization failures and must propagate.
  return /auth_required/.test(body) || /This app is private/i.test(body);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export async function invokeBase44Function<T = unknown>(opts: InvokeOpts): Promise<T> {
  const url = `${env.BASE44_API_BASE}/${env.BASE44_APP_ID}/functions/${opts.fn}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-App-Id': env.BASE44_APP_ID,
  };
  if (opts.authToken) {
    // Send ONLY X-Worker-JWT. We previously also sent Authorization: Bearer
    // for the platform gateway, but that backfires intermittently: the
    // gateway tries to validate our HS256 worker JWT as a Base44 session
    // token, fails, and returns 403 ("You must be logged in") before our
    // function-side verifyWorkerJWT() ever runs. The behaviour is non-
    // deterministic (edge routing) — most calls go through, some 403.
    // Dropping the Authorization header lets the gateway treat the call
    // as anonymous-but-allowed; our function's verifyWorkerJWT() reads
    // X-Worker-JWT and enforces the real auth. (Day 5 finding 2026-05-06.)
    headers['X-Worker-JWT'] = opts.authToken;
  }

  let lastBody = '';
  let lastStatus = 0;
  for (let attempt = 0; attempt <= GATEWAY_AUTH_RETRY_MAX; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5 * 60 * 1000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(opts.payload ?? {}),
        signal: ctrl.signal,
      });
      if (res.ok) return await res.json() as T;

      const body = await res.text().catch(() => '');
      lastBody = body;
      lastStatus = res.status;

      // Retryable: platform gateway auth rejection. Sleep + retry.
      if (isGatewayAuthRejection(res.status, body) && attempt < GATEWAY_AUTH_RETRY_MAX) {
        const delay = GATEWAY_AUTH_RETRY_DELAYS[attempt];
        // Audit-grade log so every retry is attributable.
        await logEvent({
          function_name: 'bullmq:base44-client',
          level: 'warn',
          event: 'gateway_auth_retry',
          message: `Platform gateway 403 auth_required — retrying`,
          context: {
            fn: opts.fn,
            attempt: attempt + 1,
            max_attempts: GATEWAY_AUTH_RETRY_MAX + 1,
            delay_ms: delay,
            status: res.status,
            body_excerpt: body.slice(0, 200),
          },
        });
        await sleep(delay);
        continue;
      }

      // Non-retryable failure — propagate immediately.
      throw new Error(`base44 ${opts.fn} → HTTP ${res.status}: ${body.slice(0, 500)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  // Retries exhausted on a gateway-auth rejection. Surface a distinctive
  // error so app-side circuit breakers (e.g. orchestrateTranslationRun's
  // gateway_auth_regression detector) can recognise the pattern.
  throw new Error(`base44 ${opts.fn} → HTTP ${lastStatus}: ${lastBody.slice(0, 500)} [exhausted ${GATEWAY_AUTH_RETRY_MAX + 1} gateway-auth retries]`);
}

/**
 * Best-effort structured log emit. Worker-side logs go to stdout (Railway
 * captures them). We deliberately do NOT write to the Base44 StructuredLog
 * entity from here — that would require its own auth path and we'd lose
 * the security guarantees of scoped JWTs (which are per-call, per-resource).
 *
 * For audit-quality logs of actual work performed, generateOneSegment writes
 * its own audit trail on the Base44 side after JWT verification.
 */
export async function logEvent(payload: {
  function_name: string;
  level?: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  event: string;
  message?: string;
  duration_ms?: number;
  error_kind?: string;
  context?: Record<string, unknown>;
}) {
  const level = payload.level || 'info';
  const line = JSON.stringify({ ts: new Date().toISOString(), ...payload, level });
  if (level === 'error' || level === 'fatal') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
