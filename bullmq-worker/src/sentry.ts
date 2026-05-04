// =============================================================================
// SENTRY — Optional error reporting transport for the worker.
// No-op when SENTRY_BACKEND_DSN is unset.
// =============================================================================

import * as Sentry from '@sentry/node';
import { env } from './env.js';

let initialized = false;

export function initSentry() {
  if (initialized) return;
  if (!env.SENTRY_BACKEND_DSN) return;
  Sentry.init({
    dsn: env.SENTRY_BACKEND_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: 0.05,
  });
  initialized = true;
}

export function captureError(err: unknown, ctx?: Record<string, unknown>) {
  if (!initialized) return;
  Sentry.captureException(err, ctx ? { extra: ctx } : undefined);
}

export async function flushSentry(timeoutMs = 2000) {
  if (!initialized) return;
  try { await Sentry.flush(timeoutMs); } catch { /* best effort */ }
}