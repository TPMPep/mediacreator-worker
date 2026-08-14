// =============================================================================
// timeline-integrity — post-reconciliation timeline audit for speaker refinement.
// -----------------------------------------------------------------------------
// Runs AFTER the pyannote reconciler has grouped acoustically-aligned words into
// output segments, and BEFORE those segments are staged. Two independent defect
// classes, one shared posture.
//
// POSTURE — repair the benign band, quarantine the rest, never destroy data,
// never veto the run:
//   • A same-speaker overlap is ALWAYS a data defect. One person cannot talk over
//     themselves, so an overlap here means a word was attributed to the wrong
//     segment. Sub-threshold overlaps are boundary rounding and are repaired by
//     pulling the earlier segment's end back to the later one's start. Anything
//     larger is a real attribution error a human must see, so it is FLAGGED and
//     left byte-intact — trimming it silently would hide the defect and destroy
//     the evidence.
//   • Provider-capture divergence: the stored `aai_word_timings` is deliberately
//     the IMMUTABLE provider capture while the segment window is derived from the
//     ACOUSTIC (forced-alignment) timeline. A small difference is the expected
//     alignment shift. A multi-second difference means the provider smeared or
//     misplaced that word — the signature of overlapping speech masking a voice —
//     so the capture no longer describes the same audio as its own segment. The
//     rythmo band renders from that capture, which is exactly how this reaches an
//     operator as "the words don't match what I hear."
//
// WHY THIS NEVER FAILS THE RUN: a whole-run veto over a handful of outlier words
// was already tried and discarded (see alignment-client's quality policy — one
// outlier in ~8,000 words aborted a paid dual-model run and blocked an otherwise
// usable transcript). Cross-speaker overlap is intentionally NOT touched here:
// two people genuinely can speak at once, and the final mixer sums overlapping
// clips by design.
//
// SOC 2 CC7.4 / CC8.1 — every repair is counted and every defect is attributable
// to the run that detected it, from the row alone.
// =============================================================================

export const TIMELINE_INTEGRITY_POLICY_VERSION = 1;

// Below this, an overlap is boundary rounding between two adjacent same-speaker
// groups and is safe to repair deterministically.
export const AUTO_REPAIR_CEILING_MS = 250;
// Ignore sub-frame noise entirely — not a defect, not worth a repair record.
export const OVERLAP_EPSILON_MS = 10;
// A provider word whose own window sits this far from its acoustically-verified
// window is not drift; it is a misplaced or smeared capture.
export const PROVIDER_CAPTURE_DIVERGENCE_MS = 1500;

export type IntegrityWord = { text?: string; start_ms: number; end_ms: number; provider_start_ms?: number; provider_end_ms?: number };
export type IntegrityRow = {
  sequence_index: number;
  start_ms: number;
  end_ms: number;
  tc_out: string;
  speaker_id?: string;
  speaker_label?: string;
  is_music?: boolean;
  aai_word_timings?: IntegrityWord[];
  _alignment?: { status?: string; words?: IntegrityWord[]; max_provider_shift_ms?: number };
  timing_defect?: string;
  timing_defect_ms?: number;
};

export type IntegrityReport = {
  policy_version: number;
  auto_repair_ceiling_ms: number;
  provider_divergence_threshold_ms: number;
  same_speaker_overlap_repairs: number;
  same_speaker_overlap_defects: number;
  provider_capture_defects: number;
  worst_same_speaker_overlap_ms: number;
  worst_provider_divergence_ms: number;
  defect_sequences: number[];
};

// Pull every word ending past `boundary` back to it. A word starting at or after
// the boundary cannot be clamped without erasing it, so the caller checks for
// that case first and flags instead of repairing.
function clampWordsTo(words: IntegrityWord[] | undefined, boundary: number): IntegrityWord[] {
  return (words || []).map((word) => {
    if (!Number.isFinite(word?.start_ms) || !Number.isFinite(word?.end_ms) || word.end_ms <= boundary) return word;
    if (word.start_ms >= boundary) return word;
    return { ...word, end_ms: boundary };
  });
}

function wouldEraseAWord(row: IntegrityRow, boundary: number): boolean {
  const beyond = (words?: IntegrityWord[]) => (words || []).some((word) => Number(word?.start_ms) >= boundary);
  return beyond(row._alignment?.words) || beyond(row.aai_word_timings);
}

// Keep the archived alignment evidence self-consistent after a repair: the
// recorded shift must describe the timings actually stored on the row.
function recomputeMaxShift(words: IntegrityWord[] | undefined): number {
  let worst = 0;
  for (const word of words || []) {
    const startShift = Math.abs(Number(word.start_ms) - Number(word.provider_start_ms));
    const endShift = Math.abs(Number(word.end_ms) - Number(word.provider_end_ms));
    const shift = Math.max(Number.isFinite(startShift) ? startShift : 0, Number.isFinite(endShift) ? endShift : 0);
    if (shift > worst) worst = shift;
  }
  return Math.round(worst);
}

function flag(row: IntegrityRow, kind: string, magnitudeMs: number): boolean {
  // First defect wins so a row is never relabelled by a later, smaller finding.
  if (row.timing_defect) return false;
  row.timing_defect = kind;
  row.timing_defect_ms = Math.round(magnitudeMs);
  return true;
}

/**
 * Audit and (where safe) repair the reconciled timeline IN PLACE.
 *
 * @param rows reconciled output segments, carrying `_alignment.words`
 * @param formatTimecode caller's timecode formatter, so this module never owns a
 *                       second frame-rate convention that could drift from the
 *                       reconciler's own.
 */
export function auditTimelineIntegrity(rows: IntegrityRow[], formatTimecode: (ms: number) => string): IntegrityReport {
  const report: IntegrityReport = {
    policy_version: TIMELINE_INTEGRITY_POLICY_VERSION,
    auto_repair_ceiling_ms: AUTO_REPAIR_CEILING_MS,
    provider_divergence_threshold_ms: PROVIDER_CAPTURE_DIVERGENCE_MS,
    same_speaker_overlap_repairs: 0,
    same_speaker_overlap_defects: 0,
    provider_capture_defects: 0,
    worst_same_speaker_overlap_ms: 0,
    worst_provider_divergence_ms: 0,
    defect_sequences: [],
  };

  // ── Pass 1: provider capture vs acoustic truth ────────────────────────────
  for (const row of rows) {
    if (row.is_music) continue;
    let worst = 0;
    for (const word of row._alignment?.words || []) {
      const startGap = Math.abs(Number(word.start_ms) - Number(word.provider_start_ms));
      const endGap = Math.abs(Number(word.end_ms) - Number(word.provider_end_ms));
      const gap = Math.max(Number.isFinite(startGap) ? startGap : 0, Number.isFinite(endGap) ? endGap : 0);
      if (gap > worst) worst = gap;
    }
    if (worst > PROVIDER_CAPTURE_DIVERGENCE_MS) {
      if (flag(row, 'provider_capture_divergence', worst)) report.provider_capture_defects += 1;
      if (worst > report.worst_provider_divergence_ms) report.worst_provider_divergence_ms = Math.round(worst);
    }
  }

  // ── Pass 2: same-speaker overlap ──────────────────────────────────────────
  // Chronological sweep holding the furthest-reaching segment per speaker, so a
  // segment fully contained inside a longer one is still compared against it.
  const ordered = [...rows].sort((a, b) => (Number(a.start_ms) - Number(b.start_ms)) || (Number(a.end_ms) - Number(b.end_ms)));
  const furthestBySpeaker = new Map<string, IntegrityRow>();

  for (const row of ordered) {
    const speaker = String(row.speaker_id || row.speaker_label || '');
    const previous = furthestBySpeaker.get(speaker);
    if (previous) {
      const overlapMs = Number(previous.end_ms) - Number(row.start_ms);
      if (overlapMs > OVERLAP_EPSILON_MS) {
        if (overlapMs > report.worst_same_speaker_overlap_ms) report.worst_same_speaker_overlap_ms = Math.round(overlapMs);
        const boundary = Number(row.start_ms);
        const repairable = overlapMs <= AUTO_REPAIR_CEILING_MS
          && boundary > Number(previous.start_ms)
          && !wouldEraseAWord(previous, boundary);
        if (repairable) {
          if (previous._alignment) {
            previous._alignment.words = clampWordsTo(previous._alignment.words, boundary);
            previous._alignment.max_provider_shift_ms = recomputeMaxShift(previous._alignment.words);
          }
          previous.aai_word_timings = clampWordsTo(previous.aai_word_timings, boundary);
          previous.end_ms = boundary;
          previous.tc_out = formatTimecode(boundary);
          report.same_speaker_overlap_repairs += 1;
        } else {
          // Left byte-intact on purpose: the overlap IS the evidence.
          const flaggedPrevious = flag(previous, 'same_speaker_overlap', overlapMs);
          const flaggedCurrent = flag(row, 'same_speaker_overlap', overlapMs);
          if (flaggedPrevious || flaggedCurrent) report.same_speaker_overlap_defects += 1;
        }
      }
    }
    if (!previous || Number(row.end_ms) > Number(previous.end_ms)) furthestBySpeaker.set(speaker, row);
  }

  report.defect_sequences = rows
    .filter((row) => !!row.timing_defect)
    .map((row) => Number(row.sequence_index))
    .sort((a, b) => a - b);

  return report;
}
