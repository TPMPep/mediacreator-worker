// =============================================================================
// AIREWRITE-CHUNK PROCESSOR
// -----------------------------------------------------------------------------
// Calls back into Base44's `rewriteChunk` function. Each invocation processes
// ONE chunk (≤10 translations, one LLM call per line, CPS-verified):
//
//   - Per-line LLM call (prompt versioned, model pinned, full context).
//   - On overshoot (shorten still > MAX or expand still < MIN), single retry
//     with tightened/looser budget — same logic as the single-line hot path.
//   - Idempotent persist: re-running the chunk is safe because the Base44
//     function checks completed_chunk_keys on the run document.
//   - Atomic update of run counters (succeeded_count/failed_count/cost_usd,
//     chunk_completed++, chunk_in_flight--, chunk_key in completed_chunk_keys).
//
// Idempotency: BullMQ may re-run us (same chunk_key). The Base44 function
// short-circuits if chunk_key is already in completed_chunk_keys.
//
// Heartbeats + zombie-kill (2026-06-16): runWithLockHeartbeat (base44-client)
// owns the lock-renewal loop AND aborts the in-flight rewriteChunk fetch the
// instant the BullMQ lock is lost. This closes the unbounded active/reclaim
// loop where a hung invocation kept running as a zombie parallel to BullMQ's
// stalled-reclaim (root-caused on GLTV cold-start run 6a310a7b…, chunk 2701:
// attempts climbed 1→5 with ZERO worker logs = stacked zombies). See the
// runWithLockHeartbeat header for the full mechanism + SOC 2 rationale.
//
// Timeout Budget (2026-05-24 — Stage 2 N=10 provider tail tuning):
//   - rewriteChunk function-side worst case: 90s provider timeout × 3 inner
//     attempts = 270s (raised from 50s × 3 = 150s on 2026-05-24)
//   - CHUNK_TIMEOUT_MS = 330s (60s safety margin above 270s function ceiling,
//     was 180s)
//   - Rationale: N=10 smoke run (LoadTestRun 6a13372f...) observed
//     367 DLQ landings because Gemini Flash tail-latency at this concurrency
//     exceeded the 50s per-call AbortController. Raising per-call to 90s
//     absorbs Gemini's observed p95 (~75s under load) without changing
//     chunk size or batch shape — preserves auditor-grade per-line accounting.
//   - This ensures the worker never kills the function mid-retry; all transient
//     failures land in the return payload with telemetry (openai_timeout_count,
//     transient_retry_count, attempts_used). The orchestrator can then harvest
//     those counts onto the AIRewriteRun row for auditor-grade visibility into
//     provider degradation. SOC 2 CC7.4 — every timeout boundary is documented
//     and traceable to a real load-test observation.
// =============================================================================

import type { Job } from 'bullmq';
import type { AIRewriteChunkJobData } from '../../shared/queue-contracts.js';
import { invokeBase44Function, logEvent, runWithLockHeartbeat, WorkerLockLostError } from '../base44-client.js';

// Worker function-call timeout. Must exceed function-side worst case:
// 90s provider timeout × 3 inner LLM attempts = 270s. Set to 330s for 60s safety.
// Raised from 180s on 2026-05-24 — see file header for the N=10 evidence.
const CHUNK_TIMEOUT_MS = 330_000;

// HARD WALL-CLOCK DEADLINE for the WHOLE processor invocation (reliability fix).
// -----------------------------------------------------------------------------
// CHUNK_TIMEOUT_MS bounds the SINGLE invokeBase44Function call. But if that
// promise ever fails to settle (gateway socket wedged, fetch never resolving
// nor rejecting), the await sits forever. The PRIMARY guard against that is now
// runWithLockHeartbeat's lock-loss abort: when BullMQ reclaims the job (lock
// lost at ~30s), the in-flight fetch is aborted immediately. This deadline
// stays as defence-in-depth for the rare case where the lock is somehow still
// held but the fetch never settles — it throws a CLASSIFIED error so the job
// lands in BullMQ `failed` (harvestable) instead of stalling invisibly.
// SOC 2 CC7.2 — a hung invocation can no longer strand a chunk silently.
const CHUNK_DEADLINE_MS = 345_000; // 15s above CHUNK_TIMEOUT_MS

class ChunkDeadlineError extends Error {
  constructor(ms: number) {
    super(`airewrite-chunk: hard wall-clock deadline (${ms}ms) exceeded — invocation never settled. Classified as worker_deadline_exceeded so BullMQ fails the job instead of stalling it.`);
    this.name = 'ChunkDeadlineError';
  }
}

// ─── GATEWAY-TIMEOUT FAST-FAIL POLICY (2026-06-15) ───────────────────────────
// A Base44 function-gateway timeout (HTTP 504, and the 502/503/524 gateway
// family) is NOT a transient the chunk can usefully ride out: the gateway
// already killed the request after its own ceiling, so every BullMQ retry just
// re-pays that full ceiling under exponential backoff (5s/25s/125s/625s/3125s ≈
// 64 min worst case over 6 attempts). That is the exact 20-minute wedge observed
// on the 2026-06-15 cold-start: one 504-looping chunk held the whole GLTV cascade
// for 20 minutes before BullMQ exhausted its budget.
//
// Policy: detect the gateway-timeout signature in the error message
// invokeBase44Function throws, allow AT MOST ONE fast retry (short FIXED delay,
// NO exponential backoff), then — instead of throwing (which would burn the
// remaining BullMQ attempts) — RETURN a structured terminal envelope
// ({ ok:false, terminal_error:{ code:'gateway_timeout' } }). BullMQ marks the
// job `completed`; the orchestrator's existing terminal_error harvest branch
// picks it up on the very next tick and terminalises the chunk as `partial`/
// `failed` with full audit — never a 6-attempt backoff wedge. The rewrite
// prompts, CPS logic, and human rewrite output behaviour are untouched: this is
// purely a transport-failure classification on the worker side.
// SOC 2 CC7.4 — subprocessor/gateway degradation is bounded and provable from
// the chunk return alone; CC7.2 — a slow gateway can no longer block the cascade.
const GATEWAY_TIMEOUT_FAST_RETRY_DELAY_MS = 2000; // ONE fast retry, fixed delay.

// invokeBase44Function throws `Error("base44 <fn> → HTTP <status>: <body> ...")`.
// Match the gateway-timeout family on that message shape. We intentionally scope
// to 504/502/503/524 (gateway/proxy timeouts + Cloudflare 524) — NOT 500 (a real
// function error) or 4xx (client errors), which must keep their normal handling.
function isGatewayTimeout(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '');
  if (!/HTTP\s+(504|502|503|524)\b/.test(msg)) return false;
  // Defensive: also confirm it's the invokeBase44Function envelope, not some
  // unrelated string that happens to contain "504".
  return /→\s*HTTP/.test(msg) || /Timeout/i.test(msg) || /Gateway/i.test(msg);
}

function gatewayTimeoutStatus(err: unknown): string {
  const m = String((err as Error)?.message || '').match(/HTTP\s+(504|502|503|524)\b/);
  return m ? m[1] : '5xx';
}

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

  // Hard wall-clock deadline: a TRUE never-settles backstop (gateway socket
  // wedged so the promise neither resolves nor rejects). The PRIMARY, faster
  // guard is runWithLockHeartbeat's lock-loss abort — if BullMQ reclaims the
  // job (lock lost at ~30s), the invocation is aborted immediately, long
  // before this 345s deadline. This stays as defence-in-depth.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => reject(new ChunkDeadlineError(CHUNK_DEADLINE_MS)), CHUNK_DEADLINE_MS);
  });

  // One reusable invoker so the gateway-timeout fast-retry below calls the
  // exact same function with the exact same payload. Threads the lock-loss
  // `signal` into the fetch (zombie-kill) AND races the hard deadline.
  const invokeOnce = (signal: AbortSignal) => Promise.race([
    invokeBase44Function({
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
      signal,
    }),
    deadline,
  ]);

  // runWithLockHeartbeat owns the heartbeat + lock-loss abort. The whole
  // gateway-timeout fast-retry + terminal-envelope logic runs INSIDE its body
  // so a lost lock aborts the in-flight rewriteChunk fetch immediately and the
  // invocation exits — no zombie parallel to the BullMQ reclaim.
  try {
    return await runWithLockHeartbeat(job, async (signal) => {
      let result: unknown;
      try {
        result = await invokeOnce(signal);
      } catch (firstErr) {
        // ─── GATEWAY-TIMEOUT FAST-FAIL (504 family) ───────────────────────────
        // A gateway 504/502/503/524 is a transport-layer kill, not a transient the
        // chunk should ride out across 6 exponential-backoff BullMQ attempts (the
        // 20-min wedge). Allow ONE fast retry (fixed short delay), then return a
        // structured terminal envelope so BullMQ marks the job `completed` and the
        // orchestrator harvests it as a clean terminal failure on the next tick.
        if (!isGatewayTimeout(firstErr)) throw firstErr; // not 504-family → normal path.
        const status1 = gatewayTimeoutStatus(firstErr);
        await logEvent({
          function_name: 'bullmq:airewrite-chunk',
          level: 'warn',
          event: 'airewrite_chunk_gateway_timeout_retry',
          message: `rewriteChunk gateway timeout (HTTP ${status1}) — ONE fast retry then terminalise (no 6× backoff).`,
          error_kind: 'gateway_timeout',
          duration_ms: Date.now() - t0,
          context: {
            project_id, rewrite_run_id, chunk_key, chunk_index, mode,
            bullmq_job_id: job.id, attempts: job.attemptsMade + 1,
            http_status: status1, fast_retry_delay_ms: GATEWAY_TIMEOUT_FAST_RETRY_DELAY_MS,
            provider, model: inlined_run_config?.model ?? null,
            request_id, user_email,
          },
        });
        await new Promise(r => setTimeout(r, GATEWAY_TIMEOUT_FAST_RETRY_DELAY_MS));
        try {
          result = await invokeOnce(signal);
        } catch (secondErr) {
          if (!isGatewayTimeout(secondErr)) throw secondErr; // a different failure on retry → normal path.
          // STILL a gateway timeout after the fast retry → terminalise THIS chunk
          // via a structured envelope. NOT thrown: throwing would re-enter BullMQ's
          // 6× exponential backoff (the wedge we are closing). Returning makes the
          // job `completed` with ok:false; the orchestrator's terminal_error harvest
          // branch records it (full audit) and finalises the run as partial/failed.
          const status2 = gatewayTimeoutStatus(secondErr);
          const failedRecordIds = Array.isArray(inlined_translations)
            ? inlined_translations.map((t: { translation_id?: string }) => t?.translation_id).filter(Boolean)
            : [];
          const elapsedMs = Date.now() - t0;
          const terminalEnvelope = {
            ok: false,
            chunk_key,
            chunk_index,
            translations: [],
            processed_count: inlined_translations?.length ?? 0,
            rewritten_count: 0,
            failed_count: inlined_translations?.length ?? 0,
            failed_record_ids: failedRecordIds,
            characters_processed: 0,
            cost_usd: 0,
            // Structured terminal the orchestrator already knows how to harvest.
            terminal_error: {
              code: 'gateway_timeout',
              message: `rewriteChunk gateway timeout (HTTP ${status2}) on initial call AND fast retry. Terminalised by the worker to avoid a 6× BullMQ backoff wedge (~20 min). The chunk's lines are accounted as lost; the run finalises as partial/failed. bullmq_job_id=${job.id} attempts=${job.attemptsMade + 1} elapsed_ms=${elapsedMs} provider=${provider} model=${inlined_run_config?.model ?? 'unknown'}`,
            },
            // Audit fields the orchestrator pins onto AIRewriteRun.chunk_failures.
            error_kind: 'gateway_timeout',
            bullmq_job_id: job.id,
            http_status: status2,
            attempts_used: job.attemptsMade + 1,
            elapsed_ms: elapsedMs,
            provider,
            requested_model: inlined_run_config?.model ?? null,
            request_id,
          };
          clearTimeout(deadlineTimer);
          await logEvent({
            function_name: 'bullmq:airewrite-chunk',
            level: 'error',
            event: 'airewrite_chunk_gateway_timeout_terminal',
            message: `rewriteChunk gateway timeout (HTTP ${status2}) after fast retry — terminalised via structured envelope (no backoff wedge).`,
            error_kind: 'gateway_timeout',
            duration_ms: elapsedMs,
            context: {
              project_id, rewrite_run_id, chunk_key, chunk_index, mode,
              bullmq_job_id: job.id, attempts: job.attemptsMade + 1,
              http_status: status2, line_count: inlined_translations?.length ?? 0,
              provider, model: inlined_run_config?.model ?? null,
              request_id, user_email,
            },
          });
          return terminalEnvelope;
        }
      }
      clearTimeout(deadlineTimer);

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
    }); // end runWithLockHeartbeat body
  } catch (err) {
    const e = err as Error;
    const lockLost = e instanceof WorkerLockLostError;
    await logEvent({
      function_name: 'bullmq:airewrite-chunk',
      level: lockLost ? 'warn' : 'error',
      event: lockLost ? 'airewrite_chunk_lock_lost' : 'airewrite_chunk_failed',
      message: e.message,
      error_kind: lockLost ? 'lock_lost' : e.name,
      duration_ms: Date.now() - t0,
      context: {
        project_id, rewrite_run_id, chunk_key, chunk_index, mode,
        line_count: inlined_translations?.length ?? 0,
        attempts: job.attemptsMade + 1,
        request_id, user_email,
      },
    });
    // Re-throw so BullMQ owns the SINGLE reclaim. A lock-loss abort is a clean
    // exit of THIS invocation, not a provider failure — rewriteChunk is
    // idempotent (orchestrator is sole writer, short-circuits on
    // completed_chunk_keys), so the reclaim re-runs it exactly once.
    throw err;
  } finally {
    clearTimeout(deadlineTimer);
  }
}
