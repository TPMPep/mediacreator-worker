import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import type { GltvMEExtractionJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat } from '../base44-client.js';

const LONG_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * A DETERMINISTIC RFC-4122 UUID derived from a seed string (SHA-256), stamped
 * with the VERSION-4 marker because LALAL.AI validates the version nibble and
 * rejects anything else.
 *
 * WHY NOT crypto.randomUUID(). LALAL.AI's idempotency_key exists so that a
 * retried submit cannot start a SECOND billable split for the same source. A
 * random key satisfies the format and destroys that guarantee: this job runs with
 * BullMQ retries and a heartbeat-abort path, so a re-submit after a lock loss or a
 * transient network failure is a routine event, and each one would buy another
 * separation of the same audio.
 *
 * WHY NOT THE PLAIN STRING KEY EITHER. This is the defect being fixed. The submit
 * sent `gltv-me-<dubbing_api_job_id>`, and LALAL.AI rejects it with HTTP 422
 * (`uuid_parsing … invalid character: found 'g' at 1`), so the GLTV M&E path could
 * never succeed at all: every recipe requesting 'standard' or 'high' fidelity
 * reached the fail-closed M&E gate before the mixer and terminalised the job. It
 * presented as an M&E failure, so nothing pointed at a malformed request field.
 *
 * WHY VERSION 4 AND NOT 5. The first fix stamped the v5 marker, which is the
 * honest description of how the value is built (a hash of a name), and LALAL.AI
 * rejected it too: `uuid_version … UUID version 4 expected`. So the provider
 * constrains the FORMAT to v4 while we require DETERMINISM, and those two are
 * only reconcilable one way — derive the bytes from the hash, then stamp the v4
 * marker. Be precise about what that means: this is NOT a random v4 UUID and
 * must never be read as evidence of randomness. It is a deterministic value
 * wearing the version marker the provider demands, and determinism is the
 * property the idempotency guarantee actually rests on, so nothing about the
 * cost-safety claim is weakened by the marker. Collision risk is irrelevant
 * here: the seed already names the exact split input, so two different inputs
 * colliding would require a SHA-256 collision.
 */
function deterministicUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4 marker — required by LALAL.AI
  b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Inspect = { state: 'queued' | 'uploaded' | 'submitted' | 'ready' | 'failed'; source_id?: string | null };

async function uploadSource(job: GltvMEExtractionJobData, signal: AbortSignal) {
  const fidelity = job.fidelity === 'high' ? { format: 'flac', args: '-vn -ac 2', ext: 'flac' } : { format: 'mp3', args: '-vn -ac 2 -b:a 192k', ext: 'mp3' };
  const response = await fetch(`${job.railway_url.replace(/\/+$/, '')}/extract-and-upload-lalal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${job.railway_api_key}` }, signal,
    body: JSON.stringify({ source_url: job.source_url, lalal_key: job.lalal_license_key, output_format: fidelity.format, extra_args: fidelity.args, upload_ext: fidelity.ext, filename_base: `gltv_me_${job.dubbing_api_job_id}` }),
  });
  const data = await response.json().catch(() => ({})) as { source_id?: unknown };
  if (!response.ok || !data.source_id) throw new Error(`M&E source upload failed (${response.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return String(data.source_id);
}
async function startSplit(job: GltvMEExtractionJobData, sourceId: string, signal: AbortSignal) {
  // Seeded on the SPLIT INPUT, not merely the job: a retry of the same uploaded
  // source dedupes against the first submit, while a genuinely re-uploaded source
  // (new source_id) gets its own key rather than being answered with the earlier
  // source's task.
  const idempotencyKey = deterministicUuid(`gltv-me:${job.dubbing_api_job_id}:${job.fidelity}:${sourceId}`);
  const response = await fetch('https://www.lalal.ai/api/v1/split/stem_separator/', { method: 'POST', headers: { 'X-License-Key': job.lalal_license_key, 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ source_id: sourceId, idempotency_key: idempotencyKey, presets: { stem: 'vocals', splitter: 'perseus', enhanced_processing_enabled: true } }) });
  const data = await response.json().catch(() => ({})) as { task_id?: unknown };
  if (!response.ok || !data.task_id) throw new Error(`M&E split submit failed (${response.status}): ${JSON.stringify(data).slice(0, 300)}`);
  return String(data.task_id);
}

export async function processGltvMEExtraction(job: Job<GltvMEExtractionJobData>) {
  const data = job.data; const ctx = { project_id: data.project_id, dubbing_api_job_id: data.dubbing_api_job_id, request_id: data.request_id, bullmq_job_id: job.id };
  try {
    return await runWithLockHeartbeat(job, async (signal) => {
      const providerSignal = AbortSignal.any([signal, AbortSignal.timeout(LONG_TIMEOUT_MS)]);
      const inspect = await invokeBase44Function<Inspect>({ fn: 'gltvMEExtractionWorkerStep', authToken: data.auth_token, payload: { project_id: data.project_id, dubbing_api_job_id: data.dubbing_api_job_id, fidelity: data.fidelity, action: 'inspect', request_id: data.request_id }, timeoutMs: 60000, signal });
      if (inspect.state === 'ready' || inspect.state === 'submitted') return { ok: true, state: inspect.state };
      if (inspect.state === 'failed') throw new Error('M&E project state is already failed');
      let sourceId = inspect.state === 'uploaded' ? inspect.source_id : null;
      if (!sourceId) {
        sourceId = await uploadSource(data, providerSignal);
        await invokeBase44Function({ fn: 'gltvMEExtractionWorkerStep', authToken: data.auth_token, payload: { project_id: data.project_id, dubbing_api_job_id: data.dubbing_api_job_id, fidelity: data.fidelity, action: 'uploaded', source_id: sourceId, request_id: data.request_id }, timeoutMs: 60000, signal });
      }
      const taskId = await startSplit(data, sourceId, providerSignal);
      await invokeBase44Function({ fn: 'gltvMEExtractionWorkerStep', authToken: data.auth_token, payload: { project_id: data.project_id, dubbing_api_job_id: data.dubbing_api_job_id, fidelity: data.fidelity, action: 'submitted', source_id: sourceId, task_id: taskId, request_id: data.request_id }, timeoutMs: 60000, signal });
      await logEvent({ function_name: 'bullmq:gltv-me-extract', event: 'gltv_me_submit_complete', context: { ...ctx, fidelity: data.fidelity, task_id: taskId } });
      return { ok: true, state: 'submitted', task_id: taskId };
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const finalAttempt = job.attemptsMade + 1 >= Number(job.opts.attempts || 1);
    await logEvent({ function_name: 'bullmq:gltv-me-extract', level: 'error', event: 'gltv_me_submit_failed', message: err.message, context: { ...ctx, attempt: job.attemptsMade + 1, final_attempt: finalAttempt } });
    if (finalAttempt) await invokeBase44Function({ fn: 'gltvMEExtractionWorkerStep', authToken: data.auth_token, payload: { project_id: data.project_id, dubbing_api_job_id: data.dubbing_api_job_id, fidelity: data.fidelity, action: 'fail', error_message: err.message, request_id: data.request_id }, timeoutMs: 60000 }).catch(() => {});
    throw err;
  }
}
