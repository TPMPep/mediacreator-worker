// =============================================================================
// ME-POLL BOOT SEED — Self-starts the perpetual M&E poll heartbeat at worker
// boot, with ZERO dependency on any Base44 call.
// -----------------------------------------------------------------------------
// This is what makes the M&E harvester fully PORTABLE and self-starting: the
// worker holds WORKER_ENQUEUE_SECRET (env.ENQUEUE_SECRET) and Redis, so it can
// mint the fn-scoped JWT and enqueue the singleton 'me-poll' job itself — no
// Base44 cron, no manual seed step. After the first tick the me-poll processor
// re-enqueues itself forever (deterministic jobId), so this only needs to run
// once per deploy; the deterministic jobId makes a re-seed across restarts a
// BullMQ no-op while a tick is pending.
//
// The Base44 fn `enqueueMEPoll` remains as the ADMIN reseed path (refresh a lost
// loop / rotate the JWT from the Compliance panel without a redeploy) — same
// jobId, so the two paths never produce two loops.
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

const ME_POLL_JOB_ID = 'me-poll-singleton';
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
    await q.add(
      QUEUE_NAMES.ME_POLL,
      { schema_version: JOB_SCHEMA_VERSION, request_id: `boot-${randomUUID()}`, auth_token: authToken },
      { ...ME_POLL_JOB_OPTIONS, jobId: ME_POLL_JOB_ID },
    );
    console.log('[me-poll-seed] M&E poll heartbeat seeded at boot.');
    await logEvent({
      function_name: 'bullmq:me-poll-seed',
      level: 'info',
      event: 'me_poll_boot_seeded',
      message: 'M&E poll heartbeat seeded at worker boot (self-starting, no Base44 cron).',
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
