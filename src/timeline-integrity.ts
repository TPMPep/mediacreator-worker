// =============================================================================
// timeline-integrity — acoustic-onset repair + post-reconciliation timeline audit
// for speaker refinement.
// -----------------------------------------------------------------------------
// TWO STAGES, ONE POSTURE: repair what is provably reconstructible, quarantine
// what a human must judge, never destroy data, never veto the run.
//
// ── STAGE 1: clampAcousticOnsets (runs BEFORE the reconciler groups words) ───
// Forced alignment must account for EVERY millisecond of audio between words.
// Where the transcription provider left audio un-transcribed — music, scene
// atmosphere, unintelligible overlap — the aligner has nowhere to put that time,
// so it ABSORBS it into the ONSET of the next word. Ground truth from project
// 6a6c561ef670f3992db756d0 (run 6a7f82ab26879b8abe258698): the single word
// "Enhorabuena," was returned as 1,824,077 → 1,979,217 ms — a 155-SECOND word.
// The provider captured it as 1,978,896 → 1,980,474 (1.578s). The END was
// corroborated within 1.2s; only the onset was dragged backward across 2.5
// minutes of non-dialogue audio. 29 of that run's 37 ceiling violations were
// segment-INITIAL words, and there were ZERO cross-speaker overlaps inside the
// absorbed span — nobody else speaks there, confirming the absorbed time is
// genuinely unaccounted audio rather than mis-attributed dialogue.
//
// WHY THIS MATTERS BEYOND DISPLAY: the reconciler derives a segment's window
// from its first word's start and last word's end, so one absorbed onset became
// a 155-second segment. That window drives the rythmo band, voice-generation
// time-fit, and export placement — a dub stretched across 2.5 minutes.
//
// WHY THE QUALITY GATE DID NOT CATCH IT — BY DESIGN: assertAlignmentQuality
// judges the DISTRIBUTION (p99 6,973ms under the 30,000ms ceiling; >30s outlier
// ratio 0.00072 under the 0.005 limit). Refusing to veto a paid run over a
// handful of outlier words is the correct posture and is deliberately unchanged.
// The gap was that a word the gate TOLERATED still silently defined a segment
// window. This module closes that gap at the point of CONSUMPTION.
//
// THE REPAIR REUSES A PROVEN POLICY, it does not invent one. The rate-aware
// ceiling below is the SAME policy as lib/segment-shaping.js's Pass 0 word-
// duration guard, which exists for the MIRROR-IMAGE defect (a provider padding a
// word's END forward) and documents that it never touches a start — so it is
// structurally unable to catch onset absorption. Here we keep the corroborated
// END and pull the START forward to (end − ceiling), never earlier than the
// previous word's end. The absorbed span then surfaces as an HONEST, visible
// timeline gap — never fabricated words, never a silently inflated window.
// A repaired onset is a DERIVED value, so it is always attributed: the row is
// flagged 'onset_reconstructed' and the count lands on the run.
// PARITY: src/lib/__tests__/word-duration-ceiling-parity.test.js locks these
// constants against lib/segment-shaping.js. A drift is a failing test.
//
// ── STAGE 2: auditTimelineIntegrity (runs AFTER grouping, BEFORE staging) ───
//   • SAME-SPEAKER OVERLAP is ALWAYS a data defect. One person cannot talk over
//     themselves, so an overlap means a word was attributed to the wrong
//     segment. Sub-ceiling overlaps are boundary rounding and are repaired by
//     pulling the earlier segment's end back. Anything larger is flagged and
//     left byte-intact — trimming it silently would destroy the evidence.
//   • PROVIDER-CAPTURE DIVERGENCE: aai_word_timings is the IMMUTABLE provider
//     capture while the window comes from the ACOUSTIC timeline. A small
//     difference is expected alignment shift; a multi-second one means the
//     capture no longer describes the same audio as its own segment. The rythmo
//     band renders from that capture, which is how this reaches an operator as
//     "the words don't match what I hear."
//
// CROSS-SPEAKER overlap is intentionally NEVER flagged: two people genuinely can
// speak at once and the final mixer sums overlapping clips by design.
//
// SOC 2 CC7.4 / CC8.1 — every repair is counted and every defect is attributable
// to the run that detected it, from the row alone.
// =============================================================================

// v3 adds STAGE 0 (restoreDivergedCaptures). Pinned onto every report, so a run
// delivered under v2 is never retroactively reinterpreted under v3's rules.
export const TIMELINE_INTEGRITY_POLICY_VERSION = 3;

// Below this, an overlap is boundary rounding between two adjacent same-speaker
// groups and is safe to repair deterministically.
export const AUTO_REPAIR_CEILING_MS = 250;
// Ignore sub-frame noise entirely — not a defect, not worth a repair record.
export const OVERLAP_EPSILON_MS = 10;
// A provider word whose own window sits this far from its acoustically-verified
// window is not drift; it is a misplaced or smeared capture.
export const PROVIDER_CAPTURE_DIVERGENCE_MS = 1500;

// ── Rate-aware word-duration ceiling (mirrors lib/segment-shaping.js) ────────
// 14 cps is the conversational-pace fallback the translation pipeline uses; the
// 2.5x safety factor means only clearly pathological spans are touched. A loose
// ceiling leaves "anticonstitutionnellement" (25 chars → ~4.4s allowed) fully
// intact while catching a 155-second "Enhorabuena,".
export const WORD_MS_PER_CHAR = 1000 / 14;
export const WORD_DURATION_SAFETY_FACTOR = 2.5;
export const WORD_MAX_DURATION_FLOOR_MS = 1500;

/** Realistic maximum spoken duration for a single word, given its text. */
export function maxWordDurationMs(text: string | undefined): number {
  const chars = String(text || '').replace(/\s+/g, '').length || 1;
  return Math.max(WORD_MAX_DURATION_FLOOR_MS, Math.round(chars * WORD_MS_PER_CHAR * WORD_DURATION_SAFETY_FACTOR));
}

export type AlignedWord = {
  key: string;
  text: string;
  start_ms: number;
  end_ms: number;
  confidence?: number;
  onset_reconstructed?: boolean;
  onset_absorbed_ms?: number;
  capture_restored?: boolean;
  capture_divergence_ms?: number;
};

export type OnsetRepairReport = {
  onset_absorption_repairs: number;
  worst_onset_absorbed_ms: number;
  repaired_keys: string[];
};

export type ProviderWindow = { start_ms: number; end_ms: number };

export type CaptureRestoreReport = {
  capture_restored_words: number;
  unrestorable_words: number;
  worst_restored_divergence_ms: number;
  restored_keys: string[];
};

/**
 * STAGE 0 — restore the provider's measured window for any word whose
 * acoustically-aligned window diverges beyond the trust threshold.
 *
 * THE INCOHERENCE THIS REMOVES: the audit downstream already declares a word
 * with multi-second provider-vs-acoustic divergence untrustworthy — and then the
 * reconciler used that same rejected value to decide the two most consequential
 * facts about the line: WHERE IT BREAKS and WHO IS SPEAKING. Flagging a number
 * as unreliable and then making irreversible decisions from it is not a policy;
 * it is two policies disagreeing inside one pass.
 *
 * GROUND TRUTH (project 6a6c561ef670f3992db756d0): the word "prices." was
 * captured by the provider at 241,077 → 241,547 and aligned at 241,973 →
 * 243,473 — a 1,926ms divergence, flagged as a defect. Consequences of trusting
 * the aligned value: the gap after the preceding word "oil" (ends 240,963)
 * became ~1,010ms instead of 114ms, crossing the 650ms breath boundary in
 * lib/segment-shaping.js, so the word was split onto its own line; and that
 * line now sat inside a span pyannote had correctly attributed to a DIFFERENT
 * speaker (an untranscribed foreign-language voice), so the word inherited the
 * wrong speaker. One rejected timing produced a spurious line break AND a
 * misattributed speaker — both of which reached the operator as separate,
 * unexplained defects.
 *
 * WHY THE PROVIDER WINS THIS TIE, specifically: the provider is the actor that
 * heard the word and emitted it, so its window is direct evidence. The aligner
 * is normally the more precise of the two — that is why it runs — but its
 * failure mode is structural, not noisy: it must account for every millisecond
 * between words, so wherever the provider left audio untranscribed (music, room
 * tone, unintelligible or foreign speech) it has nowhere to put that time and
 * slides a real word across it. A multi-second disagreement is therefore the
 * SIGNATURE of that failure, not evidence of a better measurement. Below the
 * threshold the aligned value is kept unconditionally.
 *
 * MONOTONICITY IS NEVER TRADED AWAY. Substituting one word's window inside an
 * otherwise-aligned stream could push it behind a word already accepted. A
 * restore is therefore applied ONLY when the provider window is internally
 * valid AND starts at or after the furthest accepted end. Otherwise the aligned
 * value is left exactly as it was and counted as unrestorable — where the
 * existing divergence check still flags it, so an unrepairable word is quietly
 * dropped from neither the timeline nor the audit.
 *
 * NOTHING IS DESTROYED: the raw provider response and the raw alignment
 * response are both archived to immutable storage before this runs, and
 * aai_word_timings keeps the untouched provider capture. Every restored word is
 * disclosed on its row (capture_restored) and counted on the run.
 *
 * SOC 2 CC7.4 / CC8.1 — a derived timing decision is never silent, and the
 * policy that produced it is pinned per run.
 */
export function restoreDivergedCaptures(
  words: AlignedWord[],
  providerByKey: Map<string, ProviderWindow>,
): { words: AlignedWord[]; report: CaptureRestoreReport } {
  const restoredKeys: string[] = [];
  let unrestorable = 0;
  let worst = 0;
  const out: AlignedWord[] = [];
  let furthestEnd = -Infinity;

  for (const word of words || []) {
    const alignedStart = Number(word?.start_ms);
    const alignedEnd = Number(word?.end_ms);
    const keep = () => {
      out.push(word);
      if (Number.isFinite(alignedEnd)) furthestEnd = Math.max(furthestEnd, alignedEnd);
    };

    const provider = providerByKey.get(String(word?.key));
    if (!provider || !Number.isFinite(alignedStart) || !Number.isFinite(alignedEnd)) { keep(); continue; }

    const providerStart = Number(provider.start_ms);
    const providerEnd = Number(provider.end_ms);
    const divergence = Math.max(Math.abs(alignedStart - providerStart), Math.abs(alignedEnd - providerEnd));
    if (!Number.isFinite(divergence) || divergence <= PROVIDER_CAPTURE_DIVERGENCE_MS) { keep(); continue; }

    const usable = Number.isFinite(providerStart)
      && Number.isFinite(providerEnd)
      && providerEnd > providerStart
      && providerStart >= furthestEnd;
    if (!usable) { unrestorable += 1; keep(); continue; }

    const rounded = Math.round(divergence);
    if (rounded > worst) worst = rounded;
    restoredKeys.push(String(word.key));
    out.push({ ...word, start_ms: providerStart, end_ms: providerEnd, capture_restored: true, capture_divergence_ms: rounded });
    furthestEnd = Math.max(furthestEnd, providerEnd);
  }

  return {
    words: out,
    report: {
      capture_restored_words: restoredKeys.length,
      unrestorable_words: unrestorable,
      worst_restored_divergence_ms: worst,
      restored_keys: restoredKeys.slice(0, 200),
    },
  };
}

/**
 * STAGE 1 — pull absorbed onsets forward to a plausible word start.
 *
 * Operates on the FLAT, chronologically-ordered alignment word list (the whole
 * programme in one pass) so the previous word's already-repaired end is always
 * available as the floor. Returns a NEW array; the input is never mutated, and
 * the raw provider response is archived untouched before this runs.
 *
 * A word's END is always kept — it is the corroborated edge. Only an onset that
 * implies a physically impossible duration is moved.
 */
export function clampAcousticOnsets(words: AlignedWord[]): { words: AlignedWord[]; report: OnsetRepairReport } {
  const repairedKeys: string[] = [];
  let worstAbsorbed = 0;
  const out: AlignedWord[] = [];
  let previousEnd = -Infinity;

  for (const word of words || []) {
    const start = Number(word?.start_ms);
    const end = Number(word?.end_ms);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      out.push(word);
      if (Number.isFinite(end)) previousEnd = Math.max(previousEnd, end);
      continue;
    }
    const ceiling = maxWordDurationMs(word.text);
    if (end - start <= ceiling) {
      out.push(word);
      previousEnd = Math.max(previousEnd, end);
      continue;
    }
    // Absorbed onset. Reconstruct the start from the corroborated end, but never
    // earlier than the previous word's end (that span belongs to the neighbour).
    const floor = Number.isFinite(previousEnd) ? Math.max(previousEnd, start) : start;
    const reconstructed = Math.max(end - ceiling, floor);
    if (reconstructed <= start) {
      // Clamp would be a no-op (a genuinely fast follow-on) — leave it be.
      out.push(word);
      previousEnd = Math.max(previousEnd, end);
      continue;
    }
    const absorbed = Math.round(reconstructed - start);
    if (absorbed > worstAbsorbed) worstAbsorbed = absorbed;
    repairedKeys.push(word.key);
    out.push({ ...word, start_ms: reconstructed, onset_reconstructed: true, onset_absorbed_ms: absorbed });
    previousEnd = Math.max(previousEnd, end);
  }

  return {
    words: out,
    report: {
      onset_absorption_repairs: repairedKeys.length,
      worst_onset_absorbed_ms: worstAbsorbed,
      repaired_keys: repairedKeys.slice(0, 200),
    },
  };
}

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
  // Applied-repair disclosure — independent of timing_defect (see DEFECT_SEVERITY).
  onset_reconstructed?: boolean;
  onset_absorbed_ms?: number;
  capture_restored?: boolean;
  capture_restored_ms?: number;
};

export type IntegrityReport = {
  policy_version: number;
  auto_repair_ceiling_ms: number;
  provider_divergence_threshold_ms: number;
  same_speaker_overlap_repairs: number;
  same_speaker_overlap_defects: number;
  provider_capture_defects: number;
  onset_reconstructed_rows: number;
  onset_absorption_repairs: number;
  worst_onset_absorbed_ms: number;
  // STAGE 0 evidence. capture_restored_words counts words whose rejected aligned
  // window was replaced by the provider's measured one; unrestorable_capture_words
  // counts words that could NOT be restored without breaking chronological order
  // and therefore remain flagged for a human. A rising unrestorable count means
  // the aligner is drifting far enough to reorder the timeline, which no
  // downstream repair can fix — it has to be addressed upstream.
  capture_restored_words: number;
  capture_restored_rows: number;
  unrestorable_capture_words: number;
  worst_restored_divergence_ms: number;
  worst_same_speaker_overlap_ms: number;
  worst_provider_divergence_ms: number;
  // Segment-scale absorption evidence. inflated_row_count is the number of rows
  // whose window exceeds their own provider capture by more than the divergence
  // threshold — expected to be ZERO once alignment chunks are silence-bounded, so
  // a non-zero value here is the regression signal for that fix.
  worst_acoustic_inflation_ms: number;
  inflated_row_count: number;
  defect_sequences: number[];
};

// Severity ordering for the single timing_defect label a row can carry. A row is
// labelled by its MOST actionable finding, never by whichever check ran first.
// Before this, a segment whose absorbed onset CAUSED an overlap was labelled a
// divergence while its victims were labelled overlaps — so the review queue
// pointed at casualties instead of causes.
//
// ONSET RECONSTRUCTION IS DELIBERATELY ABSENT HERE. It is an already-APPLIED
// repair, not an outstanding defect, and it lives on its own independent fields
// (onset_reconstructed / onset_absorbed_ms). Ranking it against real defects made
// the disclosure unreachable in practice: a reconstructed onset is BY DEFINITION a
// multi-second provider-vs-acoustic gap, so it always also tripped the divergence
// check and was always relabelled — the ground-truth 155s repair on project
// 6a6c561ef670f3992db756d0 produced ZERO onset-labelled rows. A repair and a defect
// are orthogonal facts about a row; one field cannot express both without losing one.
const DEFECT_SEVERITY: Record<string, number> = {
  provider_capture_divergence: 1,  // capture no longer describes its own audio
  same_speaker_overlap: 2,         // attribution error; a human must judge it
};

function flag(row: IntegrityRow, kind: string, magnitudeMs: number): boolean {
  const current = row.timing_defect ? (DEFECT_SEVERITY[row.timing_defect] || 0) : 0;
  const next = DEFECT_SEVERITY[kind] || 0;
  if (current >= next) return false;
  row.timing_defect = kind;
  row.timing_defect_ms = Math.round(magnitudeMs);
  return true;
}

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

/**
 * STAGE 2 — audit and (where safe) repair the reconciled timeline IN PLACE.
 *
 * @param rows reconciled output segments, carrying `_alignment.words`. Rows a
 *             Stage-1 onset repair touched arrive pre-flagged 'onset_reconstructed';
 *             a more actionable finding here upgrades that label.
 * @param formatTimecode caller's timecode formatter, so this module never owns a
 *                       second frame-rate convention that could drift from the
 *                       reconciler's own.
 * @param onsetRepair Stage-1 summary, folded into the run-level report.
 */
export function auditTimelineIntegrity(
  rows: IntegrityRow[],
  formatTimecode: (ms: number) => string,
  onsetRepair?: OnsetRepairReport,
  captureRestore?: CaptureRestoreReport,
): IntegrityReport {
  const report: IntegrityReport = {
    policy_version: TIMELINE_INTEGRITY_POLICY_VERSION,
    auto_repair_ceiling_ms: AUTO_REPAIR_CEILING_MS,
    provider_divergence_threshold_ms: PROVIDER_CAPTURE_DIVERGENCE_MS,
    same_speaker_overlap_repairs: 0,
    same_speaker_overlap_defects: 0,
    provider_capture_defects: 0,
    onset_reconstructed_rows: 0,
    onset_absorption_repairs: onsetRepair?.onset_absorption_repairs || 0,
    worst_onset_absorbed_ms: onsetRepair?.worst_onset_absorbed_ms || 0,
    capture_restored_words: captureRestore?.capture_restored_words || 0,
    capture_restored_rows: 0,
    unrestorable_capture_words: captureRestore?.unrestorable_words || 0,
    worst_restored_divergence_ms: captureRestore?.worst_restored_divergence_ms || 0,
    worst_same_speaker_overlap_ms: 0,
    worst_provider_divergence_ms: 0,
    worst_acoustic_inflation_ms: 0,
    inflated_row_count: 0,
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
    // SPAN INFLATION — the measure a per-word check structurally cannot see.
    // Absorbed time distributed across many words keeps every individual word's
    // shift under the threshold while the SEGMENT still ends up seconds too long.
    // Ground truth: a row whose provider capture held 1,784ms of speech carried a
    // 4,240ms window and was never flagged, because no single word moved far enough.
    // Comparing the whole span against the provider's own span closes that hole, so
    // an inflated window can never reach a reviewer silently — whatever shape the
    // absorption takes. Same defect class (capture and acoustic timeline disagree),
    // measured at segment scale, so the magnitude reports the worst evidence found.
    const capture = row.aai_word_timings || [];
    if (capture.length) {
      const captureSpan = Number(capture[capture.length - 1].end_ms) - Number(capture[0].start_ms);
      const acousticSpan = Number(row.end_ms) - Number(row.start_ms);
      const inflation = acousticSpan - captureSpan;
      if (Number.isFinite(inflation) && inflation > 0) {
        if (inflation > report.worst_acoustic_inflation_ms) report.worst_acoustic_inflation_ms = Math.round(inflation);
        if (inflation > PROVIDER_CAPTURE_DIVERGENCE_MS) report.inflated_row_count += 1;
        if (inflation > worst) worst = inflation;
      }
    }
    if (worst > PROVIDER_CAPTURE_DIVERGENCE_MS) {
      flag(row, 'provider_capture_divergence', worst);
      report.provider_capture_defects += 1;
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
          // Left byte-intact on purpose: the overlap IS the evidence. BOTH sides
          // are flagged — the reviewer needs the pair, not one half of it.
          flag(previous, 'same_speaker_overlap', overlapMs);
          flag(row, 'same_speaker_overlap', overlapMs);
          report.same_speaker_overlap_defects += 1;
        }
      }
    }
    if (!previous || Number(row.end_ms) > Number(previous.end_ms)) furthestBySpeaker.set(speaker, row);
  }

  // Counted from the independent disclosure flag, NOT from a defect label — the
  // label is claimed by whichever outstanding defect the row also carries.
  report.onset_reconstructed_rows = rows.filter((row) => row.onset_reconstructed === true).length;
  report.capture_restored_rows = rows.filter((row) => row.capture_restored === true).length;
  report.defect_sequences = rows
    .filter((row) => !!row.timing_defect)
    .map((row) => Number(row.sequence_index))
    .sort((a, b) => a - b);

  return report;
}
