import { UnrecoverableError, type Job } from 'bullmq';
import type { MediaProbeJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat } from '../base44-client.js';

const PROBE_TIMEOUT_MS = 90_000;

export async function processMediaProbe(job: Job<MediaProbeJobData>) {
  const started = Date.now();
  const data = job.data;
  try {
    const result = await runWithLockHeartbeat(job, async signal => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(`${data.railway_url.replace(/\/+$/, '')}/probe-media`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.railway_api_key}`, 'X-Request-Id': data.request_id },
          body: JSON.stringify({ project_id: data.project_id, source_url: data.source_url }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
      const text = await response.text();
      if (response.status >= 400 && response.status < 500) throw new UnrecoverableError(`media probe rejected: HTTP ${response.status}: ${text.slice(0, 400)}`);
      if (!response.ok) throw new Error(`media probe failed: HTTP ${response.status}: ${text.slice(0, 400)}`);
      const metadata = JSON.parse(text);
      return await invokeBase44Function({
        fn: 'mediaProbeWorkerStep', authToken: data.auth_token, signal, timeoutMs: 90_000,
        payload: { project_id: data.project_id, action: 'complete', source_media_sha256: data.source_media_sha256, metadata },
      });
    });
    await logEvent({ function_name: 'bullmq:media-probe', event: 'media_probe_completed', duration_ms: Date.now() - started, context: { project_id: data.project_id, request_id: data.request_id } });
    return result;
  } catch (error) {
    const terminal = error instanceof UnrecoverableError || job.attemptsMade + 1 >= Number(job.opts.attempts || 1);
    await logEvent({ function_name: 'bullmq:media-probe', level: terminal ? 'error' : 'warn', event: terminal ? 'media_probe_failed' : 'media_probe_retrying', message: String((error as Error).message || error), context: { project_id: data.project_id, request_id: data.request_id, attempt: job.attemptsMade + 1 } });
    if (terminal) {
      await invokeBase44Function({ fn: 'mediaProbeWorkerStep', authToken: data.auth_token, timeoutMs: 90_000, payload: { project_id: data.project_id, action: 'fail', source_media_sha256: data.source_media_sha256, error_message: String((error as Error).message || error).slice(0, 500) } }).catch(() => {});
    }
    throw error;
  }
}
