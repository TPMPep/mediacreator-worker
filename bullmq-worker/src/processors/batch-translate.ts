// =============================================================================
// BATCH-TRANSLATE PROCESSOR — Runs a translation batch via Base44.
// =============================================================================

import type { Job } from 'bullmq';
import type { BatchTranslateJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

export async function processBatchTranslate(job: Job<BatchTranslateJobData>) {
  const t0 = Date.now();
  const { project_id, segment_ids, target_language, provider, user_email, request_id } = job.data;
  try {
    const result = await invokeBase44Function({
      fn: 'runTranslation',
      payload: { project_id, segment_ids, target_language, provider },
      timeoutMs: 10 * 60 * 1000,
    });
    await logEvent({
      function_name: 'bullmq:batch-translate',
      event: 'batch_translation_complete',
      duration_ms: Date.now() - t0,
      context: { project_id, segment_count: segment_ids.length, target_language, provider, request_id, user_email },
    });
    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:batch-translate',
      level: 'error',
      event: 'batch_translation_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { project_id, segment_count: segment_ids.length, target_language, request_id, user_email },
    });
    throw err;
  }
}