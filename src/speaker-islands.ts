// =============================================================================
// speaker-islands — universal detection of a SPEAKER-ATTRIBUTION ISLAND.
// -----------------------------------------------------------------------------
// WHAT THIS ANSWERS
//   Diarization returns exactly ONE speaker per instant. When two people are
//   genuinely audible at the same moment, that single label is a choice, not a
//   measurement — and the pipeline previously recorded such a choice as fully
//   VALIDATED, because a pyannote turn DID cover the words. The operator got no
//   signal at all, so a wrong attribution left the building silently.
//
//   The observable shape of that failure is an ISLAND: one very short row whose
//   speaker differs from BOTH of its neighbours, where those neighbours are the
//   SAME speaker as each other and the row is lexically part of their utterance.
//   Overlapping voice-over translation produces it (the first word of the
//   dubbed line is attributed to the original-language voice still audible
//   underneath), but so do overlapping interviews, crowd noise under a reporter,
//   two-way phone audio, and simultaneous interpretation. Nothing in this module
//   knows about voice-over, news, English, or any specific project — it reasons
//   only about geometry, speaker context, overlap evidence and text structure.
//
// WHY IT IS MULTI-SIGNAL, AND NEVER DURATION ALONE
//   A one-word row is perfectly legitimate: "Yes." / "No." / "Right." are real
//   speaker turns, and quarantining every short row would flood the review queue
//   and train operators to rubber-stamp it, which is worse than no gate at all.
//   So shortness is ONE signal among several, and it is never sufficient:
//
//     S1 atomic          ≤ ISLAND_MAX_WORDS words AND ≤ ISLAND_MAX_DURATION_MS.
//     S2 sandwich        both neighbours exist, share ONE speaker as each other,
//                        and that speaker is NOT this row's. MANDATORY — without
//                        it there is no competing attribution to prefer, so
//                        there is nothing to be suspicious about.
//     S3 seam continuity the gap to at least ONE neighbour is below the normal
//                        conversational seam floor, i.e. this row runs straight
//                        into surrounding speech rather than standing alone after
//                        a pause. Deliberately NOT "both gaps": an island is
//                        routinely glued to only one side — a voice-over that
//                        begins after a few seconds of original-language audio
//                        sits 1.9s behind the previous line and 0ms in front of
//                        the next one, and requiring both silences would miss the
//                        entire class. A row with a real pause on BOTH sides is a
//                        standalone remark and never trips this signal.
//     S4 overlap         two different speakers are measured as active over the
//                        same audio around this row — direct evidence that the
//                        single label here was a choice between two voices.
//                        Optional: absent when turn data is unavailable.
//     S5 continuity      the row is structurally part of the neighbouring
//                        utterance rather than a standalone remark (it carries
//                        no sentence-final punctuation and the following text
//                        cannot begin a sentence). Script-agnostic: languages
//                        without case simply do not produce this signal, which
//                        is why it is never required on its own.
//
//   DECISION (policy v1): S1 and S2 are mandatory. With overlap evidence (S4)
//   one supporting signal is enough. WITHOUT overlap evidence both S3 and S5 are
//   required — the deliberately stronger bar, so a quiet clean interjection
//   between two same-speaker lines is left alone.
//
// WHAT FIRING MEANS — AND WHAT IT NEVER DOES
//   Nothing is merged, moved or reassigned. pyannote's attribution stays on the
//   row as the evidence it is, the verdict becomes UNRESOLVED_SPEAKER with a
//   named reason, the row surfaces in the timing-integrity review queue with the
//   speaker the surrounding evidence favours, and a production export stays
//   blocked until an operator rules through the audited override workflow. The
//   alternative — auto-absorbing the word into the neighbouring run — would
//   silently rewrite both attribution AND lexical grouping on a heuristic, which
//   is exactly the class of change the audit trail exists to prevent.
//
// SOC 2 CC7.4 / CC8.1 — the verdict is derived from evidence alone, carries the
// signals that produced it and the policy version in force, and is therefore
// independently recomputable by an auditor.
// =============================================================================

/** Bumped whenever a signal, threshold or the combination rule changes. */
export const SPEAKER_ISLAND_POLICY_VERSION = 1;

/** S1 — an island is atomic: this many words at most … */
export const ISLAND_MAX_WORDS = 2;
/** … and this short at most. One signal, never the whole decision. */
export const ISLAND_MAX_DURATION_MS = 400;
/** S3 — gap below which two rows are continuous speech rather than a turn. */
export const ISLAND_MAX_SEAM_GAP_MS = 300;
/** S4 — simultaneous speaker activity must be real, not boundary rounding. */
export const ISLAND_MIN_OVERLAP_MS = 100;
/** S4 — how far either side of the row competing activity still counts. */
export const ISLAND_OVERLAP_PROBE_MS = 400;

export const SPEAKER_ISLAND_REASON_CODE = 'speaker_island_in_overlap';

export type IslandRow = {
  sequence_index?: number;
  start_ms: number;
  end_ms: number;
  speaker_id?: string;
  speaker_label?: string;
  source_text?: string;
  is_music?: boolean;
  /** Word count when known; otherwise derived from the text. */
  word_count?: number;
  /** Diarization cluster this row was attributed to (for overlap evidence). */
  cluster?: string | null;
};

/** A pyannote turn, in milliseconds. The processor converts from seconds. */
export type IslandTurn = { cluster: string; start_ms: number; end_ms: number };

export type IslandVerdict = {
  detected: boolean;
  signals: string[];
  policy_version: number;
  word_count: number;
  duration_ms: number;
  gap_before_ms: number | null;
  gap_after_ms: number | null;
  overlap_ms: number;
  overlap_evidence_available: boolean;
  /** pyannote's own attribution — preserved, never replaced by this module. */
  provider_speaker_id: string;
  provider_speaker_label: string;
  /** What the surrounding evidence favours. A suggestion for the operator only. */
  suggested_speaker_id: string;
  suggested_speaker_label: string;
  reason_code: string;
  reason: string;
};

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const speakerKey = (row: IslandRow | undefined): string =>
  row ? String(row.speaker_id || row.speaker_label || '') : '';

export function countWords(row: IslandRow): number {
  if (Number.isFinite(row.word_count)) return Math.max(0, Math.trunc(Number(row.word_count)));
  return String(row.source_text || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Does this text close a sentence? A standalone interjection normally does
 * ("Yes." / "¿Qué?" / "はい。"), a fragment torn off the next utterance does not.
 * Trailing quotes/brackets are ignored so «Yes.» reads as terminal.
 */
export function endsSentence(text: string): boolean {
  const trimmed = String(text || '').trim().replace(/["'”’»)\]]+$/u, '');
  return /[.!?…。！？؟।]$/u.test(trimmed);
}

/**
 * Can this text NOT begin a sentence? True when its first letter exists in both
 * cases and is lower-case — the structural marker of a continuation ("don't know
 * what…"). Deliberately false for scripts without case (Japanese, Arabic,
 * Korean), which is why S5 is never a requirement on its own.
 */
export function startsMidSentence(text: string): boolean {
  const first = Array.from(String(text || '').trim()).find(char => char.toLowerCase() !== char.toUpperCase());
  if (!first) return false;
  return first === first.toLowerCase();
}

/**
 * S4 — is more than one speaker measured as active over the audio around this
 * row? Looks for a real intersection between a turn of the row's own cluster and
 * a turn of the neighbours' cluster, plus the simpler case of a neighbour-cluster
 * turn reaching into the row's own window. Returns 0 when no turn data exists,
 * which the caller must treat as "unknown", never as "no overlap".
 */
export function measureCompetingActivityMs(
  row: IslandRow,
  neighbourCluster: string,
  turns: IslandTurn[],
  probeMs: number = ISLAND_OVERLAP_PROBE_MS,
): number {
  const ownCluster = String(row.cluster || '');
  if (!turns.length || !ownCluster || !neighbourCluster || ownCluster === neighbourCluster) return 0;
  const from = num(row.start_ms) - probeMs;
  const to = num(row.end_ms) + probeMs;
  const near = turns.filter(turn => num(turn.end_ms) > from && num(turn.start_ms) < to);
  const own = near.filter(turn => String(turn.cluster) === ownCluster);
  const competing = near.filter(turn => String(turn.cluster) === neighbourCluster);
  let worst = 0;
  for (const a of own) {
    for (const b of competing) {
      const overlap = Math.min(num(a.end_ms), num(b.end_ms)) - Math.max(num(a.start_ms), num(b.start_ms));
      if (overlap > worst) worst = overlap;
    }
  }
  for (const b of competing) {
    const overlap = Math.min(num(row.end_ms), num(b.end_ms)) - Math.max(num(row.start_ms), num(b.start_ms));
    if (overlap > worst) worst = overlap;
  }
  return Math.max(0, Math.round(worst));
}

/**
 * Evaluate ONE row against its immediate neighbours. Returns null when the row
 * is not an island candidate at all (the overwhelmingly common case), so callers
 * can treat a verdict object as "something to disclose".
 */
export function evaluateSpeakerIsland(
  row: IslandRow,
  previous: IslandRow | undefined,
  next: IslandRow | undefined,
  turns: IslandTurn[] = [],
): IslandVerdict | null {
  if (!row || row.is_music === true) return null;
  if (!previous || !next || previous.is_music === true || next.is_music === true) return null;

  const self = speakerKey(row);
  const before = speakerKey(previous);
  const after = speakerKey(next);
  // S2 — mandatory. Without one surrounding speaker on both sides there is no
  // competing attribution the evidence could favour.
  if (!self || !before || before !== after || before === self) return null;

  const wordCount = countWords(row);
  const durationMs = Math.max(0, num(row.end_ms) - num(row.start_ms));
  const atomic = wordCount > 0 && wordCount <= ISLAND_MAX_WORDS && durationMs <= ISLAND_MAX_DURATION_MS;
  if (!atomic) return null;

  const gapBefore = Math.max(0, num(row.start_ms) - num(previous.end_ms));
  const gapAfter = Math.max(0, num(next.start_ms) - num(row.end_ms));
  const seamContinuity = Math.min(gapBefore, gapAfter) <= ISLAND_MAX_SEAM_GAP_MS;

  const overlapEvidenceAvailable = turns.length > 0;
  const overlapMs = measureCompetingActivityMs(row, String(previous.cluster || ''), turns);
  const overlapping = overlapMs >= ISLAND_MIN_OVERLAP_MS;

  const continuous = !endsSentence(String(row.source_text || ''))
    && startsMidSentence(String(next.source_text || ''));

  const supporting = (seamContinuity ? 1 : 0) + (continuous ? 1 : 0);
  // With measured overlap one supporting signal suffices; without it, BOTH are
  // required — a legitimate short turn in clean audio must stay validated.
  const detected = overlapping ? supporting >= 1 : supporting === 2;
  if (!detected) return null;

  const signals = ['atomic_row', 'same_speaker_sandwich'];
  if (seamContinuity) signals.push('sub_seam_gap_to_neighbour');
  if (overlapping) signals.push('competing_speaker_activity');
  if (continuous) signals.push('lexical_continuity');

  return {
    detected: true,
    signals,
    policy_version: SPEAKER_ISLAND_POLICY_VERSION,
    word_count: wordCount,
    duration_ms: Math.round(durationMs),
    gap_before_ms: Math.round(gapBefore),
    gap_after_ms: Math.round(gapAfter),
    overlap_ms: overlapMs,
    overlap_evidence_available: overlapEvidenceAvailable,
    provider_speaker_id: String(row.speaker_id || ''),
    provider_speaker_label: String(row.speaker_label || ''),
    suggested_speaker_id: String(previous.speaker_id || ''),
    suggested_speaker_label: String(previous.speaker_label || ''),
    reason_code: SPEAKER_ISLAND_REASON_CODE,
    reason: `Short speaker island inside overlapping speech; surrounding evidence favors ${String(previous.speaker_label || 'the neighbouring speaker')}.`,
  };
}

/**
 * Evaluate a whole programme in delivery order. Pure: returns one verdict slot
 * per row (null where nothing was detected) and never mutates the input.
 */
export function detectSpeakerIslands(
  rows: IslandRow[],
  options: { turns?: IslandTurn[] } = {},
): { verdicts: Array<IslandVerdict | null>; detected_count: number; policy_version: number } {
  const list = Array.isArray(rows) ? rows : [];
  const turns = Array.isArray(options.turns) ? options.turns : [];
  const verdicts = list.map((row, index) => evaluateSpeakerIsland(row, list[index - 1], list[index + 1], turns));
  return {
    verdicts,
    detected_count: verdicts.filter(Boolean).length,
    policy_version: SPEAKER_ISLAND_POLICY_VERSION,
  };
}
