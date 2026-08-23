// =============================================================================
// ME-POLL BOOT SEED — Self-starts the perpetual M&E poll heartbeat at worker
// boot, with ZERO dependency on any Base44 call.
// -----------------------------------------------------------------------------
// This is what makes the M&E harvester fully PORTABLE and self-starting: the
// worker holds WORKER_ENQUEUE_SECRET (env.ENQUEUE_SECRET) and Redis, so it can
// mint the fn-scoped JWT and seed the singleton 'me-poll' job itself — no
// Base44 cron, no manual seed step. After the first tick the me-poll processor
// keeps the SAME job alive forever via moveToDelayed, so this only needs to run
// once per deploy.
//
// STATE-AWARE SEEDING (2026-08-22). This used to call `queue.add()` blindly and
// rely on the deterministic jobId making a duplicate a "no-op". That reasoning
// was wrong in the one case that mattered: a jobId held by a STALE COMPLETED
// record is not reusable either, and BullMQ's `removeOnComplete` eviction is
// lazy (it runs when a LATER job completes — which never happens on a
// single-job queue). So every boot seed for three weeks silently collapsed
// against a dead singleton while reporting success. Seeding now goes through
// reseedMEPollSingleton, which inspects the incumbent first and only replaces a
// provably TERMINAL one, never a live/delayed poller.
//
// The Base44 fn `enqueueMEPoll` remains the ADMIN reseed path (restore a lost
// loop / rotate the JWT without a redeploy) and calls the worker's
// /me-poll/reseed endpoint, which runs THIS SAME routine — so the two paths can
// neither diverge nor produce two loops.
//
// AUTH: mints a JWT bound to fn='pollMEStatus' (fn-scoped only — a sweep touches
// many projects). pollMEStatus.verifyMEPollJWT enforces the signature + fn claim.
// Long TTL because this is a perpetual heartbeat; a deploy reseeds it.
// =============================================================================

import { createHmac, randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES, ME_POLL_JOB_OPTIONS, JOB_SCHEMA_VERSION } from '../shared/queue-contracts.js';
import { env } from './env.js';
import { logEvent } from './base44-client.js';
import { reseedMEPollSingleton } from './me-poll-singleton.js';

const ME_POLL_JWT_TTL_SECONDS = 6 * 60 * 60; // 6h — reseeded each deploy.

function b64url(input: string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Mint a JWT bound to fn='pollMEStatus' — identical shape to the Base44
// enqueueMEPoll producer, signed with the same shared secret.
function mintMEPollJWT(secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const pay = b64url(JSON.stringify({
    sub: 'me-poll-worker-boot',
    fn: 'pollMEStatus',
    iat: now,
    exp: now + ME_POLL_JWT_TTL_SECONDS,
    jti: randomUUID(),
  }));
  const sig = createHmac('sha256', secret).update(`${head}.${pay}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${head}.${pay}.${sig}`;
}

/**
 * Seed the perpetual M&E poll heartbeat at boot. Best-effort: a failure here
 * (e.g. ENQUEUE_SECRET unset) must NOT crash the worker — the admin enqueueMEPoll
 * path can still seed it. Logs loudly so a missing secret is visible at deploy.
 */
export async function seedMEPollHeartbeat(getQueue: (name: string) => Queue): Promise<void> {
  try {
    const secret = env.ENQUEUE_SECRET;
    if (!secret) {
      console.warn('[me-poll-seed] WORKER_ENQUEUE_SECRET not set — skipping boot seed. M&E harvester will NOT run until enqueueMEPoll is called or the secret is set.');
      await logEvent({
        function_name: 'bullmq:me-poll-seed',
        level: 'warn',
        event: 'me_poll_boot_seed_skipped',
        message: 'WORKER_ENQUEUE_SECRET missing — M&E poll heartbeat not seeded at boot.',
      });
      return;
    }
    const q = getQueue(QUEUE_NAMES.ME_POLL);
    const authToken = mintMEPollJWT(secret);
    const result = await reseedMEPollSingleton({
      queue: q,
      data: {
        schema_version: JOB_SCHEMA_VERSION,
        request_id: `boot-${randomUUID()}`,
        auth_token: authToken,
        consecutive_failures: 0,
      },
      opts: ME_POLL_JOB_OPTIONS,
    });
    console.log(`[me-poll-seed] boot seed: action=${result.action} reason=${result.reason} observed_state=${result.observed_state ?? 'none'}`);
    await logEvent({
      function_name: 'bullmq:me-poll-seed',
      level: 'info',
      event: result.seeded ? 'me_poll_boot_seeded' : 'me_poll_boot_seed_skipped_live',
      message: result.seeded
        ? `M&E poll heartbeat seeded at worker boot (${result.reason}).`
        : `M&E poll heartbeat already live at boot (${result.reason}) — left untouched.`,
      context: { action: result.action, reason: result.reason, observed_state: result.observed_state, job_id: result.job_id },
    });
  } catch (err) {
    console.error('[me-poll-seed] boot seed failed (non-fatal):', (err as Error).message);
    await logEvent({
      function_name: 'bullmq:me-poll-seed',
      level: 'error',
      event: 'me_poll_boot_seed_failed',
      message: (err as Error).message,
    }).catch(() => {});
  }
}
