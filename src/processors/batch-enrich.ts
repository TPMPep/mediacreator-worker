// =============================================================================
// BATCH-ENRICH PROCESSOR — Runs a Superscript enrichment chunk via Base44.
// =============================================================================

import type { Job } from 'bullmq';
import type { BatchEnrichJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

export async function processBatchEnrich(job: Job<BatchEnrichJobData>) {
  const t0 = Date.now();
  const { project_id, record_ids, tier, enrichment_run_id, user_email, request_id } = job.data;
  try {
    const result = await invokeBase44Function({
      fn: 'enrichSuperscriptRecords',
      payload: { project_id, record_ids, tier, enrichment_run_id },
      timeoutMs: 10 * 60 * 1000,
    });
    await logEvent({
      function_name: 'bullmq:batch-enrich',
      event: 'batch_enrich_complete',
      duration_ms: Date.now() - t0,
      context: { project_id, record_count: record_ids.length, tier, enrichment_run_id, request_id, user_email },
    });
    return result;
  } catch (err) {
    const e = err as Error;
    await logEvent({
      function_name: 'bullmq:batch-enrich',
      level: 'error',
      event: 'batch_enrich_failed',
      message: e.message,
      error_kind: e.name,
      duration_ms: Date.now() - t0,
      context: { project_id, record_count: record_ids.length, tier, enrichment_run_id, request_id, user_email },
    });
    throw err;
  }
}