// =============================================================================
// ME-POLL AUTH — the harvester's credential, minted FRESH ON EVERY TICK.
// -----------------------------------------------------------------------------
// WHY THIS MODULE EXISTS (incident 2026-08-26, root-caused 2026-08-27).
//
// The M&E heartbeat is one perpetual job that reschedules itself every 60s and
// is never meant to end. It carried a STATIC bearer JWT on its own job data,
// minted with a 6-hour TTL by whichever path seeded it. The JOB survives
// forever; the CREDENTIAL does not.
//
// So six hours after every seed, every sweep began failing authentication. The
// bounded consecutive-failure budget (5 ticks) was spent in five minutes, the
// singleton correctly went terminal — and nothing re-seeded it until the next
// Railway deploy happened to run the boot seed. Measured from the sweep audit
// trail: life 1 died 2026-08-26T05:04:20Z and stayed dead 18h 14m; life 2 died
// 2026-08-27T05:17:58Z, exactly 360 minutes after its reseed — the TTL, to the
// second. LALAL.AI kept finishing separations that nothing harvested, and two
// GLTV API jobs were failed by our own fail-closed 6-hour M&E gate while their
// M&E was already complete at the provider.
//
// THE FIX REMOVES THE FAILURE CLASS RATHER THAN EXTENDING IT.
// This worker already holds ENQUEUE_SECRET — the very secret the token is signed
// with — so there is no reason for it to reuse a token someone else minted hours
// ago. Each tick mints its own short-lived token immediately before the sweep.
// A perpetual loop then holds no expiring credential at all, so "the heartbeat
// outlived its token" is structurally impossible instead of merely rarer, and a
// 6-hour bearer token no longer sits in Redis at rest.
//
// A LONGER TTL WAS REJECTED. It would have made this bug reappear on a slower
// clock — the identical failure with a longer fuse, which is strictly worse
// because it is harder to catch. The credential's lifetime must be shorter than
// the loop's, not longer.
//
// THE CARRIED TOKEN IS RETAINED AS A FALLBACK ONLY, for the one case where
// minting is impossible (ENQUEUE_SECRET unset in this process). It is never
// preferred, and the tick records WHICH source it used so an auditor can tell a
// self-minted tick from a legacy carried-token tick from the log alone.
//
// The decision rule is pure and unit-tested
// (src/lib/__tests__/me-poll-heartbeat-policy.test.js) because both prior
// failures of this lane were unreproducible without a live Redis.
//
// SOC 2 CC6.1 (short-lived, fn-scoped, attributable credential; no long-lived
// bearer at rest) / CC7.2 (the heartbeat cannot die from its own credential).
// =============================================================================

import { createHmac, randomUUID } from 'node:crypto';

/**
 * TTL of a per-tick token. One tick is 60s and a sweep is bounded at 120s, so
 * five minutes is generous headroom while keeping the credential far shorter
 * than the loop it serves — the property whose absence caused the outage.
 */
export const ME_POLL_TICK_JWT_TTL_SECONDS = 5 * 60;

/** TTL used when SEEDING (boot / admin reseed): needs to cover the first tick only. */
export const ME_POLL_SEED_JWT_TTL_SECONDS = 15 * 60;

export type TickAuthSource = 'minted' | 'carried' | 'none';

export interface TickAuthDecision {
  source: TickAuthSource;
  reason: string;
}

/**
 * Choose the credential for THIS tick. Minting always wins when possible; the
 * carried token is a legacy fallback; neither available is a hard, loud failure
 * (a tick that cannot authenticate must never silently look like a quiet sweep).
 */
export function decideTickAuthSource(input: {
  has_secret: boolean;
  has_carried_token: boolean;
}): TickAuthDecision {
  if (input.has_secret) {
    return { source: 'minted', reason: 'minted_fresh_per_tick' };
  }
  if (input.has_carried_token) {
    return {
      source: 'carried',
      reason: 'enqueue_secret_unset_using_carried_token_may_expire',
    };
  }
  return { source: 'none', reason: 'no_enqueue_secret_and_no_carried_token' };
}

function b64url(input: string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint a JWT bound to fn='pollMEStatus' — the exact claim shape
 * pollMEStatus.verifyMEPollJWT enforces, and identical to the Base44-side signer
 * in base44/shared/me-poll-heartbeat.ts. ONE signer per side, shared by the boot
 * seed and the tick, so a claim or rotation change cannot land partially.
 */
export function mintMEPollJWT(
  secret: string,
  sub = 'me-poll-worker',
  ttlSeconds: number = ME_POLL_TICK_JWT_TTL_SECONDS,
): string {
  if (!secret) throw new Error('me-poll: cannot mint JWT without WORKER_ENQUEUE_SECRET');
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const pay = b64url(JSON.stringify({
    sub,
    fn: 'pollMEStatus',
    iat: now,
    exp: now + ttlSeconds,
    jti: randomUUID(),
  }));
  const sig = createHmac('sha256', secret).update(`${head}.${pay}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${head}.${pay}.${sig}`;
}
