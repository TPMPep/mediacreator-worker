// =============================================================================
// gltv-tick-retry — is THIS cascade-tick failure transient, and may the tick be
// rescheduled rather than left for the watchdog?
// -----------------------------------------------------------------------------
// WHY THIS EXISTS (the observed incident, 2026-08-24). The ARGX validation job
// 6a8bd53762fb222094d48c0b had every one of its 42 lines rendered and its voice
// run completed, and it still never produced a WAV. Its cascade tick had died at
// 05:29 with:
//
//     base44 gltvCascadeWorkerStep → HTTP 500: {"error":"Rate limit exceeded"}
//
// That is the PLATFORM's per-app SDK gateway limit, hit because the brain tick
// reads and writes across a 42-segment project. It is a back-pressure signal, in
// no way a statement about the job — the very next call would have succeeded.
// But the cascade lane runs `attempts: 1` (deliberately: a BullMQ retry of a
// tick that already issued a producer directive could re-issue PAID provider
// work), so the throw ended the chain outright and the job sat at
// `generating_voice` indefinitely.
//
// THE DISTINCTION THAT MAKES THIS SAFE. `attempts: 1` protects against replaying
// a tick whose producer directive may already have been executed. A transport
// failure on the DECIDE/RECORD call to the brain is a different animal: the brain
// is the sole writer of status and every step is keyed by *_run_id, so re-running
// a tick that was REFUSED ADMISSION is idempotent by construction — nothing was
// decided and no producer was called. So we do not weaken `attempts`; we
// reschedule the SAME persistent job through the exact mechanism a healthy tick
// already uses between ticks (`job.moveToDelayed`), which consumes no attempt and
// writes no failure record.
//
// DELIBERATELY NARROW. Only signatures that are unambiguously platform
// back-pressure are transient. Anything else — a producer error, a bad token, a
// stale schema, a brain 4xx, an unrecognised 500 — still fails loudly and is
// resumed (or failed out) by watchdogGltvCascade under its bounded five-recovery
// budget. Widening this list would convert real defects into silent retries,
// which is the opposite of what the incident calls for.
//
// THE BOUND IS ITS OWN, AND SMALL. Transient rescheduling is capped at
// MAX_TRANSIENT_TICK_RETRIES per cascade and counted on the job payload, so a
// sustained platform outage degrades to the watchdog path (and ultimately the
// recovery cap) instead of a tick that reschedules itself forever. The counter is
// reset by the normal continue/advance path, so a cascade that recovers gets its
// full allowance back for a genuinely separate later incident.
//
// SOC 2 CC7.2 (bounded, resumable, no silent stall) / CC7.4 (a reschedule never
// re-issues paid provider work, and the retry budget is finite and recorded).
// =============================================================================

/** Hard cap on transient reschedules for ONE cascade, before the tick fails loudly. */
export const MAX_TRANSIENT_TICK_RETRIES = 3;

/** Backoff between transient reschedules, indexed by the retry about to be spent. */
export const TRANSIENT_TICK_BACKOFF_MS = [15_000, 45_000, 120_000] as const;

/**
 * Signatures that are platform/transport back-pressure rather than a statement
 * about the job. Matched case-insensitively against the thrown message.
 *
 * `Rate limit exceeded` is the Base44 per-app SDK gateway limit — the exact
 * string observed on the incident above, returned with HTTP 500 rather than 429,
 * which is why matching on status alone is not sufficient.
 */
const TRANSIENT_TICK_SIGNATURES = [
  'rate limit exceeded',
  'too many requests',
  'http 429',
  'http 502',
  'http 503',
  'http 504',
  'gateway timeout',
  'service unavailable',
  'bad gateway',
] as const;

/**
 * TRUE when this failure is platform back-pressure on the worker→brain call and
 * the tick may therefore be rescheduled without risk of replaying paid work.
 *
 * Scoped to the BRAIN call on purpose: a message naming a producer function is
 * NOT eligible, because a producer directive may already have been executed and
 * a reschedule would re-decide it. That is the one case `attempts: 1` exists for.
 */
export function isTransientTickError(message: unknown): boolean {
  const m = String(message || '').toLowerCase();
  if (!m) return false;
  // A producer-call failure is never eligible — see note above.
  if (m.includes('producer') || m.includes('producer chain exceeded')) return false;
  return TRANSIENT_TICK_SIGNATURES.some(sig => m.includes(sig));
}

export interface TransientRetryDecision {
  /** TRUE when the tick should be rescheduled instead of thrown. */
  retry: boolean;
  /** The count to persist on the job payload (always the incremented value). */
  next_count: number;
  /** Delay before the rescheduled tick runs. 0 when not retrying. */
  delay_ms: number;
  reason: string;
}

/**
 * Decide whether a transient tick failure may be rescheduled, given how many
 * transient reschedules this cascade has already spent.
 *
 * Pure and deterministic, so the bound is provable in a unit test rather than
 * only observable in production — the same posture the watchdog's own decision
 * rule was moved to after D-1/D-2.
 */
export function decideTransientRetry(currentCount: unknown): TransientRetryDecision {
  const n = Number(currentCount);
  const spent = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (spent >= MAX_TRANSIENT_TICK_RETRIES) {
    return {
      retry: false,
      next_count: spent,
      delay_ms: 0,
      reason: `transient_retry_budget_exhausted_${spent}_of_${MAX_TRANSIENT_TICK_RETRIES}`,
    };
  }
  return {
    retry: true,
    next_count: spent + 1,
    delay_ms: TRANSIENT_TICK_BACKOFF_MS[spent] ?? TRANSIENT_TICK_BACKOFF_MS[TRANSIENT_TICK_BACKOFF_MS.length - 1],
    reason: `transient_tick_retry_${spent + 1}_of_${MAX_TRANSIENT_TICK_RETRIES}`,
  };
}
