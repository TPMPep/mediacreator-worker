// =============================================================================
// ME-POLL SINGLETON — the liveness contract for the perpetual M&E harvester.
// -----------------------------------------------------------------------------
// WHY THIS MODULE EXISTS (the incident it closes, 2026-08-22).
// The M&E harvester is a single perpetual heartbeat identified by ONE
// deterministic BullMQ job id. Until now it perpetuated itself by calling
// `queue.add()` with that SAME id at the end of every tick, and the boot seed
// plus the admin reseed did exactly the same thing.
//
// A deterministic job id is only free to reuse once the previous job holding it
// has been REMOVED from Redis. `ME_POLL_JOB_OPTIONS.removeOnComplete` is
// `{ age: 600, count: 5 }`, and BullMQ evicts on that policy LAZILY — the sweep
// runs when a LATER job in the same queue completes. On a queue whose only job
// is the singleton itself, that later completion is the very job the eviction
// was supposed to make room for, so the retention policy can never fire.
//
// The result was a permanent, silent deadlock, measured in production: the last
// tick of `me-poll-singleton` completed at 2026-08-01T06:28:31Z, its completed
// record was never evicted, and therefore EVERY subsequent re-add — the
// processor's own continuation, the boot seed on every deploy, and the admin
// `enqueueMEPoll` reseed — collapsed into a BullMQ no-op. The harvester was dead
// for three weeks while three independent "restore" paths all reported success.
// Provider work kept completing at LALAL.AI and no project was ever finalized,
// so a GLTV cascade with M&E enabled could not clear its fail-closed M&E gate.
//
// THE FIX IS STRUCTURAL, NOT A BIGGER RETENTION WINDOW.
//   1. CONTINUATION NEVER ADDS. A tick reschedules ITSELF via `moveToDelayed`,
//      the pattern already proven for the GLTV cascade (D-5). The job is never
//      completed and never re-created, so its id is continuously occupied BY THE
//      LIVE POLLER and there is no window in which liveness depends on an
//      eviction having happened. `removeOnComplete` becomes irrelevant to
//      liveness, which is the property that failed here.
//   2. RESEED IS STATE-AWARE. A reseed inspects the incumbent's state first and
//      is only ever allowed to REPLACE a provably TERMINAL singleton. A live
//      poller — active, waiting, delayed, prioritized, paused — is never
//      touched, so a reseed can neither duplicate the heartbeat nor evict a
//      healthy one mid-flight. An UNRECOGNISED state is treated as live: we
//      refuse to delete a job we cannot classify.
//   3. A FAILED TICK NO LONGER KILLS THE LOOP. Nothing else drives this lane, so
//      a single transient sweep error must not end the heartbeat — but an
//      endlessly failing sweep must not spin silently either. A tick failure
//      therefore reschedules under a BOUNDED consecutive-failure budget carried
//      on the job itself, and the loop stops loudly once that budget is spent
//      (the job goes terminal, which the reseed path above can then legitimately
//      replace).
//
// EVERY RULE HERE IS PURE AND DIRECTLY UNIT-TESTED
// (src/lib/__tests__/me-poll-singleton-continuation.test.js). That is deliberate:
// the previous design's failure was invisible in production for three weeks and
// could not be reproduced without a live Redis, so the liveness contract is now
// expressed as functions whose every branch is provable in CI.
//
// Dependency-free by design — type-only imports, no env, no queue-contracts —
// so the contract is importable by the test runner and by both callers (the boot
// seed and the admin reseed endpoint) without dragging worker boot state in.
//
// SOC 2 CC7.2 (the harvester is provably self-healing and cannot silently die)
// / CC8.1 (every reseed decision reports the state it observed and why it acted).
// =============================================================================

import type { Job, Queue } from 'bullmq';

/** The one deterministic id the perpetual heartbeat occupies, forever. */
export const ME_POLL_JOB_ID = 'me-poll-singleton';

/**
 * Delay between heartbeat ticks. 60s — LALAL.AI completes a feature in minutes,
 * so this bounds worst-case background harvest latency to ≤60s while costing one
 * Base44 fn call per minute. The editor's own client poll remains the
 * instant-feedback path for an open tab.
 */
export const ME_POLL_TICK_DELAY_MS = 60_000;

/**
 * How many CONSECUTIVE failing ticks the loop tolerates before it stops and goes
 * terminal for human attention. Bounded on purpose: unbounded self-rescheduling
 * through a permanent failure would burn a Base44 invoke every minute forever
 * and report nothing, while stopping on the FIRST failure is what left this lane
 * dependent on a manual reseed. Five ticks ≈ five minutes of transient tolerance.
 */
export const ME_POLL_MAX_CONSECUTIVE_TICK_FAILURES = 5;

/**
 * States in which the incumbent singleton is LIVE and must never be removed.
 * `delayed` is the state a HEALTHY poller occupies between ticks under the
 * moveToDelayed continuation — treating it as anything else would let a reseed
 * evict the working heartbeat, which is the exact mistake the GLTV cascade
 * watchdog had to correct (D-8).
 */
export const LIVE_POLLER_STATES: readonly string[] = [
  'active', 'waiting', 'waiting-children', 'delayed', 'prioritized', 'paused',
];

/** States in which the incumbent is finished and its id is safe to reclaim. */
export const TERMINAL_POLLER_STATES: readonly string[] = ['completed', 'failed'];

export type PollerReseedAction = 'no_op' | 'replace' | 'seed';

export interface PollerReseedDecision {
  action: PollerReseedAction;
  reason: string;
  observed_state: string | null;
}

/**
 * Decide what a reseed may do, from the incumbent singleton's state alone.
 *
 * `null`/absent  → seed    (no incumbent; the loop genuinely needs starting)
 * live state     → no_op   (a working poller is never disturbed or duplicated)
 * terminal state → replace (remove the spent record, then add a fresh tick)
 * unknown state  → no_op   (fail-safe: never delete a job we cannot classify)
 */
export function classifyPollerReseed(state: string | null | undefined): PollerReseedDecision {
  if (state === null || state === undefined || state === '') {
    return { action: 'seed', reason: 'no_incumbent_poller', observed_state: null };
  }
  const s = String(state);
  if (LIVE_POLLER_STATES.includes(s)) {
    return { action: 'no_op', reason: `poller_live:${s}`, observed_state: s };
  }
  if (TERMINAL_POLLER_STATES.includes(s)) {
    return { action: 'replace', reason: `stale_terminal_poller:${s}`, observed_state: s };
  }
  // BullMQ reports 'unknown' for an id whose hash exists but whose state cannot
  // be resolved. Removing it could destroy a live poller, so we stand down and
  // let the next reseed (or the running tick itself) settle the question.
  return { action: 'no_op', reason: `poller_state_unrecognised:${s}`, observed_state: s };
}

export interface PollTickOutcome {
  action: 'reschedule' | 'stop';
  next_consecutive_failures: number;
  delay_ms: number;
  reason: string;
}

/**
 * Decide what a tick does after its sweep, and what failure state it carries
 * forward. A successful sweep always reschedules and always resets the budget,
 * so a healthy loop runs indefinitely; a failing sweep reschedules until the
 * bounded budget is spent, then stops loudly.
 */
export function decidePollTick(input: {
  sweep_ok: boolean;
  consecutive_failures?: number | null;
}): PollTickOutcome {
  const prior = Number(input.consecutive_failures);
  const carried = Number.isFinite(prior) && prior > 0 ? Math.floor(prior) : 0;

  if (input.sweep_ok) {
    return {
      action: 'reschedule',
      next_consecutive_failures: 0,
      delay_ms: ME_POLL_TICK_DELAY_MS,
      reason: 'sweep_ok',
    };
  }

  const next = carried + 1;
  if (next >= ME_POLL_MAX_CONSECUTIVE_TICK_FAILURES) {
    return {
      action: 'stop',
      next_consecutive_failures: next,
      delay_ms: 0,
      reason: `consecutive_tick_failures_exhausted:${next}/${ME_POLL_MAX_CONSECUTIVE_TICK_FAILURES}`,
    };
  }
  return {
    action: 'reschedule',
    next_consecutive_failures: next,
    delay_ms: ME_POLL_TICK_DELAY_MS,
    reason: `sweep_failed_retrying:${next}/${ME_POLL_MAX_CONSECUTIVE_TICK_FAILURES}`,
  };
}

export interface ReseedResult extends PollerReseedDecision {
  job_id: string;
  seeded: boolean;
}

/**
 * Seed or reseed the singleton through the ONLY supported path. Shared verbatim
 * by the boot seed and the admin reseed endpoint so the two can never diverge on
 * what "safe to replace" means.
 *
 * `opts` is supplied by the caller (rather than imported) purely to keep this
 * module dependency-free and unit-testable; callers pass ME_POLL_JOB_OPTIONS.
 */
export async function reseedMEPollSingleton(input: {
  queue: Pick<Queue, 'name' | 'add' | 'getJob'>;
  data: Record<string, unknown>;
  opts?: Record<string, unknown>;
}): Promise<ReseedResult> {
  const { queue, data, opts = {} } = input;

  const existing = (await queue.getJob(ME_POLL_JOB_ID)) as Job | undefined | null;
  let state: string | null = null;
  if (existing) {
    state = await existing.getState().then((s: string) => String(s)).catch(() => 'unknown');
  }

  const decision = classifyPollerReseed(existing ? state : null);

  if (decision.action === 'no_op') {
    return { ...decision, job_id: ME_POLL_JOB_ID, seeded: false };
  }

  if (decision.action === 'replace' && existing) {
    // Safe by construction: only reached for a state in TERMINAL_POLLER_STATES.
    await existing.remove();
  }

  await queue.add(queue.name, data, { ...opts, jobId: ME_POLL_JOB_ID, delay: 0 });
  return { ...decision, job_id: ME_POLL_JOB_ID, seeded: true };
}
