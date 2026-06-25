// =============================================================================
// ME-POLL PROCESSOR — Perpetual, self-rescheduling M&E extraction harvester.
// -----------------------------------------------------------------------------
// PORTABILITY ANCHOR. The M&E (Music & Effects) pipeline submits a split job to
// LALAL.AI (a stateful hosted source-separation service) and pins a token on
// Project.export_status. LALAL processes server-side (minutes) and does NOT call
// back — something must poll /check and harvest the finished stems into S3.
//
// Every OTHER heavy pipeline lives in this worker repo (translation, voice-gen,
// proxy, cascade, CC) so it survives leaving Base44. The M&E harvester's
// SCHEDULER now lives HERE too — as a single perpetual self-rescheduling job —
// instead of a Base44-platform scheduled automation. That makes M&E exactly as
// portable as the rest: the heartbeat is git-versioned and runs on Railway.
//
// ZERO FINALIZE DRIFT. This processor holds NO harvest logic. It calls the
// Base44 fn `pollMEStatus` in SWEEP MODE (no project_id) once per tick; that
// function lists every Project with an active me_lalal token and drives each
// forward (LALAL /check → download M&E + vocals stems → S3 → finalize Project →
// delete LALAL source → CostLog). pollMEStatus is the SINGLE source of truth,
// shared with the editor's live per-project poll — so there is exactly one
// harvest implementation. The only Base44 touch is the same data-layer write
// every processor crosses via base44-client.
//
// SELF-RESCHEDULE. After each tick the worker re-enqueues ITSELF with the
// deterministic jobId 'me-poll-singleton' after ME_POLL_TICK_DELAY_MS, so there
// is always exactly ONE perpetual heartbeat (a duplicate enqueue with the same
// jobId is a BullMQ no-op while the prior job is pending). The producer
// `enqueueMEPoll` seeds it once at deploy and reseeds periodically with a fresh
// JWT (the carried token has a long TTL but reseed guarantees liveness).
//
// AUTH. A scoped JWT bound to (fn='pollMEStatus'), forwarded verbatim as
// X-Worker-JWT. Because a sweep touches MANY projects, the token is fn-scoped
// only; pollMEStatus verifies the signature + fn claim, then acts as
// service-role (same trust envelope as the admin-scheduled path it replaces).
//
// SOC 2 CC7.2 — browser-independent, resumable (reseed restores a lost loop).
// CC8.1 — pollMEStatus owns the per-project audit + cost trail.
// =============================================================================

import type { Job, Queue } from 'bullmq';
import type { MEPollJobData } from '../../shared/queue-contracts.js';
import { QUEUE_NAMES, ME_POLL_JOB_OPTIONS } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat, WorkerLockLostError } from '../base44-client.js';

// One sweep can chain several pollMEStatus harvests internally (the function
// loops over all active projects). Give it a generous budget; a stuck LALAL
// /check is bounded inside pollMEStatus per project.
const SWEEP_CALL_TIMEOUT_MS = 120_000;
// Delay before re-enqueueing the next heartbeat tick. 60s — LALAL Studio on a
// feature film completes in a few minutes, so a 60s sweep bounds worst-case
// background harvest latency to ≤60s while keeping Base44 invoke pressure
// negligible (one fn call/min). The editor's 8s client poll remains the
// instant-feedback path for open tabs.
const ME_POLL_TICK_DELAY_MS = 60_000;
// Deterministic id so there is only ever ONE perpetual heartbeat. A re-enqueue
// with the same id while the prior job is still pending/delayed is a no-op.
const ME_POLL_JOB_ID = 'me-poll-singleton';

interface SweepResponse {
  ok?: boolean;
  mode?: string;
  summary?: {
    scanned?: number;
    harvested?: number;
    still_processing?: number;
    failed?: number;
    orphaned?: number;
    reaped?: number;
  };
}

export function makeMEPollProcessor(getQueue: (name: string) => Queue) {
  return async function processMEPoll(job: Job<MEPollJobData>) {
    const t0 = Date.now();
    const { request_id, auth_token } = job.data;
    const baseCtx = { request_id, bullmq_job_id: job.id, attempts: job.attemptsMade + 1 };

    if (!auth_token) {
      await logEvent({
        function_name: 'bullmq:me-poll',
        level: 'error',
        event: 'me_poll_missing_auth_token',
        message: 'ME-poll tick arrived without auth_token — reseed required via enqueueMEPoll.',
        context: baseCtx,
      });
      throw new Error('me-poll: missing auth_token (reseed via enqueueMEPoll)');
    }

    try {
      return await runWithLockHeartbeat(job, async (signal) => {
        // ── 1. One sweep: pollMEStatus in SWEEP MODE harvests every active
        //       extraction (it owns the list + per-project finalize loop). ──
        const sweep = await invokeBase44Function<SweepResponse>({
          fn: 'pollMEStatus',
          authToken: auth_token,
          payload: { mode: 'sweep', request_id },
          timeoutMs: SWEEP_CALL_TIMEOUT_MS,
          signal,
        });

        const s = sweep?.summary || {};
        await logEvent({
          function_name: 'bullmq:me-poll',
          level: 'info',
          event: 'me_poll_tick_done',
          message: `M&E sweep: scanned=${s.scanned ?? 0} harvested=${s.harvested ?? 0} processing=${s.still_processing ?? 0} failed=${s.failed ?? 0} orphaned=${s.orphaned ?? 0} reaped=${s.reaped ?? 0}`,
          duration_ms: Date.now() - t0,
          context: { ...baseCtx, ...s },
        });

        // ── 2. Re-enqueue the next perpetual tick (carry the same token). ──
        const q = getQueue(QUEUE_NAMES.ME_POLL);
        await q.add(
          QUEUE_NAMES.ME_POLL,
          { schema_version: job.data.schema_version, request_id, auth_token },
          { ...ME_POLL_JOB_OPTIONS, jobId: ME_POLL_JOB_ID, delay: ME_POLL_TICK_DELAY_MS },
        );

        return { ok: true, summary: s, duration_ms: Date.now() - t0 };
      });
    } catch (err) {
      const e = err as Error;
      const lockLost = e instanceof WorkerLockLostError;
      console.error(`[bullmq:me-poll] ${lockLost ? 'lock_lost' : 'tick_failed'} job=${job.id} attempt=${job.attemptsMade + 1} duration_ms=${Date.now() - t0} message=${String(e.message || '').slice(0, 400)}`);
      await logEvent({
        function_name: 'bullmq:me-poll',
        level: lockLost ? 'warn' : 'error',
        event: lockLost ? 'me_poll_lock_lost' : 'me_poll_failed',
        message: e.message,
        context: { ...baseCtx, error_kind: lockLost ? 'lock_lost' : e.name },
      });
      // attempts:1 — a failed tick is NOT BullMQ-retried (that would risk a
      // second perpetual loop). The next reseed from enqueueMEPoll restores the
      // heartbeat. On a lock-loss the BullMQ reclaim owns the single re-run.
      throw err;
    }
  };
}
