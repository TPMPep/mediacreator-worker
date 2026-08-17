// =============================================================================
// STAND-DOWN WIRE CONTRACT — the single definition of "you are not the owner,
// stop", shared by the HTTP client and its regression suite.
// -----------------------------------------------------------------------------
// WHY THIS IS ITS OWN MODULE. The contract is PURE logic over a status code and
// a response body: no Redis, no queue, no environment. It previously lived in
// base44-client.ts, which imports env.ts — and env.ts calls process.exit(1) on a
// missing UPSTASH_REDIS_REST_URL. That made the contract untestable in CI: the
// suite that proves a correct concurrency refusal is not mistaken for a server
// error could not even LOAD without production Redis credentials, so it failed
// as a collection error and proved nothing. A safety guard that can only be
// verified in production is not a guard.
//
// base44-client.ts re-exports everything here, so every existing import site is
// unchanged and there is exactly one definition of the contract.
//
// SOC 2 CC7.2 — an intentional concurrency refusal is recorded as such and is
// distinguishable from an infrastructure failure; CC8.1 — the incumbent run that
// owns the claim is named in the record.
// =============================================================================

export interface StandDownInfo {
  message?: string;
  incumbent_run_id?: string | null;
  operation?: string | null;
}

/**
 * Distinctive error thrown when a Base44 function answers HTTP 409 with an
 * explicit `{ stand_down: true }` — an INTENTIONAL, EXPECTED outcome, not a
 * failure.
 *
 * WHY THIS CLASS EXISTS (incident 2026-08-17, project 6a7c9797e3e4026fabd4c592).
 * Speaker refinement is single-flight per PROJECT: exactly one run may stage rows
 * or cut a transcript over, and every other contender is told to stand down. A
 * losing run is the guard WORKING. Without a distinct class, that answer looks to
 * the worker exactly like a server error: the job burns its full BullMQ retry
 * budget re-asking a question already settled, `terminal_failure` fires and runs
 * the cleanup path that RESTORES superseded rows — the exact mechanism that
 * triplicated that project's transcript — and the operator sees five "failed"
 * refinements where the truthful record is "one ran, four correctly declined".
 *
 * THE DISTINCTION IS DELIBERATELY NARROW. Only a 409 carrying an explicit
 * `stand_down: true` is treated this way. Every other 409 — a genuine conflict
 * such as a per-segment re-transcribe already in flight, or a cost-quota refusal
 * — keeps its ordinary `HTTP 409` error shape and its normal retry/failure
 * handling. Suppressing real conflicts by status code alone would trade one
 * silent failure for another.
 *
 * NOTHING IS MUTATED on this path: the losing run must never release, reclaim or
 * modify the winning run's claim, so the stand-down is a pure early exit.
 */
export class WorkerStandDownError extends Error {
  readonly standDown = true as const;
  readonly incumbentRunId: string | null;
  readonly refusedOperation: string | null;
  readonly detail: string;
  constructor(fn: string, info: StandDownInfo) {
    super(`base44 ${fn} → stand down: ${info.message || 'another run owns the project claim'}`);
    this.name = 'WorkerStandDownError';
    this.incumbentRunId = info.incumbent_run_id ?? null;
    this.refusedOperation = info.operation ?? null;
    this.detail = info.message || '';
  }
}

/**
 * Classify a non-OK response as an intentional stand-down.
 *
 * Requires BOTH the 409 status AND an explicit boolean-true `stand_down` field in
 * a JSON body. A body that merely mentions the words, a string `"true"`, a nested
 * flag, or a 409 without the field is NOT a stand-down — it is a real conflict and
 * must propagate. Returns the incumbent run id when the function supplied one so
 * the worker's record names who actually owns the project.
 */
export function parseStandDown(status: number, body: string): StandDownInfo | null {
  if (status !== 409) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (row.stand_down !== true) return null;
  return {
    message: typeof row.message === 'string' ? row.message : (typeof row.error === 'string' ? row.error : ''),
    incumbent_run_id: typeof row.incumbent_run_id === 'string' ? row.incumbent_run_id : null,
    operation: typeof row.operation === 'string' ? row.operation : null,
  };
}
