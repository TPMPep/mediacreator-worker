// =============================================================================
// AIREWRITE-CHUNK PROCESSOR
// -----------------------------------------------------------------------------
// Calls back into Base44's `rewriteChunk` function. Each invocation processes
// ONE chunk (≤10 translations, one LLM call per line, CPS-verified):
//
// - Per-line LLM call (prompt versioned, model pinned, full context).
// - On overshoot (shorten still > MAX or expand still < MIN), single retry
// with tightened/looser budget — same logic as the single-line hot path.
// - Idempotent persist: re-running the chunk is safe because the Base44
// function checks completed_chunk_keys on the run document.
// - Atomic update of run counters (succeeded_count/failed_count/cost_usd,
// chunk_completed++, chunk_in_flight--, chunk_key in completed_chunk_keys).
//
// Idempotency: BullMQ may re-run us (same chunk_key). The Base44 function
// short-circuits if chunk_key is already in completed_chunk_keys.
//
// Heartbeats: a chunk of 10 LLM calls with retries can run 30-150s. We extend
// the lock every 15s.
//
// Timeout Budget (2026-05-20):
// - rewriteChunk function-side worst case: 50s provider timeout × 3 inner attempts = 150s
// - CHUNK_TIMEOUT_MS = 180s (30s safety margin above 150s function ceiling)
// - This ensures the worker never kills the function mid-retry; all transient failures
//   land in the return payload with telemetry (openai_timeout_count, transient_retry_count,
//   attempts_used). Orchestrator can then harvest those counts onto the AIRewriteRun row
//   for auditor-grade visibility into provider degradation.
// =============================================================================

import type { Job } from 'bullmq';
import type { AIRewriteChunkJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent } from '../base44-client.js';

const HEARTBEAT_MS = 15_000;
// Worker function call timeout. Must exceed function-side worst case:
// 50s provider timeout × 3 inner LLM attempts = 150s. Set to 180s for 30s safety.
const CHUNK_TIMEOUT_MS = 180_000;

export async function processAIRewriteChunk(job: Job) {
 const t0 = Date.now();
 const {
 project_id, rewrite_run_id, chunk_key, chunk_index,
 inlined_translations, mode, user_email, request_id, auth_token,
 provider, project_context, inlined_run_config,
 } = job.data;

 if (!auth_token) {
 throw new Error('airewrite-chunk: missing auth_token (re-enqueue required)');
 }

 let heartbeatActive = true;
 const heartbeat = (async () => {
 while (heartbeatActive) {
 await new Promise(r => setTimeout(r, HEARTBEAT_MS));
 if (!heartbeatActive) break;
 try { await job.extendLock(job.token!, 30_000); } catch { /* swallow */ }
 }
 })();

 try {
 const result = await invokeBase44Function({
 fn: 'rewriteChunk',
 authToken: auth_token,
 payload: {
 project_id,
 rewrite_run_id,
 chunk_key,
 chunk_index,
 // v3 pure-compute contract (incident 2026-05-09): the chunk
 // function makes ZERO Base44 reads. The producer inlines every
 // translation row + the run-config block the chunk needs; the
 // orchestrator forwards them verbatim through this queue. The
 // legacy `translation_ids` field is intentionally dropped — the
 // chunk has no way to dereference IDs without a Base44 read.
 inlined_translations,
 mode,
 provider,
 project_context,
 user_email,
 request_id,
 inlined_run_config,
 },
 timeoutMs: CHUNK_TIMEOUT_MS,
 });

 await logEvent({
 function_name: 'bullmq:airewrite-chunk',
 event: 'airewrite_chunk_complete',
 duration_ms: Date.now() - t0,
 context: {
 project_id, rewrite_run_id, chunk_key, chunk_index, mode,
 line_count: inlined_translations?.length ?? 0,
 attempts: job.attemptsMade + 1,
 request_id, user_email,
 },
 });
 return result;
 } catch (err) {
 const e = err as Error;
 await logEvent({
 function_name: 'bullmq:airewrite-chunk',
 level: 'error',
 event: 'airewrite_chunk_failed',
 message: e.message,
 error_kind: e.name,
 duration_ms: Date.now() - t0,
 context: {
 project_id, rewrite_run_id, chunk_key, chunk_index, mode,
 line_count: inlined_translations?.length ?? 0,
 attempts: job.attemptsMade + 1,
 request_id, user_email,
 },
 });
 throw err;
 } finally {
 heartbeatActive = false;
 await heartbeat.catch(() => {});
 }
}
