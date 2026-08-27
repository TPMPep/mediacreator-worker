// =============================================================================
// ME-POLL PROCESSOR — Perpetual M&E extraction harvester (ONE persistent job).
// -----------------------------------------------------------------------------
// PORTABILITY ANCHOR. The M&E (Music & Effects) pipeline submits a split job to
// LALAL.AI (a stateful hosted source-separation service) and pins a token on
// Project.export_status. LALAL processes server-side (minutes) and does NOT call
// back — something must poll /check and harvest the finished stems into S3.
//
// Every OTHER heavy pipeline lives in this worker repo (translation, voice-gen,
// proxy, cascade, CC) so it survives leaving Base44. The M&E harvester's
// SCHEDULER lives HERE too, as a single perpetual job, so M&E is exactly as
// portable as the rest: the heartbeat is git-versioned and runs on Railway.
//
// ZERO FINALIZE DRIFT. This processor holds NO harvest logic. It calls the
// Base44 fn `pollMEStatus` in SWEEP MODE (no project_id) once per tick; that
// function lists every Project with an active me_lalal token and drives each
// forward (LALAL /check → download M&E + vocals stems → S3 → finalize Project →
// delete LALAL source → CostLog). pollMEStatus is the SINGLE source of truth,
// shared with the editor's live per-project poll.
//
// ── CONTINUATION: moveToDelayed, NEVER add() (2026-08-22) ───────────────────
// This tick reschedules ITSELF via `job.moveToDelayed`, the pattern already
// proven for the GLTV cascade (D-5). It does NOT enqueue a new job.
//
// The previous design ended each tick with `queue.add()` under the SAME
// deterministic id, and that is a deadlock rather than an idempotent no-op: the
// id only becomes reusable once the prior job is EVICTED, and BullMQ evicts on
// `removeOnComplete` LAZILY — when a LATER job in the same queue completes. On a
// queue whose only job IS the singleton, that later completion never comes.
// Measured in production: the last tick completed 2026-08-01T06:28:31Z, its
// record was never evicted, and every re-add for the next three weeks — this
// processor's own continuation, the boot seed on each deploy, and the admin
// reseed — silently collapsed while all three reported success. LALAL kept
// finishing separations that nothing ever harvested, so any GLTV cascade with
// M&E enabled sat at its fail-closed M&E gate indefinitely.
//
// With moveToDelayed the single job persists forever, occupying its id AS THE
// LIVE POLLER, so liveness no longer depends on an eviction having happened. See
// src/me-poll-singleton.ts for the full contract and its unit tests.
//
// ── A FAILED TICK NO LONGER KILLS THE LOOP ──────────────────────────────────
// Nothing else drives this lane, so ending the heartbeat on one transient sweep
// error is what made the harvester dependent on a manual reseed. A failed tick
// now reschedules under a BOUNDED consecutive-failure budget carried on the job
// itself, and the loop stops loudly only once that budget is spent — at which
// point the job goes terminal and the reseed path may legitimately replace it.
// A LOST LOCK is never counted as a tick failure: BullMQ's reclaim owns that
// re-run, and consuming budget for it would punish a pod recycle.
//
// AUTH. A scoped JWT bound to (fn='pollMEStatus'), forwarded verbatim as
// X-Worker-JWT and carried across reschedules on the job's own data. Because a
// sweep touches MANY projects the token is fn-scoped only; pollMEStatus verifies
// the signature + fn claim, then acts as service-role.
//
// SOC 2 CC7.2 — browser-independent, self-healing, and provably unable to die
// silently. CC8.1 — pollMEStatus owns the per-project audit + cost trail.
// =============================================================================

import { DelayedError, type Job, type Queue } from 'bullmq';
import type { MEPollJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat, WorkerLockLostError } from '../base44-client.js';
import { env } from '../env.js';
import { decidePollTick, ME_POLL_JOB_ID } from '../me-poll-singleton.js';
import { decideTickAuthSource, mintMEPollJWT } from '../me-poll-auth.js';

// One sweep can chain several pollMEStatus harvests internally (the function
// loops over all active projects). Give it a generous budget; a stuck LALAL
// /check is bounded inside pollMEStatus per project.
const SWEEP_CALL_TIMEOUT_MS = 120_000;

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

export function makeMEPollProcessor(_getQueue: (name: string) => Queue) {
  // getQueue is no longer needed for continuation (the job reschedules itself
  // rather than enqueueing a sibling), but the factory signature is kept so the
  // worker registration in index.ts is unchanged.
  return async function processMEPoll(job: Job<MEPollJobData>, token?: string) {
    const t0 = Date.now();
    const { request_id, auth_token } = job.data;
    const baseCtx = {
      request_id,
      bullmq_job_id: job.id,
      attempts: job.attemptsMade + 1,
      consecutive_failures: job.data.consecutive_failures ?? 0,
    };

    // ── CREDENTIAL: minted FRESH for this tick whenever we can. ──────────────
    // A perpetual loop must not depend on a token someone else minted hours ago.
    // Carrying a 6h JWT on job data is what killed this heartbeat every six
    // hours (see ../me-poll-auth.ts for the measured incident): the job outlives
    // its credential, every sweep then 401s, and the bounded failure budget
    // terminalises the singleton. Minting per tick removes that class entirely.
    const authDecision = decideTickAuthSource({
      has_secret: !!env.ENQUEUE_SECRET,
      has_carried_token: !!auth_token,
    });
    if (authDecision.source === 'none') {
      await logEvent({
        function_name: 'bullmq:me-poll',
        level: 'error',
        event: 'me_poll_missing_auth_token',
        message: 'ME-poll tick has neither WORKER_ENQUEUE_SECRET (to mint) nor a carried auth_token — cannot authenticate the sweep.',
        context: { ...baseCtx, ...authDecision },
      });
      throw new Error('me-poll: no signing secret and no carried auth_token (set WORKER_ENQUEUE_SECRET or reseed via enqueueMEPoll)');
    }
    const tickToken = authDecision.source === 'minted'
      ? mintMEPollJWT(env.ENQUEUE_SECRET as string)
      : (auth_token as string);
    if (authDecision.source === 'carried') {
      await logEvent({
        function_name: 'bullmq:me-poll',
        level: 'warn',
        event: 'me_poll_tick_using_carried_token',
        message: 'ME-poll tick could not mint its own credential and is reusing the seeded token, which WILL expire and end the heartbeat. Set WORKER_ENQUEUE_SECRET on the worker.',
        context: { ...baseCtx, ...authDecision },
      });
    }

    try {
      return await runWithLockHeartbeat(job, async (signal) => {
        // ── 1. One sweep: pollMEStatus in SWEEP MODE harvests every active
        //       extraction (it owns the list + per-project finalize loop). ──
        let summary: SweepResponse['summary'] = {};
        let sweepError: Error | null = null;
        try {
          const sweep = await invokeBase44Function<SweepResponse>({
            fn: 'pollMEStatus',
            authToken: tickToken,
            payload: { mode: 'sweep', request_id },
            timeoutMs: SWEEP_CALL_TIMEOUT_MS,
            signal,
          });
          summary = sweep?.summary || {};
        } catch (err) {
          // A lock loss aborts the invocation through `signal`. That is NOT a
          // sweep failure — BullMQ's reclaim owns the re-run — so it escapes to
          // the outer handler untouched and consumes no failure budget.
          if (signal.aborted) throw err;
          sweepError = err as Error;
        }

        const decision = decidePollTick({
          sweep_ok: !sweepError,
          consecutive_failures: job.data.consecutive_failures,
        });

        if (sweepError) {
          await logEvent({
            function_name: 'bullmq:me-poll',
            level: decision.action === 'stop' ? 'error' : 'warn',
            event: decision.action === 'stop' ? 'me_poll_tick_budget_exhausted' : 'me_poll_tick_failed_retrying',
            message: `M&E sweep failed (${decision.reason}): ${String(sweepError.message || '').slice(0, 300)}`,
            duration_ms: Date.now() - t0,
            context: { ...baseCtx, ...decision },
          });
          // Budget spent — stop rescheduling and go terminal so a human sees it
          // and the supported reseed path can replace a provably dead singleton.
          if (decision.action === 'stop') throw sweepError;
        } else {
          const s = summary || {};
          await logEvent({
            function_name: 'bullmq:me-poll',
            level: 'info',
            event: 'me_poll_tick_done',
            message: `M&E sweep: scanned=${s.scanned ?? 0} harvested=${s.harvested ?? 0} processing=${s.still_processing ?? 0} failed=${s.failed ?? 0} orphaned=${s.orphaned ?? 0} reaped=${s.reaped ?? 0}`,
            duration_ms: Date.now() - t0,
            context: { ...baseCtx, ...s },
          });
        }

        // ── 2. Reschedule THIS job for the next tick (no add(), ever). ──
        // Without the BullMQ lock token the job cannot be parked as delayed. Fail
        // loudly rather than returning: a silent return would COMPLETE the job
        // and end the heartbeat, which is precisely the failure mode this
        // rewrite exists to remove.
        if (!token) {
          await logEvent({
            function_name: 'bullmq:me-poll',
            level: 'error',
            event: 'me_poll_missing_lock_token',
            message: 'ME-poll tick cannot self-reschedule without a BullMQ lock token — failing loudly so the singleton goes terminal and can be reseeded.',
            context: baseCtx,
          });
          throw new Error(`me-poll: missing BullMQ lock token for job ${job.id ?? ME_POLL_JOB_ID} — cannot reschedule tick`);
        }

        // Carry the failure budget forward on the job itself, so the bound
        // survives a pod recycle and is readable from the job payload.
        //
        // The seeded token is DROPPED once we can mint our own: keeping it would
        // leave a bearer credential sitting in Redis for its whole TTL with
        // nothing reading it, and would preserve the very fallback path whose
        // expiry killed this loop twice. auth_source is persisted so an operator
        // can see from the job payload which credential path a live tick used.
        await job.updateData({
          ...job.data,
          auth_token: authDecision.source === 'minted' ? undefined : job.data.auth_token,
          auth_source: authDecision.source,
          consecutive_failures: decision.next_consecutive_failures,
        });

        // Reschedule self, then signal BullMQ the job was delayed rather than
        // finished. Done LAST so the lock-heartbeat loop never extends a lock we
        // have already released.
        await job.moveToDelayed(Date.now() + decision.delay_ms, token);
        throw new DelayedError();
      });
    } catch (err) {
      // A DelayedError is the successful self-reschedule path, not a failure:
      // rethrow it untouched so BullMQ parks the job in `delayed` without
      // consuming an attempt or writing a failure record.
      if (err instanceof DelayedError) throw err;
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
      // attempts:1 — a spent-budget failure is NOT BullMQ-retried. The singleton
      // becomes terminal, which the state-aware reseed path is allowed to
      // replace. On a lock-loss the BullMQ reclaim owns the single re-run.
      throw err;
    }
  };
}
