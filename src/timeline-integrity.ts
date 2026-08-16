// =============================================================================
// timeline-integrity — timing arbitration + post-reconciliation timeline audit
// for speaker refinement.
// -----------------------------------------------------------------------------
// THREE STAGES, ONE POSTURE: decide each disputed timing from EVIDENCE, repair
// what is provably reconstructible, quarantine what a human must judge, never
// destroy data, never veto the run.
//
// ── STAGE 0: restoreDivergedCaptures — plausibility arbitration ──────────────
// Two timelines describe every word: the transcription provider's measured
// capture, and the acoustic forced-alignment window. When they disagree by
// seconds, ONE of them is wrong and the reconciler must not decide the line
// break and the speaker from the wrong one.
//
// THE RULE THIS REPLACED WAS WRONG, and the evidence is unambiguous. Policy v3
// said "provider wins any divergence beyond the threshold." Ground truth,
// project 6a7d874aa2ddd372f426a4df row 28 ("Now its state media are reporting
// millions of people"): the provider captured 9 words / ~50 characters inside
// 1,346ms — 37 characters per second, against a conversational 14. Physically
// impossible. The aligner placed the same words across 2,761ms (18 cps), which
// also fits exactly in the measured gap between the neighbouring rows. Under v3
// the provider would have overwritten a CORRECT acoustic timeline with an
// impossible one; the only thing that stopped it was the monotonicity guard
// refusing the write. A guard accidentally preventing a corrupting repair is not
// a policy working — it is a policy surviving.
//
// THE DISCRIMINATOR IS PLAUSIBILITY, NOT PROVENANCE. Neither actor is
// authoritative by identity; each candidate window is judged against the same
// rate-aware ceiling used everywhere else in the pipeline, plus a floor below
// which a window describes no speech at all:
//   • aligned implausible, provider plausible  → restore the provider window
//       (row 16 "News.": provider 210ms, aligner stretched it to 2,000ms across
//        1.86s of untranscribed station-ident music — real absorption)
//   • provider implausible, aligned plausible  → KEEP the aligned window and
//       record that the provider's timing was rejected (row 28 above; row 29,
//       where the provider emitted six ZERO-WIDTH words)
//   • both plausible                            → keep aligned; it is measured
//       against the audio, which is why alignment runs at all
//   • neither plausible                         → change nothing, flag for a
//       human (row 17: five words stacked at 93,986→93,987, and a provider
//       alternative running at 57 cps — no substitution can rescue this)
//
// ALIGNMENT COLLAPSE is now detected explicitly. When the aligner runs out of
// room it stacks several words on ONE instant (row 17's five 1ms words share a
// single window; row 29 stacks six). Max per-word divergence there was 944ms —
// UNDER the 1,500ms threshold — so no previous check saw it, and five words
// would render on the rythmo band at the same moment with nothing flagged. Any
// run of COLLAPSE_STACK_MIN_WORDS identical windows is a defect regardless of
// divergence.
//
// RUNS ARE ARBITRATED TOGETHER, not word by word. A provider window substituted
// alone collides with neighbours still on the aligned timeline; the whole
// contiguous disputed run moves as one, and only if it fits between the last
// accepted word and the next one. MONOTONICITY IS NEVER TRADED FOR A REPAIR.
//
// ── STAGE 1: clampAcousticOnsets (before the reconciler groups words) ────────
// Forced alignment must account for EVERY millisecond between words. Where the
// provider left audio un-transcribed — music, atmosphere, unintelligible or
// foreign speech — the aligner has nowhere to put that time and ABSORBS it into
// the ONSET of the next word. Ground truth (project 6a6c561ef670f3992db756d0):
// "Enhorabuena," returned as a 155-SECOND word; the provider captured 1.578s.
// The END was corroborated, only the onset was dragged. The reconciler derives a
// segment window from its first word's start, so one absorbed onset became a
// 155-second segment driving the rythmo band, the dub time-fit and the export.
// The repair keeps the corroborated END and pulls the START forward, never
// earlier than the previous word's end, so the absorbed span surfaces as an
// HONEST visible gap. It reuses the SAME ceiling as lib/segment-shaping.js's
// Pass 0 word-duration guard (which exists for the mirror-image defect and
// documents that it never moves a start).
// PARITY: src/lib/__tests__/word-duration-ceiling-parity.test.js locks these
// constants against lib/segment-shaping.js. A drift is a failing test.
//
// ── STAGE 2: auditTimelineIntegrity (after grouping, before staging) ─────────
//   • SAME-SPEAKER OVERLAP is ALWAYS a defect — one person cannot talk over
//     themselves, so a word was attributed to the wrong segment. Sub-ceiling
//     overlaps are boundary rounding and repaired; anything larger is flagged on
//     BOTH sides and left byte-intact, because the overlap IS the evidence.
//   • PROVIDER-CAPTURE DIVERGENCE / SPAN INFLATION: the capture and the acoustic
//     window disagree about the same audio. Words whose provider timing STAGE 0
//     already rejected are excluded — re-flagging a dispute the system has
//     resolved on evidence would send an operator to review a correct line.
//
// CROSS-SPEAKER overlap is intentionally NEVER flagged: two people genuinely can
// speak at once and the final mixer sums overlapping clips by design.
//
// SOC 2 CC7.4 / CC8.1 — every decision is counted, disclosed on the row, and
// attributable to the run that made it, from the row alone.
// =============================================================================

// v4 replaces v3's "provider wins" rule with plausibility arbitration and adds
// alignment-collapse detection. Pinned onto every report, so a run delivered
// under an earlier policy is never retroactively reinterpreted under v4's rules.
// v5 adds the EVIDENCE-RELATIVE arbitration bound and the final near-zero
// acceptance check. v4 judged an aligned window only against the rate ceiling,
// whose floor (WORD_MAX_DURATION_FLOOR_MS) grants EVERY short word a 1,500ms
// allowance — so a word the transcriber measured at ~210ms could be stretched to
// exactly 1,500ms through untranscribed music and be judged "plausible", because
// 1,500ms IS the ceiling for any word under ~8 characters. That is a structural
// blind spot, not a tuning miss: the generic floor exists so a genuinely long
// word is never falsely rejected, which makes it useless as an absorption bound.
// v5 therefore adds a SECOND, independent bound derived from evidence about THIS
// word (see evidenceCeilingMs) and applies whichever is tighter. The shared
// shaping constants are unchanged — this bound lives only in arbitration.
export const TIMELINE_INTEGRITY_POLICY_VERSION = 5;

// Below this, an overlap is boundary rounding between two adjacent same-speaker
// groups and is safe to repair deterministically.
export const AUTO_REPAIR_CEILING_MS = 250;
// Ignore sub-frame noise entirely — not a defect, not worth a repair record.
export const OVERLAP_EPSILON_MS = 10;
// Beyond this, a provider window and its acoustic window no longer describe the
// same audio, so one of them must be rejected on evidence.
export const PROVIDER_CAPTURE_DIVERGENCE_MS = 1500;
// A window shorter than this carries no speech. Observed floor across a real
// 734-word run: p5 = 41ms, while collapsed words come back at 1ms. It is a
// FLOOR ON EVIDENCE, not on word length — a genuinely clipped function word
// whose two timelines AGREE is left alone, because agreement is corroboration.
export const MIN_PLAUSIBLE_WORD_MS = 40;
// This many consecutive words sharing one identical window is an aligner
// collapse, not a coincidence.
export const COLLAPSE_STACK_MIN_WORDS = 3;

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

/** Duration this word would occupy at conversational pace. No safety factor. */
export function typicalWordDurationMs(text: string | undefined): number {
  const chars = String(text || '').replace(/\s+/g, '').length || 1;
  return chars * WORD_MS_PER_CHAR;
}

/**
 * Is the PROVIDER's measured duration credible as a reading of this text?
 *
 * The provider's number is evidence, never automatic truth — and it is only
 * usable as a bound on the aligner when it could itself be a real utterance of
 * the word. A capture more than WORD_DURATION_SAFETY_FACTOR times FASTER than
 * conversational pace is not a measurement of that word; it is a compressed or
 * collapsed timestamp (the mirror of the too-long case, and the reason the
 * aligner legitimately expands such words). Using the SAME safety factor in both
 * directions is deliberate: one documented tolerance, symmetric, no new number.
 *
 * Worked both ways, from the two general defect classes:
 *   "News."       5 chars → pace 357ms → credible floor 143ms → capture 210ms
 *                 IS credible, so it may bound the aligner.
 *   "leadership." 11 chars → pace 786ms → credible floor 314ms → capture 115ms
 *                 is NOT credible, so it may NOT bound the aligner and the
 *                 acoustic expansion stands.
 */
export function providerCaptureCredible(text: string | undefined, providerDurationMs: number): boolean {
  if (!Number.isFinite(providerDurationMs) || providerDurationMs < MIN_PLAUSIBLE_WORD_MS) return false;
  return providerDurationMs >= typicalWordDurationMs(text) / WORD_DURATION_SAFETY_FACTOR;
}

/**
 * The ceiling an ALIGNED window must respect, given the evidence for this word.
 *
 * Always the rate ceiling; additionally bounded by the provider's own measurement
 * when that measurement is credible. The provider-relative bound is that same
 * WORD_DURATION_SAFETY_FACTOR applied to a real measurement instead of to a
 * generic pace, plus MIN_PLAUSIBLE_WORD_MS of slack — a difference smaller than
 * the evidence floor is not measurable evidence of inflation.
 *
 * Rate-aware and evidence-relative by construction: no per-word constant, no
 * absolute duration rule, and it degrades to exactly the v4 behaviour whenever
 * no credible provider capture exists (missing capture, or a capture too short
 * to be believed). Scales with speech rate, language and word length because
 * both inputs do.
 */
export function evidenceCeilingMs(text: string | undefined, providerDurationMs: number | null): number {
  const rateCeiling = maxWordDurationMs(text);
  if (providerDurationMs === null || !providerCaptureCredible(text, providerDurationMs)) return rateCeiling;
  return Math.min(rateCeiling, Math.round(providerDurationMs * WORD_DURATION_SAFETY_FACTOR + MIN_PLAUSIBLE_WORD_MS));
}

/**
 * A sub-floor duration is only evidence of a genuinely brief word when the OTHER
 * timeline independently reports a brief word too. Corroboration threshold is
 * the evidence floor times the same safety factor — the widest capture that can
 * still be describing a very short function word rather than a normal one.
 * "a" at 39ms against a ~50ms capture is corroborated; a word the aligner
 * returned at 1ms against a ~320ms capture is not.
 */
export function nearZeroCorroborated(providerDurationMs: number | null): boolean {
  if (providerDurationMs === null || !Number.isFinite(providerDurationMs) || providerDurationMs <= 0) return false;
  return providerDurationMs <= MIN_PLAUSIBLE_WORD_MS * WORD_DURATION_SAFETY_FACTOR;
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
  provider_timing_rejected?: boolean;
  provider_timing_rejected_ms?: number;
  alignment_collapsed?: boolean;
  /** Engine could not place this word after bounded expansion — quarantine, never fallback. */
  unresolved?: boolean;
  search_window_exhausted?: boolean;
  /** Timing this word held before an arbitration decision replaced it. */
  prior_start_ms?: number;
  prior_end_ms?: number;
  /** Machine-readable arbitration decision + the evidence it was made on. */
  arbitration_reason?: string;
  arbitration_ceiling_ms?: number;
  arbitration_provider_duration_ms?: number | null;
  arbitration_aligned_duration_ms?: number;
  /** Why this word has no credible placement (engine reason, or a v5 acceptance failure). */
  unresolved_reason?: string;
  /** Per-word expansion attribution stamped by the alignment engine (policy v3+). */
  expansion_lead_ms?: number;
  expansion_trail_ms?: number;
  alignment_pass?: number;
  chunk_index?: number;
};

export type OnsetRepairReport = {
  onset_absorption_repairs: number;
  worst_onset_absorbed_ms: number;
  repaired_keys: string[];
};

export type ProviderWindow = { start_ms: number; end_ms: number };

export type CaptureRestoreReport = {
  capture_restored_words: number;
  provider_timing_rejected_words: number;
  alignment_collapse_words: number;
  /** Retained name: disputed words no substitution could resolve (= collapse words). */
  unrestorable_words: number;
  worst_restored_divergence_ms: number;
  worst_rejected_provider_divergence_ms: number;
  restored_keys: string[];
  rejected_keys: string[];
  collapsed_keys: string[];
};

export type FinalAcceptanceReport = {
  /** Words whose final window has no duration at all. Never acceptable. */
  zero_width_words: number;
  /** Words below the evidence floor after every repair and substitution. */
  near_zero_words: number;
  /** Sub-floor words the other timeline independently corroborated as brief. */
  near_zero_corroborated_words: number;
  /** Sub-floor words with no corroboration — quarantined, never displayed as valid. */
  near_zero_unresolved_words: number;
  zero_width_keys: string[];
  near_zero_unresolved_keys: string[];
  near_zero_corroborated_keys: string[];
};

/**
 * FINAL ACCEPTANCE — the last gate before words become segment boundaries.
 *
 * "Greater than zero" is not a validity test. A word the aligner returned at 1ms
 * occupies no audio, and substituting or clamping cannot invent a position for
 * it; it is an absence of measurement. This pass runs AFTER arbitration and the
 * onset clamp, on the timeline that will actually be persisted, and marks every
 * remaining sub-floor word unresolved UNLESS the other timeline independently
 * reports a comparably brief word (genuinely clipped function words — "a",
 * "the" — which are real speech and must not be quarantined).
 *
 * It never changes a timing: it only decides what may be called validated.
 */
export function assertFinalWordAcceptance(
  words: AlignedWord[],
  providerByKey: Map<string, ProviderWindow>,
): { words: AlignedWord[]; report: FinalAcceptanceReport } {
  const report: FinalAcceptanceReport = {
    zero_width_words: 0,
    near_zero_words: 0,
    near_zero_corroborated_words: 0,
    near_zero_unresolved_words: 0,
    zero_width_keys: [],
    near_zero_unresolved_keys: [],
    near_zero_corroborated_keys: [],
  };
  const out = (words || []).map((word) => {
    const duration = Number(word.end_ms) - Number(word.start_ms);
    if (!Number.isFinite(duration) || duration >= MIN_PLAUSIBLE_WORD_MS) return word;
    const provider = providerByKey.get(String(word.key)) || null;
    const providerDuration = provider ? Number(provider.end_ms) - Number(provider.start_ms) : null;
    if (duration <= 0) {
      report.zero_width_words += 1;
      if (report.zero_width_keys.length < 200) report.zero_width_keys.push(String(word.key));
      return { ...word, unresolved: true, unresolved_reason: 'zero_width_final_window' };
    }
    report.near_zero_words += 1;
    if (nearZeroCorroborated(providerDuration)) {
      report.near_zero_corroborated_words += 1;
      if (report.near_zero_corroborated_keys.length < 200) report.near_zero_corroborated_keys.push(String(word.key));
      return word;
    }
    report.near_zero_unresolved_words += 1;
    if (report.near_zero_unresolved_keys.length < 200) report.near_zero_unresolved_keys.push(String(word.key));
    return {
      ...word,
      unresolved: true,
      unresolved_reason: 'final_window_below_evidence_floor_uncorroborated',
    };
  });
  return { words: out, report };
}

/**
 * Is this window a physically possible utterance of `text`?
 *
 * `providerDurationMs` supplies the independent evidence for the upper bound
 * (see evidenceCeilingMs). Pass null when judging the PROVIDER's own window —
 * a measurement must not be used to bound itself.
 */
function windowPlausible(
  text: string | undefined,
  start: unknown,
  end: unknown,
  providerDurationMs: number | null = null,
): boolean {
  const s = Number(start);
  const e = Number(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  const duration = e - s;
  return duration >= MIN_PLAUSIBLE_WORD_MS && duration <= evidenceCeilingMs(text, providerDurationMs);
}

/**
 * STAGE 0 — arbitrate every disputed word between the provider's measured
 * capture and the acoustic alignment window, on plausibility.
 *
 * Emits exactly one disclosure per resolved word:
 *   capture_restored           the provider window replaced an implausible aligned one
 *   provider_timing_rejected   the aligned window was kept over an implausible provider one
 *   alignment_collapsed        neither window is usable; nothing changed, a human must judge
 *
 * NOTHING IS DESTROYED: both raw provider responses are archived to immutable
 * storage before this runs, and aai_word_timings keeps the untouched capture.
 */
export function restoreDivergedCaptures(
  words: AlignedWord[],
  providerByKey: Map<string, ProviderWindow>,
): { words: AlignedWord[]; report: CaptureRestoreReport } {
  const list = words || [];
  const restoredKeys: string[] = [];
  const rejectedKeys: string[] = [];
  const collapsedKeys: string[] = [];
  let worstRestored = 0;
  let worstRejected = 0;

  // ── Prepass: aligner collapses (N identical windows in a row) ─────────────
  const stacked = new Array(list.length).fill(false);
  for (let i = 0; i < list.length;) {
    let j = i + 1;
    while (
      j < list.length
      && Number(list[j]?.start_ms) === Number(list[i]?.start_ms)
      && Number(list[j]?.end_ms) === Number(list[i]?.end_ms)
    ) j++;
    if (j - i >= COLLAPSE_STACK_MIN_WORDS) for (let k = i; k < j; k++) stacked[k] = true;
    i = j;
  }

  const providerAt = (index: number): ProviderWindow | null => providerByKey.get(String(list[index]?.key)) || null;

  const divergenceAt = (index: number): number => {
    const provider = providerAt(index);
    const word = list[index];
    if (!provider || !word) return 0;
    const gap = Math.max(
      Math.abs(Number(word.start_ms) - Number(provider.start_ms)),
      Math.abs(Number(word.end_ms) - Number(provider.end_ms)),
    );
    return Number.isFinite(gap) ? gap : 0;
  };

  // Which segment a word belongs to. Word keys are `${segment_id}:${index}`.
  // Runs are arbitrated WITHIN one segment and never across a boundary: the flat
  // list spans the whole programme, so an unbroken run would merge a dispute in
  // one row with an unrelated dispute in the next and decide both by the WORSE of
  // the two. Observed doing exactly that: row 29's collapsed words dragged row 28
  // into their verdict, so a row whose acoustic timing was entirely sound was
  // labelled a collapse. A verdict must be reached on the evidence of the words it
  // describes, not on its neighbour's.
  const segmentOf = (index: number): string => {
    const key = String(list[index]?.key || '');
    const cut = key.lastIndexOf(':');
    return cut > 0 ? key.slice(0, cut) : key;
  };

  // A word is DISPUTED when the two timelines cannot both be describing it: they
  // disagree by seconds, the aligner collapsed it while the provider measured a
  // SUBSTANTIALLY real word, or it sits inside a collapse stack. Two short windows
  // that roughly agree are not disputed — agreement is corroboration, not a defect.
  //
  // The degenerate rule requires the provider to claim at least 3x the evidence
  // floor, because a hair-under-floor aligned window whose provider counterpart is
  // also short describes the same brief word from both sides. Observed without
  // that margin: a 39ms "to" against a 97ms capture — a 58ms difference nobody can
  // hear — was escalated into a reviewable defect. A review queue that includes
  // correct lines trains an operator to ignore it.
  const providerDurationAt = (index: number): number | null => {
    const provider = providerAt(index);
    if (!provider) return null;
    const duration = Number(provider.end_ms) - Number(provider.start_ms);
    return Number.isFinite(duration) ? duration : null;
  };

  const disputed = (index: number): boolean => {
    const word = list[index];
    if (!Number.isFinite(Number(word?.start_ms)) || !Number.isFinite(Number(word?.end_ms))) return false;
    if (stacked[index]) return true;
    if (divergenceAt(index) > PROVIDER_CAPTURE_DIVERGENCE_MS) return true;
    const alignedDuration = Number(word.end_ms) - Number(word.start_ms);
    const providerDuration = providerDurationAt(index);
    // INFLATION, independent of divergence. An absorbed word keeps its
    // corroborated edge, so its start and end can each sit inside the 1.5s
    // divergence threshold while the DURATION is several times the evidence —
    // which is exactly how absorption reached delivery unflagged. Judging the
    // duration against evidence is what makes the class detectable at all.
    if (alignedDuration > evidenceCeilingMs(word.text, providerDuration)) return true;
    if (providerDuration === null) return false;
    return alignedDuration < MIN_PLAUSIBLE_WORD_MS && providerDuration >= MIN_PLAUSIBLE_WORD_MS * 3;
  };

  const out: AlignedWord[] = [];
  let furthestEnd = -Infinity;
  const accept = (word: AlignedWord) => {
    out.push(word);
    const end = Number(word?.end_ms);
    if (Number.isFinite(end)) furthestEnd = Math.max(furthestEnd, end);
  };

  for (let index = 0; index < list.length;) {
    if (!disputed(index)) { accept(list[index]); index++; continue; }

    // Collect the contiguous disputed run WITHIN THIS SEGMENT — arbitrated as one
    // unit, because substituting one word alone would collide with neighbours still
    // on the aligned timeline.
    const segment = segmentOf(index);
    let end = index;
    while (end + 1 < list.length && disputed(end + 1) && segmentOf(end + 1) === segment) end++;
    const run = list.slice(index, end + 1);
    const runIsStacked = stacked.slice(index, end + 1).some(Boolean);

    // The next word already accepted on the aligned timeline bounds any restore.
    let nextAlignedStart = Infinity;
    for (let look = end + 1; look < list.length; look++) {
      if (disputed(look)) continue;
      nextAlignedStart = Number(list[look].start_ms);
      break;
    }

    // The aligned window is judged against BOTH bounds (rate + this word's own
    // provider evidence). The provider window is judged against the rate bound
    // only — a measurement cannot bound itself.
    const alignedPlausible = !runIsStacked
      && run.every((word, offset) =>
        windowPlausible(word.text, word.start_ms, word.end_ms, providerDurationAt(index + offset)));

    const providerRun = run.map((word) => providerByKey.get(String(word.key)) || null);
    let providerPlausible = providerRun.every((provider, offset) =>
      !!provider && windowPlausible(run[offset].text, provider.start_ms, provider.end_ms));
    // Candidate substitution windows, seam-clamped. A provider capture can start
    // a few ms before the last ACCEPTED aligned word ends, because the two
    // timelines round their shared boundary differently. Refusing the whole
    // substitution over that would discard a correct repair on a rounding
    // artifact, so the seam is clamped forward — but only within
    // AUTO_REPAIR_CEILING_MS, the same ceiling this module already uses to
    // decide that an overlap is rounding rather than a real attribution error.
    // Anything larger is a genuine chronology conflict and refuses the run.
    let providerWindows: ProviderWindow[] | null = null;
    if (providerPlausible) {
      const windows = providerRun.map((provider) => ({ start_ms: Number(provider!.start_ms), end_ms: Number(provider!.end_ms) }));
      const seamShortfall = Number.isFinite(furthestEnd) ? furthestEnd - windows[0].start_ms : 0;
      if (seamShortfall > 0) {
        if (seamShortfall <= AUTO_REPAIR_CEILING_MS) windows[0].start_ms = furthestEnd;
        else providerPlausible = false;
      }
      for (let offset = 1; offset < windows.length && providerPlausible; offset++) {
        if (windows[offset].start_ms < windows[offset - 1].end_ms) providerPlausible = false;
      }
      // Every clamped window must still be a possible utterance, and the run must
      // still fit before the next accepted aligned word.
      if (providerPlausible) {
        const fits = windows.every((window, offset) => windowPlausible(run[offset].text, window.start_ms, window.end_ms));
        if (!fits || windows[windows.length - 1].end_ms > nextAlignedStart) providerPlausible = false;
      }
      if (providerPlausible) providerWindows = windows;
    }

    if (providerPlausible && !alignedPlausible) {
      // The aligned window cannot be an utterance of this text; the provider's can.
      run.forEach((word, offset) => {
        const provider = providerWindows![offset];
        const divergence = Math.round(Math.max(
          Math.abs(Number(word.start_ms) - Number(provider.start_ms)),
          Math.abs(Number(word.end_ms) - Number(provider.end_ms)),
        ));
        if (divergence > worstRestored) worstRestored = divergence;
        restoredKeys.push(String(word.key));
        const providerDuration = providerDurationAt(index + offset);
        accept({
          ...word,
          // Prior (rejected) timing preserved beside the accepted one so the
          // decision is reversible by evidence from the row alone.
          prior_start_ms: Number(word.start_ms),
          prior_end_ms: Number(word.end_ms),
          start_ms: Number(provider.start_ms),
          end_ms: Number(provider.end_ms),
          capture_restored: true,
          capture_divergence_ms: divergence,
          arbitration_reason: 'aligned_window_inflated_beyond_evidence',
          arbitration_ceiling_ms: evidenceCeilingMs(word.text, providerDuration),
          arbitration_provider_duration_ms: providerDuration,
          arbitration_aligned_duration_ms: Math.round(Number(word.end_ms) - Number(word.start_ms)),
        });
      });
    } else if (alignedPlausible) {
      // The acoustic window holds up and the provider's does not (or is merely
      // far away). Keep the measured-against-audio value and SAY SO — a silent
      // "we ignored the transcriber here" is exactly what must never happen.
      run.forEach((word, offset) => {
        const divergence = Math.round(divergenceAt(index + offset));
        if (divergence > worstRejected) worstRejected = divergence;
        rejectedKeys.push(String(word.key));
        const providerDuration = providerDurationAt(index + offset);
        accept({
          ...word,
          provider_timing_rejected: true,
          provider_timing_rejected_ms: divergence,
          arbitration_reason: providerDuration !== null && !providerCaptureCredible(word.text, providerDuration)
            ? 'provider_capture_too_short_to_be_credible'
            : 'provider_capture_not_a_possible_utterance',
          arbitration_ceiling_ms: evidenceCeilingMs(word.text, providerDuration),
          arbitration_provider_duration_ms: providerDuration,
          arbitration_aligned_duration_ms: Math.round(Number(word.end_ms) - Number(word.start_ms)),
        });
      });
    } else if (runIsStacked) {
      // Neither timeline is usable AND the aligner genuinely stacked these words
      // onto one instant. Change nothing; this is a review item, and the ONLY
      // condition that earns the collapse label — claiming a collapse on a row
      // whose words are spread normally would tell an operator something plainly
      // untrue about their own transcript.
      run.forEach((word) => {
        collapsedKeys.push(String(word.key));
        accept({ ...word, alignment_collapsed: true });
      });
    } else {
      // An unresolved dispute that is NOT a collapse: neither window is usable,
      // but the words are not stacked. Nothing is changed and nothing is claimed —
      // the row falls through to the divergence check in STAGE 2, which is the
      // honest description of what happened.
      run.forEach((word) => accept(word));
    }

    index = end + 1;
  }

  return {
    words: out,
    report: {
      capture_restored_words: restoredKeys.length,
      provider_timing_rejected_words: rejectedKeys.length,
      alignment_collapse_words: collapsedKeys.length,
      unrestorable_words: collapsedKeys.length,
      worst_restored_divergence_ms: worstRestored,
      worst_rejected_provider_divergence_ms: worstRejected,
      restored_keys: restoredKeys.slice(0, 200),
      rejected_keys: rejectedKeys.slice(0, 200),
      collapsed_keys: collapsedKeys.slice(0, 200),
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
 * implies a physically impossible duration is moved. Words STAGE 0 already
 * resolved keep their decision: a restored window is the provider's own
 * measurement and a collapsed word has no trustworthy edge to reason from.
 */
export function clampAcousticOnsets(words: AlignedWord[]): { words: AlignedWord[]; report: OnsetRepairReport } {
  const repairedKeys: string[] = [];
  let worstAbsorbed = 0;
  const out: AlignedWord[] = [];
  let previousEnd = -Infinity;

  for (const word of words || []) {
    const start = Number(word?.start_ms);
    const end = Number(word?.end_ms);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || word.capture_restored === true || word.alignment_collapsed === true) {
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

export type IntegrityWord = {
  text?: string;
  start_ms: number;
  end_ms: number;
  provider_start_ms?: number;
  provider_end_ms?: number;
  provider_timing_rejected?: boolean;
};
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
  // Applied-repair / decision disclosure — independent of timing_defect (see DEFECT_SEVERITY).
  onset_reconstructed?: boolean;
  onset_absorbed_ms?: number;
  capture_restored?: boolean;
  capture_restored_ms?: number;
  provider_timing_rejected?: boolean;
  provider_timing_rejected_ms?: number;
  alignment_collapsed?: boolean;
  // Alignment-engine quarantine evidence. A row carrying either count has words
  // whose placement was never proven; STAGE 0 may still have substituted the
  // provider window as the least-bad visible value, which is exactly why these
  // counts are independent of every repair disclosure above.
  unresolved_alignment_word_count?: number;
  search_window_exhausted_word_count?: number;
};

export type IntegrityReport = {
  policy_version: number;
  auto_repair_ceiling_ms: number;
  provider_divergence_threshold_ms: number;
  min_plausible_word_ms: number;
  same_speaker_overlap_repairs: number;
  same_speaker_overlap_defects: number;
  provider_capture_defects: number;
  // Rows carrying words the aligner collapsed onto one instant where no provider
  // substitution was possible. Invisible before policy v4: max per-word
  // divergence in the ground-truth case was 944ms, under the flagging threshold,
  // so five words rendered at the same moment with nothing flagged.
  alignment_collapse_defects: number;
  alignment_collapse_words: number;
  onset_reconstructed_rows: number;
  onset_absorption_repairs: number;
  worst_onset_absorbed_ms: number;
  // STAGE 0 arbitration evidence. capture_restored_* counts words whose
  // implausible aligned window was replaced by the provider's measured one;
  // provider_timing_rejected_* counts the OPPOSITE decision — an implausible
  // provider capture (e.g. 9 words inside 1,346ms, or zero-width words) where
  // the acoustic window was kept. Both are decisions the system made on its own
  // and both must be countable, or "what did it change, and why?" is unanswerable.
  capture_restored_words: number;
  capture_restored_rows: number;
  provider_timing_rejected_words: number;
  provider_timing_rejected_rows: number;
  unrestorable_capture_words: number;
  worst_restored_divergence_ms: number;
  worst_rejected_provider_divergence_ms: number;
  worst_same_speaker_overlap_ms: number;
  worst_provider_divergence_ms: number;
  // Segment-scale absorption evidence. Rows whose window exceeds their own
  // provider capture by more than the threshold — skipped where the provider
  // capture itself was rejected, since comparing against a value already judged
  // impossible produces a defect that describes nothing.
  worst_acoustic_inflation_ms: number;
  inflated_row_count: number;
  // Final-acceptance evidence (policy v5). "Greater than zero" was never a
  // validity test; these count what the last gate judged, split by outcome so a
  // reviewer can tell a corroborated clipped function word from an absence of
  // measurement without re-deriving either.
  zero_width_words: number;
  near_zero_words: number;
  near_zero_corroborated_words: number;
  near_zero_unresolved_words: number;
  defect_sequences: number[];
};

// Severity ordering for the single timing_defect label a row can carry. A row is
// labelled by its MOST actionable finding, never by whichever check ran first.
//
// APPLIED DECISIONS ARE DELIBERATELY ABSENT HERE (onset_reconstructed,
// capture_restored, provider_timing_rejected). They are things the system DID,
// not things a human must judge, and they live on their own independent fields.
// Ranking them against real defects made the disclosure unreachable in practice:
// a reconstructed onset is BY DEFINITION a multi-second gap, so it always also
// tripped the divergence check and was always relabelled — the ground-truth 155s
// repair produced ZERO onset-labelled rows. A decision and a defect are
// orthogonal facts; one field cannot express both without losing one.
const DEFECT_SEVERITY: Record<string, number> = {
  provider_capture_divergence: 1,  // capture no longer describes its own audio
  alignment_collapse: 2,           // words stacked on one instant; unrepairable
  same_speaker_overlap: 3,         // attribution error; a human must judge it
  // Ranked highest because it is the only finding that says the audio a word
  // occupies was never successfully analysed. Every other label describes a
  // disagreement between two measurements; this one describes the absence of one.
  unresolved_timing: 4,
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
 *             STAGE 0/1 decision touched arrive pre-disclosed on their own
 *             fields; a more actionable finding here adds a defect label.
 * @param formatTimecode caller's timecode formatter, so this module never owns a
 *                       second frame-rate convention that could drift from the
 *                       reconciler's own.
 * @param onsetRepair Stage-1 summary, folded into the run-level report.
 * @param captureRestore Stage-0 arbitration summary, folded into the report.
 */
export function auditTimelineIntegrity(
  rows: IntegrityRow[],
  formatTimecode: (ms: number) => string,
  onsetRepair?: OnsetRepairReport,
  captureRestore?: CaptureRestoreReport,
  acceptance?: FinalAcceptanceReport,
): IntegrityReport {
  const report: IntegrityReport = {
    policy_version: TIMELINE_INTEGRITY_POLICY_VERSION,
    auto_repair_ceiling_ms: AUTO_REPAIR_CEILING_MS,
    provider_divergence_threshold_ms: PROVIDER_CAPTURE_DIVERGENCE_MS,
    min_plausible_word_ms: MIN_PLAUSIBLE_WORD_MS,
    same_speaker_overlap_repairs: 0,
    same_speaker_overlap_defects: 0,
    provider_capture_defects: 0,
    alignment_collapse_defects: 0,
    alignment_collapse_words: captureRestore?.alignment_collapse_words || 0,
    onset_reconstructed_rows: 0,
    onset_absorption_repairs: onsetRepair?.onset_absorption_repairs || 0,
    worst_onset_absorbed_ms: onsetRepair?.worst_onset_absorbed_ms || 0,
    capture_restored_words: captureRestore?.capture_restored_words || 0,
    capture_restored_rows: 0,
    provider_timing_rejected_words: captureRestore?.provider_timing_rejected_words || 0,
    provider_timing_rejected_rows: 0,
    unrestorable_capture_words: captureRestore?.unrestorable_words || 0,
    worst_restored_divergence_ms: captureRestore?.worst_restored_divergence_ms || 0,
    worst_rejected_provider_divergence_ms: captureRestore?.worst_rejected_provider_divergence_ms || 0,
    worst_same_speaker_overlap_ms: 0,
    worst_provider_divergence_ms: 0,
    worst_acoustic_inflation_ms: 0,
    inflated_row_count: 0,
    zero_width_words: acceptance?.zero_width_words || 0,
    near_zero_words: acceptance?.near_zero_words || 0,
    near_zero_corroborated_words: acceptance?.near_zero_corroborated_words || 0,
    near_zero_unresolved_words: acceptance?.near_zero_unresolved_words || 0,
    defect_sequences: [],
  };

  // ── Pass 1: provider capture vs acoustic truth ────────────────────────────
  for (const row of rows) {
    if (row.is_music) continue;

    // The alignment engine reported words it could not place. This outranks every
    // measurement disagreement: the row is quarantined and must never be presented
    // as clean because a provider timestamp happens to exist for those words.
    const unplaced = Number(row.unresolved_alignment_word_count || 0) + Number(row.search_window_exhausted_word_count || 0);
    if (unplaced > 0) flag(row, 'unresolved_timing', 0);

    // A collapse is unrepairable and already the most specific finding available
    // for this row, so it is flagged unconditionally.
    if (row.alignment_collapsed === true) {
      flag(row, 'alignment_collapse', 0);
      report.alignment_collapse_defects += 1;
    }

    let worst = 0;
    for (const word of row._alignment?.words || []) {
      // STAGE 0 judged this word's provider timing impossible and kept the
      // acoustic value on evidence. Measuring the gap to a rejected number would
      // re-raise a dispute the system already resolved.
      if (word.provider_timing_rejected === true) continue;
      const startGap = Math.abs(Number(word.start_ms) - Number(word.provider_start_ms));
      const endGap = Math.abs(Number(word.end_ms) - Number(word.provider_end_ms));
      const gap = Math.max(Number.isFinite(startGap) ? startGap : 0, Number.isFinite(endGap) ? endGap : 0);
      if (gap > worst) worst = gap;
    }
    // SPAN INFLATION — the measure a per-word check structurally cannot see.
    // Absorbed time spread across many words keeps every individual word's shift
    // under the threshold while the SEGMENT still ends up seconds too long.
    // Ground truth: a row whose provider capture held 1,784ms of speech carried a
    // 4,240ms window and was never flagged, because no single word moved far
    // enough. Skipped when the provider capture was rejected — its span is the
    // value already judged impossible.
    const capture = row.aai_word_timings || [];
    if (capture.length && row.provider_timing_rejected !== true) {
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

  // Counted from the independent disclosure flags, NOT from defect labels — a
  // label is claimed by whichever outstanding defect the row also carries.
  report.onset_reconstructed_rows = rows.filter((row) => row.onset_reconstructed === true).length;
  report.capture_restored_rows = rows.filter((row) => row.capture_restored === true).length;
  report.provider_timing_rejected_rows = rows.filter((row) => row.provider_timing_rejected === true).length;
  report.defect_sequences = rows
    .filter((row) => !!row.timing_defect)
    .map((row) => Number(row.sequence_index))
    .sort((a, b) => a - b);

  return report;
}
