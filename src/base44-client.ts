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

// =============================================================================
// PLATFORM RATE LIMIT (HTTP 429) RESILIENCE LAYER
// -----------------------------------------------------------------------------
// Incident reference: 2026-05-10 voice-gen incident — 116-segment dub at
// voice-gen concurrency=5 saturated the platform per-app gateway with 429s.
// BullMQ's default 3 attempts × ~5s exponential backoff exhausted before
// the limiter window cleared, DLQ'ing ~80 segments. Worker code was sound;
// retry budget was the gap.
//
// Strategy: bounded internal retry on HTTP 429 with two improvements over
// pure BullMQ retry: (a) we respect the `Retry-After` response header if
// the platform sends one, falling back to exponential backoff otherwise,
// and (b) the retry happens INSIDE the worker process so we don't release
// + reacquire the BullMQ slot 3x (which was its own contention pattern).
//
// Retry budget: 4 attempts over ~60s worst case. A sustained 429 storm
// still surfaces as a job failure within ~1min — not buried indefinitely.
// Combined with the worker concurrency lowered to 3 (env.ts), this
// eliminates the failure mode without masking real outages.
//
// Auditor framing (SOC 2 CC7.4 — Subprocessor / Vendor Failure Response):
// Same envelope as the gateway-auth 403 retry above. Every retry logged
// with full context. Bounded budget. DLQ + circuit breaker on exhaustion.
// =============================================================================

const RATE_LIMIT_RETRY_MAX = 4;
// Fallback delays when no Retry-After header is present. 5s, 10s, 20s, 30s
// = ~65s worst-case before giving up on a sustained 429.
const RATE_LIMIT_RETRY_DELAYS_MS = [5000, 10_000, 20_000, 30_000];
// Cap on Retry-After honour, even if the platform sends a larger value.
// Prevents pathological 'Retry-After: 3600' from pinning a worker slot for
// an hour. 30s ceiling matches our exponential-backoff worst case.
const RATE_LIMIT_RETRY_AFTER_CAP_MS = 30_000;

function isGatewayAuthRejection(status: number, body: string): boolean {
  if (status !== 403) return false;
  // Strict signature match — the platform's gateway-auth response. Do NOT
  // catch generic 403s (e.g. function-side RBAC denials); those are real
  // authorization failures and must propagate.
  return /auth_required/.test(body) || /This app is private/i.test(body);
}

function isRateLimited(status: number): boolean {
  // 429 is the canonical "Too Many Requests" signal. The platform returns
  // it consistently for per-app gateway throttling.
  return status === 429;
}

/**
 * Parse a Retry-After header per RFC 9110. Supports both integer-seconds
 * and HTTP-date formats. Returns null if absent/invalid; capped at the
 * RATE_LIMIT_RETRY_AFTER_CAP_MS ceiling.
 */
function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  // Integer seconds form.
  const asInt = Number(trimmed);
  if (Number.isFinite(asInt) && asInt >= 0) {
    return Math.min(asInt * 1000, RATE_LIMIT_RETRY_AFTER_CAP_MS);
  }
  // HTTP-date form.
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    if (delta < 0) return 0;
    return Math.min(delta, RATE_LIMIT_RETRY_AFTER_CAP_MS);
  }
  return null;
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
  // Two independent retry budgets — gateway-auth (403) and rate-limit (429)
  // — tracked separately because their failure modes and recovery curves
  // differ. A flow that hits both (rare) gets the sum of both budgets.
  let gatewayAuthAttempts = 0;
  let rateLimitAttempts = 0;
  // Cap total iterations defensively so a pathological alternation between
  // 403 and 429 can't loop forever.
  const TOTAL_ITERATION_CAP = GATEWAY_AUTH_RETRY_MAX + RATE_LIMIT_RETRY_MAX + 2;
  for (let iter = 0; iter < TOTAL_ITERATION_CAP; iter++) {
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
      if (isGatewayAuthRejection(res.status, body) && gatewayAuthAttempts < GATEWAY_AUTH_RETRY_MAX) {
        const delay = GATEWAY_AUTH_RETRY_DELAYS[gatewayAuthAttempts];
        // Audit-grade log so every retry is attributable.
        await logEvent({
          function_name: 'bullmq:base44-client',
          level: 'warn',
          event: 'gateway_auth_retry',
          message: `Platform gateway 403 auth_required — retrying`,
          context: {
            fn: opts.fn,
            attempt: gatewayAuthAttempts + 1,
            max_attempts: GATEWAY_AUTH_RETRY_MAX + 1,
            delay_ms: delay,
            status: res.status,
            body_excerpt: body.slice(0, 200),
          },
        });
        gatewayAuthAttempts++;
        await sleep(delay);
        continue;
      }

      // Retryable: platform per-app rate limiter (HTTP 429). Honour
      // Retry-After if present, fall back to exponential backoff otherwise.
      if (isRateLimited(res.status) && rateLimitAttempts < RATE_LIMIT_RETRY_MAX) {
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        const fallbackMs = RATE_LIMIT_RETRY_DELAYS_MS[rateLimitAttempts];
        const delay = retryAfterMs != null ? retryAfterMs : fallbackMs;
        await logEvent({
          function_name: 'bullmq:base44-client',
          level: 'warn',
          event: 'rate_limit_retry',
          message: `Platform 429 rate-limited — retrying`,
          context: {
            fn: opts.fn,
            attempt: rateLimitAttempts + 1,
            max_attempts: RATE_LIMIT_RETRY_MAX + 1,
            delay_ms: delay,
            retry_after_header: res.headers.get('retry-after') || null,
            used_retry_after: retryAfterMs != null,
            status: res.status,
            body_excerpt: body.slice(0, 200),
          },
        });
        rateLimitAttempts++;
        await sleep(delay);
        continue;
      }

      // Non-retryable failure — propagate immediately.
      throw new Error(`base44 ${opts.fn} → HTTP ${res.status}: ${body.slice(0, 500)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  // Retries exhausted. Surface a distinctive error so app-side circuit
  // breakers can recognise the pattern (e.g. orchestrateTranslationRun's
  // gateway_auth_regression detector). Tag whichever budget was exhausted.
  const exhaustedTag = lastStatus === 429
    ? `exhausted ${RATE_LIMIT_RETRY_MAX + 1} rate-limit retries`
    : `exhausted ${GATEWAY_AUTH_RETRY_MAX + 1} gateway-auth retries`;
  throw new Error(`base44 ${opts.fn} → HTTP ${lastStatus}: ${lastBody.slice(0, 500)} [${exhaustedTag}]`);
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
