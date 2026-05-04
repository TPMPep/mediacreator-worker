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

export async function invokeBase44Function<T = unknown>(opts: InvokeOpts): Promise<T> {
  const url = `${env.BASE44_API_BASE}/${env.BASE44_APP_ID}/functions/${opts.fn}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5 * 60 * 1000);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-App-Id': env.BASE44_APP_ID,
    };
    if (opts.authToken) {
      headers['X-Worker-JWT'] = opts.authToken;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.payload ?? {}),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`base44 ${opts.fn} → HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
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