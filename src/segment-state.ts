// =============================================================================
// segment-state — the deterministic, queryable production state of one segment.
// -----------------------------------------------------------------------------
// A generic "warning" flag is not enough to run a delivery on. Either the system
// can prove a line's timing and speaker, or it must say plainly that it cannot —
// and "the provider gave us a number" is NOT proof. A segment whose words the
// aligner could not place does not become clean because a provider timestamp
// exists; that timestamp stays on the row as fallback evidence an operator can
// look at, and the row stays UNRESOLVED_TIMING until a human rules on it.
//
// FIVE STATES, ONE PER SEGMENT:
//   VALIDATED               every required piece of evidence passed; nothing was
//                           overridden. The only state that needs no explanation.
//   VALIDATED_WITH_OVERRIDE the system itself overrode something on evidence and
//                           disclosed it — an impossible provider capture
//                           rejected, an implausible aligned window replaced, an
//                           absorbed onset reconstructed, a provider boundary
//                           re-derived, or a search region expanded. Deliverable,
//                           but every one of these is answerable from the row.
//   UNRESOLVED_TIMING       timing could not be established: words the aligner
//                           could not place after bounded expansion, an alignment
//                           collapse, or a same-speaker overlap (one person
//                           cannot talk over themselves, so one of the two
//                           windows is wrong and we do not know which).
//   UNRESOLVED_SPEAKER      no pyannote turn covered this row's words, so
//                           attribution is a guess inherited from a neighbour.
//   MANUALLY_OVERRIDDEN     an operator explicitly accepted or changed an
//                           unresolved result, with attribution and a reason.
//
// PRECEDENCE IS FIXED so the state is deterministic from the same evidence:
//   MANUALLY_OVERRIDDEN > UNRESOLVED_TIMING > UNRESOLVED_SPEAKER
//                       > VALIDATED_WITH_OVERRIDE > VALIDATED
// Timing outranks speaker because a wrong window makes the attribution question
// unanswerable, not merely wrong. The two unresolved conditions are ALSO carried
// as independent booleans (unresolved_timing / unresolved_speaker) so a row
// holding both is fully queryable and the export gate can name both causes —
// collapsing them into one label would hide the second.
//
// SOC 2 CC7.4 / CC8.1 — the state and its one-line reason are derived only from
// evidence already persisted on the row, so an auditor can recompute it.
// =============================================================================

// v2 adds near-zero final acceptance as an unresolved cause. A word whose final
// window sits below the evidence floor with no corroboration from the other
// timeline occupies no audio — it is an absence of measurement, not a short word
// — so a row carrying one cannot be called validated merely because the duration
// is technically greater than zero.
// v3 adds the SPEAKER ISLAND as an unresolved-speaker cause. Diarization returns
// one speaker per instant, so on genuinely overlapping speech that single label is
// a choice rather than a measurement — and a covered word previously made the row
// VALIDATED with no signal to the operator. See speaker-islands.ts for the
// multi-signal rule; a row only reaches here already judged, never on duration.
// v4 recognises the reconciliation clearance (timeline-integrity policy v6) as a
// disclosed system override. A row whose earlier quarantine was withdrawn on
// evidence is deliverable, but it is NOT untouched: the system replaced or
// corroborated a timing and must say so in the state an operator reads.
// v5 adds the two TEXT-AUTHORITY causes (see text-authority.ts). Both exist
// because refinement must never silently replace human-authored text with
// machine words, and honouring that leaves two facts a row must be able to state:
//   • no_measured_words — an operator-authored line with NO provider word
//     timings was carried through unchanged (nothing was measured, so nothing
//     could be re-derived). Without this input such a row fell through every
//     check and landed on VALIDATED — "words, timings, boundary and speaker all
//     passed on evidence" — which is false for a row nothing was measured on.
//     Fabricating an unplaced-word count to force a quarantine would be worse:
//     it would claim the aligner failed on words that never existed.
//   • speaker_span_unresolved — refinement heard more than one speaker inside an
//     authoritative line and the line was kept whole rather than divided, so its
//     attribution is a choice and not a measurement.
// v6 adds ONE input, chronology_conflict, and changes nothing else. Boundary
// policy v2 detects a delivered timeline that goes backwards — row N+1 starting
// before row N, which happens when adjacent rows are resolved on different
// timelines (one derived from aligned words, its neighbour recovered from the
// preserved provider boundary). That is a timing fact no existing input could
// express: every other cause here describes something about a row's OWN words,
// while this one is a property of the row's position relative to its neighbour.
// Without it such a row could satisfy every per-row check and land on VALIDATED
// while sitting out of order in the programme.
export const SEGMENT_STATE_POLICY_VERSION = 6;

export type SegmentState =
  | 'VALIDATED'
  | 'VALIDATED_WITH_OVERRIDE'
  | 'UNRESOLVED_TIMING'
  | 'UNRESOLVED_SPEAKER'
  | 'MANUALLY_OVERRIDDEN';

/** States that may leave the building without an explicit operator decision. */
export const EXPORTABLE_STATES: SegmentState[] = ['VALIDATED', 'VALIDATED_WITH_OVERRIDE', 'MANUALLY_OVERRIDDEN'];

/** States that block a production export until an operator rules on them. */
export const BLOCKING_STATES: SegmentState[] = ['UNRESOLVED_TIMING', 'UNRESOLVED_SPEAKER'];

export type SegmentStateInput = {
  /** Operator already ruled on this row (timing_manual_override_at set). */
  timing_manual_override_at?: string | null;
  /** Words the alignment engine could not place after bounded expansion. */
  unresolved_alignment_word_count?: number;
  /** Words the engine placed only because its search region ran out of audio. */
  search_window_exhausted_word_count?: number;
  /**
   * Words whose FINAL accepted window is below the evidence floor and which the
   * provider timeline did not independently corroborate as brief speech.
   */
  near_zero_unresolved_word_count?: number;
  /** Aligner stacked words onto one instant and no substitution was usable. */
  alignment_collapsed?: boolean;
  /** Outstanding defect label from the timeline-integrity audit. */
  timing_defect?: string;
  /**
   * [Boundary policy v2] This row's final window is chronologically inverted
   * against its adjacent neighbour — it begins before the row that precedes it in
   * delivered order. Held as its own input rather than folded into timing_defect
   * because it is a fact about the row's POSITION, not about its words, and
   * because the boundary stage that detects it runs before the integrity audit.
   * Deliberately NOT excluded for music: elsewhere a music row is exempt because
   * it makes no claim about speech, but an out-of-order window is a claim about
   * ORDER and is wrong whatever the row contains.
   */
  chronology_conflict?: boolean;
  /**
   * [Boundary policy v2] Magnitude of the WORST inversion this row participates
   * in, in milliseconds, written onto the row by enforceChronology alongside
   * chronology_conflict. Read ONLY to name the distance in the operator-facing
   * reason — it is never compared against a threshold and never influences the
   * verdict, so an absent value degrades the sentence, never the state. Held
   * separately from timing_defect_ms because that field's meaning is defined by
   * whichever timing_defect label won precedence.
   */
  chronology_conflict_ms?: number;
  /** Words no pyannote turn covered. */
  speaker_unresolved_word_count?: number;
  /**
   * A pyannote turn DID cover this row, but the multi-signal speaker-island rule
   * judged the attribution unproven because the surrounding evidence favours
   * another speaker (see speaker-islands.ts). Held separately from
   * speaker_unresolved_word_count because the two are different facts: there the
   * provider was silent, here it answered and its answer is disputed on evidence.
   */
  speaker_island_in_overlap?: boolean;
  /** Plain-English reason supplied by the island rule, naming the favoured speaker. */
  speaker_island_reason?: string;
  /**
   * [Text authority, policy v5] This row's text is operator-authored and it has
   * NO provider word timings, so refinement carried its text, window, structure
   * and boundary through unchanged. Nothing about its timing was verified against
   * the audio, which is a different fact from "the aligner tried and failed" —
   * hence its own input rather than a fabricated unplaced-word count. Never set
   * on a music row (music makes no timing claim and is validated as such).
   */
  no_measured_words?: boolean;
  /**
   * [Text authority, policy v5] Refinement grouped this authoritative row's words
   * into more than one speaker span, and the row was kept whole rather than
   * divided (dividing operator-authored text means guessing which words belong to
   * which speaker). The carried speaker is therefore not proven.
   */
  speaker_span_unresolved?: boolean;
  /** Plain-English reason supplied with speaker_span_unresolved. */
  speaker_span_reason?: string;
  /**
   * [Reconciliation, policy v4] Words on this row whose engine-set unresolved
   * verdict a later stage provably resolved (an implausible aligned window replaced
   * by the provider's credible capture, or a brief window the provider
   * independently corroborated). Never reduces a quarantine on its own — the row's
   * remaining unresolved counts still decide that — but it does mean the delivered
   * timing carries a disclosed correction, so the row is VALIDATED_WITH_OVERRIDE.
   */
  unresolved_cleared_word_count?: number;
  /** Disclosed, already-applied system decisions. */
  capture_restored?: boolean;
  provider_timing_rejected?: boolean;
  onset_reconstructed?: boolean;
  /** Milliseconds of extra audio the aligner had to search beyond the provider window. */
  alignment_expansion_ms?: number;
  /** 'validated_words' = re-derived, 'validated_words_stable' = provider value agreed. */
  boundary_source?: string;
  /** Non-dialogue row: no words to validate, so no timing claim is made. */
  is_music?: boolean;
};

export type SegmentStateVerdict = {
  timing_state: SegmentState;
  timing_state_reason: string;
  unresolved_timing: boolean;
  unresolved_speaker: boolean;
  segment_state_policy_version: number;
};

/**
 * The reason used when a cross-row chronology conflict is the row's ONLY cause.
 * Named so the note appended to every other cause cannot duplicate it.
 */
const CHRONOLOGY_REASON = 'This line and the line next to it are out of order — one of them begins before the line that precedes it. The two were timed from sources that disagree about their order, so nothing was moved: correcting it automatically would mean guessing which of the two is in the right place.';

const count = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function deriveSegmentState(row: SegmentStateInput): SegmentStateVerdict {
  const unresolvedWords = count(row.unresolved_alignment_word_count);
  const exhaustedWords = count(row.search_window_exhausted_word_count);
  const nearZeroWords = count(row.near_zero_unresolved_word_count);
  const speakerUnresolved = count(row.speaker_unresolved_word_count);
  const collapsed = row.alignment_collapsed === true || row.timing_defect === 'alignment_collapse';
  const overlap = row.timing_defect === 'same_speaker_overlap';
  const divergence = row.timing_defect === 'provider_capture_divergence';
  const chronologyConflict = row.chronology_conflict === true;

  // An authoritative row carried through with nothing measured. Music is excluded
  // defensively: a non-dialogue row makes no timing claim and is validated as
  // such, so it must never be pulled into a timing quarantine by this input.
  const noMeasuredWords = row.no_measured_words === true && row.is_music !== true;

  const unresolved_timing = noMeasuredWords || unresolvedWords > 0 || exhaustedWords > 0 || nearZeroWords > 0
    || collapsed || overlap || divergence || chronologyConflict;
  const speakerIsland = row.speaker_island_in_overlap === true;
  const speakerSpan = row.speaker_span_unresolved === true;
  const unresolved_speaker = speakerUnresolved > 0 || speakerIsland || speakerSpan;

  // A chronology conflict frequently coexists with a word-level cause (on project
  // 6a85757eb3fb1626eb1fea43 rows 42 and 43 each ALSO carried unplaceable words).
  // Precedence is unchanged — the word-level cause still wins and still decides the
  // state — but the operator is told about the ordering problem as well, because a
  // reason that mentions only the words would send them to re-transcribe a line
  // whose real problem is that it sits in the wrong place.
  const chronologyNote = chronologyConflict
    ? ` This line is also out of order relative to the line next to it (by ${Math.round(Number(row.chronology_conflict_ms || 0))}ms); nothing was moved, because correcting that automatically would mean guessing which of the two is in the right place.`
    : '';

  const verdict = (timing_state: SegmentState, timing_state_reason: string): SegmentStateVerdict => ({
    timing_state,
    timing_state_reason: (chronologyNote && timing_state === 'UNRESOLVED_TIMING' && timing_state_reason !== CHRONOLOGY_REASON)
      ? `${timing_state_reason}${chronologyNote}`
      : timing_state_reason,
    unresolved_timing,
    unresolved_speaker,
    segment_state_policy_version: SEGMENT_STATE_POLICY_VERSION,
  });

  if (row.timing_manual_override_at) {
    return verdict('MANUALLY_OVERRIDDEN', 'An operator explicitly ruled on this line; see the recorded override.');
  }

  if (unresolved_timing) {
    if (noMeasuredWords) {
      return verdict('UNRESOLVED_TIMING', "This line's text was authored by an operator and has no measured word timings, so refinement carried its text, window and structure through unchanged. Its timing was not verified against the audio.");
    }
    if (unresolvedWords > 0) {
      return verdict('UNRESOLVED_TIMING', `${unresolvedWords} word(s) could not be placed in the audio after bounded search expansion. The transcriber's timing is kept visible as fallback evidence only — it is not validated timing.`);
    }
    if (exhaustedWords > 0) {
      return verdict('UNRESOLVED_TIMING', `${exhaustedWords} word(s) were placed against the edge of the available audio, so their position is not proven.`);
    }
    if (nearZeroWords > 0) {
      return verdict('UNRESOLVED_TIMING', `${nearZeroWords} word(s) ended up with a window too short to contain any speech, and the transcriber's own measurement does not agree that they are that brief.`);
    }
    if (collapsed) {
      return verdict('UNRESOLVED_TIMING', 'Several words were placed at the same instant and no usable alternative timing existed; a re-transcribe of this line is usually the cleanest fix.');
    }
    if (overlap) {
      return verdict('UNRESOLVED_TIMING', 'This line and another line by the same speaker cover the same moment, so one of the two windows is wrong.');
    }
    if (chronologyConflict) {
      return verdict('UNRESOLVED_TIMING', CHRONOLOGY_REASON);
    }
    return verdict('UNRESOLVED_TIMING', "The transcriber's measurement and the audio check disagree beyond the trust threshold and neither could be accepted on evidence.");
  }

  if (unresolved_speaker) {
    if (speakerUnresolved > 0) {
      return verdict('UNRESOLVED_SPEAKER', `No speaker turn covered ${speakerUnresolved} word(s) on this line, so its attribution was inherited from a neighbour rather than measured.`);
    }
    if (speakerSpan && !speakerIsland) {
      return verdict('UNRESOLVED_SPEAKER', row.speaker_span_reason
        || 'Refinement heard more than one speaker inside this operator-authored line. It was kept whole rather than divided, so its speaker attribution is not proven.');
    }
    return verdict('UNRESOLVED_SPEAKER', row.speaker_island_reason
      || 'Short speaker island inside overlapping speech; the surrounding evidence favors another speaker, so this attribution is not proven.');
  }

  if (row.is_music === true) {
    return verdict('VALIDATED', 'Non-dialogue line: no spoken words to validate, so its window is carried unchanged.');
  }

  const overrides: string[] = [];
  if (row.provider_timing_rejected === true) overrides.push("the transcriber's timing was overruled as physically impossible");
  if (row.capture_restored === true) overrides.push("the audio check's timing was replaced by the transcriber's measured window");
  if (row.onset_reconstructed === true) overrides.push('a word start was pulled forward out of untranscribed audio');
  if (count(row.unresolved_cleared_word_count) > 0) overrides.push(`${count(row.unresolved_cleared_word_count)} word(s) the aligner could not place credibly were resolved from the transcriber's own measurement`);
  if (count(row.alignment_expansion_ms) > 0) overrides.push(`the audio search was extended ${count(row.alignment_expansion_ms)}ms beyond the transcriber's segment boundary`);
  if (row.boundary_source === 'validated_words') overrides.push('the segment boundary was re-derived from the validated words');

  if (overrides.length) {
    return verdict('VALIDATED_WITH_OVERRIDE', `Delivered with disclosed evidence-based overrides: ${overrides.join('; ')}.`);
  }

  return verdict('VALIDATED', 'Words, timings, boundary and speaker all passed on evidence with nothing overridden.');
}

/** Summary for a run / export gate. Deterministic from the rows alone. */
export function summariseSegmentStates(rows: Array<{ timing_state?: string }>): {
  counts: Record<SegmentState, number>;
  blocking_count: number;
  total_segment_count: number;
  policy_version: number;
} {
  const counts = {
    VALIDATED: 0,
    VALIDATED_WITH_OVERRIDE: 0,
    UNRESOLVED_TIMING: 0,
    UNRESOLVED_SPEAKER: 0,
    MANUALLY_OVERRIDDEN: 0,
  } as Record<SegmentState, number>;
  for (const row of rows || []) {
    const state = String(row?.timing_state || '') as SegmentState;
    if (state in counts) counts[state] += 1;
  }
  return {
    counts,
    blocking_count: BLOCKING_STATES.reduce((total, state) => total + counts[state], 0),
    // Carried so a consumer can verify the counts SUM to the rows they describe.
    // A state total that does not reconcile to the row count means some row holds
    // an unrecognised state, which must surface as a failure rather than a
    // silently smaller number.
    total_segment_count: (rows || []).length,
    policy_version: SEGMENT_STATE_POLICY_VERSION,
  };
}
