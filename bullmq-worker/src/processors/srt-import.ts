// =============================================================================
// SRT-IMPORT PROCESSOR — Parses and imports a large SRT file via Base44.
// =============================================================================

import type { Job } from 'bullmq';
import type { SrtImportJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

export async function processSrtImport(job: Job<SrtImportJobData>) {
  const t0 = Date.now();
  const { project_id, s3_key, user_email, request_id } = job.data;
  try {
    const result = await invokeBase44Function({
      fn: 'parseSRT',
      payload: { project_id, s3_key },
      timeoutMs: 10 * 60 * 1000,
    });
    await logEvent({
      function_name: 'bullmq:srt-import',
      event: 'srt_import_complete',
      duration_ms: Date.now() - t0,
      context: { project_id, s3_key, request_id, user_email },
    });
    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:srt-import',
      level: 'error',
      event: 'srt_import_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { project_id, s3_key, request_id, user_email },
    });
    throw err;
  }
}