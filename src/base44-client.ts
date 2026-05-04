// =============================================================================
// BASE44 CLIENT — Thin HTTP wrapper for invoking Base44 backend functions
// from the worker. Uses a service-role token so calls bypass user auth but
// must still be admin-gated where appropriate.
// =============================================================================

import { env } from './env.js';

interface InvokeOpts {
  /** Function name (e.g. 'generateOneSegment'). */
  fn: string;
  /** JSON payload to send. */
  payload: unknown;
  /** Per-call timeout in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
}

export async function invokeBase44Function<T = unknown>(opts: InvokeOpts): Promise<T> {
  const url = `${env.BASE44_API_BASE}/${env.BASE44_APP_ID}/functions/${opts.fn}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5 * 60 * 1000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.BASE44_SERVICE_TOKEN}`,
        'X-App-Id': env.BASE44_APP_ID,
      },
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

/** Best-effort structured log emit via the existing StructuredLog entity. */
export async function logEvent(payload: {
  function_name: string;
  level?: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  event: string;
  message?: string;
  duration_ms?: number;
  error_kind?: string;
  context?: Record<string, unknown>;
}) {
  try {
    await fetch(
      `${env.BASE44_API_BASE}/${env.BASE44_APP_ID}/entities/StructuredLog`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.BASE44_SERVICE_TOKEN}`,
          'X-App-Id': env.BASE44_APP_ID,
        },
        body: JSON.stringify({ level: 'info', ...payload }),
      },
    );
  } catch {
    /* never throw from logger */
  }
}