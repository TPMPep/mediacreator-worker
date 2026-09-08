// =============================================================================
// terminal-refusal — the wire contract for "this is the answer, not a failure".
// -----------------------------------------------------------------------------
// WHY THIS EXISTS. A Base44 producer can refuse work for a reason that a RETRY
// CANNOT CHANGE. The refusal that motivated this module is the stale authored
// window: runVoiceGeneration freezes each line's timing window into its chunk
// plan at PRODUCER time, and the orchestrator then dispatches from that frozen
// plan across bounded ticks plus BullMQ retries. If an operator retimes the line
// inside that gap, generateOneSegment refuses rather than fitting audio to a
// window that no longer exists — and every retry replays the SAME frozen window
// and reaches the SAME refusal. The identical shape already applied to the
// single-writer claim refusal (409 voice_gen_claim_held).
//
// WITHOUT THIS CONTRACT the refusal is indistinguishable from a transient
// failure: invokeBase44Function throws on any non-2xx, the processor rethrows to
// let BullMQ retry, and one refused line burns its whole attempt ladder writing
// a `voice_generation_failed` error row on every pass. Nothing is corrupted and
// no provider money is spent — but the audit trail then carries five error rows
// for a line that was never broken, and an auditor reading it cannot tell a
// deliberate refusal from a genuine render failure. That is a reporting defect,
// and reporting is the thing these logs exist to be trusted for.
//
// THE PATTERN IS DELIBERATELY NOT NEW. It mirrors ./stand-down verbatim: an
// env-free module (so the contract is verifiable in CI without Redis
// credentials — env.ts exits the process on missing Upstash config), parsed at
// the SAME point in invokeBase44Function, BEFORE any retry budget is consulted.
// Retrying a settled answer re-asks a question the producer has already closed.
//
// FAIL-CLOSED BY CONSTRUCTION. A refusal is recognised ONLY when the producer
// states it explicitly (`disposition: 'terminal'`) in a 4xx JSON body. An
// unparseable body, a 5xx, a missing disposition, or `disposition: 'retry'` all
// fall through to the existing retry paths unchanged — so a genuinely transient
// failure can never be silently swallowed as "terminal". The default is always
// the safer one: retry.
//
// SOC 2 CC7.2 (a settled refusal is never retried into a false failure) /
// CC8.1 (the refusal is an attributable, distinctly-classified outcome).
// =============================================================================

/** The one value a producer uses to declare a refusal unretryable. */
export const TERMINAL_DISPOSITION = 'terminal';

export interface TerminalRefusalInfo {
  /** HTTP status the producer refused with (409 for the current refusals). */
  status: number;
  /** Stable machine-readable refusal code, e.g. 'segment_window_stale'. */
  code: string;
  /** Operator-facing explanation, verbatim from the producer. */
  message: string;
  /** The producer's full parsed body, so the processor can log its evidence. */
  detail: Record<string, unknown>;
}

/**
 * Distinctive error for a producer refusal that a retry cannot change. Carries
 * the parsed refusal so the processor logs the producer's OWN evidence rather
 * than re-deriving it from an error string.
 */
export class WorkerTerminalRefusalError extends Error {
  readonly terminal_refusal: TerminalRefusalInfo;

  constructor(fn: string, info: TerminalRefusalInfo) {
    super(`base44 ${fn} → refused (${info.code}): ${info.message}`);
    this.name = 'WorkerTerminalRefusalError';
    this.terminal_refusal = info;
  }
}

/**
 * Recognise a terminal refusal from a non-2xx response. Returns null for
 * ANYTHING that is not an explicit, parseable terminal refusal — see the
 * fail-closed note in the header.
 */
export function parseTerminalRefusal(status: number, body: string): TerminalRefusalInfo | null {
  // Only client-error statuses. A 5xx is a server fault and is always retryable.
  if (!Number.isFinite(status) || status < 400 || status >= 500) return null;
  if (!body) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // An unparseable body proves nothing. Retry rather than assume.
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  if (obj.disposition !== TERMINAL_DISPOSITION) return null;

  const code = typeof obj.code === 'string' && obj.code
    ? obj.code
    : (typeof obj.reason === 'string' && obj.reason ? obj.reason : 'terminal_refusal');
  const message = typeof obj.message === 'string' && obj.message
    ? obj.message
    : (typeof obj.error === 'string' && obj.error ? obj.error : code);

  return { status, code, message, detail: obj };
}
