import type { Job } from 'bullmq';
import type { FinalExportQCJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function } from '../base44-client.js';
import { inspectFinalExport, attachFinalQcPreviews } from '../final-export-audio-qc.js';
import { storageFromEnv } from '../s3-signer.js';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mintFinalQCWorkerJWT } from '../final-qc-auth.js';

// One queued recovery examines only an already-rendered artifact. It never re-renders or alters it.
export async function processFinalExportQC(job: Job<FinalExportQCJobData>) {
  const { export_job_id, project_id, user_email } = job.data;
  const invoke = (action: string, extra = {}) => invokeBase44Function<any>({
    fn: 'recoverFinalExportQC', authToken: mintFinalQCWorkerJWT(user_email, project_id, export_job_id),
    payload: { action, export_job_id, project_id, attempt_id: job.id, ...extra }, timeoutMs: 45000,
  });
  const dir = await mkdtemp(join(tmpdir(), 'recover-final-qc-'));
  try {
    const prep = await invoke('prepare');
    if (prep.done) return { already_checked: true };
    const file = join(dir, 'deliverable');
    const response = await fetch(prep.file_url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`Final-file download failed (${response.status})`);
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(file));
    const size = (await stat(file)).size;
    if (size < 1 || size !== prep.file_size_bytes) throw new Error('Final-file size changed; recovery refused');
    const qc = await attachFinalQcPreviews(file,
      storageFromEnv({ region: prep.region, bucket: prep.bucket, prefix: prep.credential_secret_prefix, endpoint: prep.endpoint }),
      `dubflow/exports/${project_id}/${export_job_id}/`, await inspectFinalExport(file));
    return await invoke('commit', { qc, s3_key: prep.s3_key, file_size_bytes: size });
  } catch (error) {
    if (job.attemptsMade + 1 >= Number(job.opts.attempts || 1)) {
      await invoke('fail', { error_message: String((error as Error).message).slice(0, 300) }).catch(() => {});
    }
    throw error;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
