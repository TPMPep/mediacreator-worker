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
export const SEGMENT_STATE_POLICY_VERSION = 2;

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
  /** Words no pyannote turn covered. */
  speaker_unresolved_word_count?: number;
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

  const unresolved_timing = unresolvedWords > 0 || exhaustedWords > 0 || nearZeroWords > 0
    || collapsed || overlap || divergence;
  const unresolved_speaker = speakerUnresolved > 0;

  const verdict = (timing_state: SegmentState, timing_state_reason: string): SegmentStateVerdict => ({
    timing_state,
    timing_state_reason,
    unresolved_timing,
    unresolved_speaker,
    segment_state_policy_version: SEGMENT_STATE_POLICY_VERSION,
  });

  if (row.timing_manual_override_at) {
    return verdict('MANUALLY_OVERRIDDEN', 'An operator explicitly ruled on this line; see the recorded override.');
  }

  if (unresolved_timing) {
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
    return verdict('UNRESOLVED_TIMING', "The transcriber's measurement and the audio check disagree beyond the trust threshold and neither could be accepted on evidence.");
  }

  if (unresolved_speaker) {
    return verdict('UNRESOLVED_SPEAKER', `No speaker turn covered ${speakerUnresolved} word(s) on this line, so its attribution was inherited from a neighbour rather than measured.`);
  }

  if (row.is_music === true) {
    return verdict('VALIDATED', 'Non-dialogue line: no spoken words to validate, so its window is carried unchanged.');
  }

  const overrides: string[] = [];
  if (row.provider_timing_rejected === true) overrides.push("the transcriber's timing was overruled as physically impossible");
  if (row.capture_restored === true) overrides.push("the audio check's timing was replaced by the transcriber's measured window");
  if (row.onset_reconstructed === true) overrides.push('a word start was pulled forward out of untranscribed audio');
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
