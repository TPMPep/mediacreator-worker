// =============================================================================
// voice-drift — marks a speaker's already-rendered dubs stale after that
// speaker's voice configuration changed for one target language.
// -----------------------------------------------------------------------------
// This lane exists because the work used to run INLINE inside
// saveVoiceAssignment: the save paged every transcript row and every
// translation row in the project and bulk-flipped the drifted ones, all inside
// one HTTP request. Its call volume scaled with PROJECT SIZE while the save
// itself is a fixed handful of writes, so on a feature-length project under
// concurrency the platform rate-limited the very request that had already
// passed every authorization and locking gate. Worse, a partial pass left some
// dubs marked 'ready' while their audio no longer matched the saved voice, and
// the only record was a best-effort "may be incomplete" boolean.
//
// The worker is pure transport, as in every other lane here: the brain
// (voiceDriftWorkerStep) owns the judgement, the cursor and the pass
// sequencing, and this processor only ticks it and heartbeats the lock.
// =============================================================================

import type { Job } from 'bullmq';
import type { VoiceDriftJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat } from '../base44-client.js';
import { BUILD_TAG } from '../build-tag.js';

interface Step {
  action: 'continue' | 'done' | 'failed';
  status?: string;
  pass?: number;
  verified?: boolean;
  drifted_count?: number;
}

export async function processVoiceDrift(job: Job<VoiceDriftJobData>) {
  const { project_id, run_id, user_email, request_id, auth_token } = job.data;
  if (!auth_token) throw new Error('voice-drift: missing auth token');

  try {
    for (let tick = 1; tick <= 10000; tick++) {
      const step = await runWithLockHeartbeat(job, (signal) => invokeBase44Function<Step>({
        fn: 'voiceDriftWorkerStep',
        authToken: auth_token,
        payload: { project_id, run_id, worker_build_tag: BUILD_TAG },
        timeoutMs: 60000,
        signal,
      }));

      if (tick === 1 || tick % 10 === 0 || step.action !== 'continue') {
        await logEvent({
          function_name: 'bullmq:voice-drift',
          event: 'voice_drift_tick',
          context: { project_id, run_id, user_email, request_id, tick, action: step.action, pass: step.pass, verified: step.verified, drifted_count: step.drifted_count },
        });
      }

      if (step.action !== 'continue') {
        return { ok: step.action === 'done', status: step.status, verified: step.verified, drifted_count: step.drifted_count, ticks: tick };
      }
      // Brief pause between ticks: the pass is a read/write burst against the
      // platform, and pacing it is what keeps this lane from becoming the
      // rate-limit pressure it was created to remove.
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error('voice drift tick ceiling exceeded');
  } catch (error) {
    // Only the FINAL attempt terminalizes the run. An earlier transient failure
    // must stay resumable — the rows already flipped stay flipped, which is the
    // safe direction (a stale mark invites a regenerate; a missed one hides
    // audio from a voice nobody chose).
    const finalAttempt = job.attemptsMade + 1 >= Number(job.opts.attempts || 1);
    if (finalAttempt) {
      await invokeBase44Function({
        fn: 'voiceDriftWorkerStep',
        authToken: auth_token,
        payload: { project_id, run_id, action: 'fail', error_message: String((error as Error).message || error) },
        timeoutMs: 30000,
      }).catch(() => {});
    }
    throw error;
  }
}
