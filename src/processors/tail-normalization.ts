import type { Job } from 'bullmq';
import type { TailNormalizationJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat } from '../base44-client.js';

interface Step { action: 'continue' | 'done' | 'failed'; phase?: string; status?: string; }
export async function processTailNormalization(job: Job<TailNormalizationJobData>) {
  const started = Date.now();
  const { project_id, run_id, user_email, request_id, auth_token } = job.data;
  if (!auth_token) throw new Error('tail-normalization: missing auth_token');
  try {
    let ticks = 0;
    while (Date.now() - started < 55 * 60_000) {
      ticks++;
      const step = await runWithLockHeartbeat(job, signal => invokeBase44Function<Step>({
        fn: 'tailNormalizationWorkerStep', authToken: auth_token,
        payload: { project_id, run_id }, timeoutMs: 90_000, signal,
      }));
      await logEvent({ function_name: 'bullmq:tail-normalization', event: 'tail_normalization_tick', context: { project_id, run_id, user_email, request_id, tick: ticks, action: step.action, phase: step.phase } });
      if (step.action !== 'continue') return { ok: step.action === 'done', status: step.status, ticks };
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('tail-normalization wall-clock cap exceeded');
  } catch (error) {
    const finalAttempt = job.attemptsMade + 1 >= Number(job.opts.attempts || 1);
    if (finalAttempt) await invokeBase44Function({ fn: 'tailNormalizationWorkerStep', authToken: auth_token, payload: { project_id, run_id, action: 'fail', error_message: String((error as Error).message || error) }, timeoutMs: 30_000 }).catch(() => {});
    throw error;
  }
}
