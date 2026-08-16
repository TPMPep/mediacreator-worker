// =============================================================================
// segment-boundaries — final segment IN/OUT derived from the VALIDATED word
// timeline, with the ASR provider's boundary demoted to evidence.
// -----------------------------------------------------------------------------
// WHY THIS MODULE EXISTS. The provider's segment window used to be the silent
// authority underneath everything: the aligner was only allowed to search inside
// it, and the reconciler then measured its own output against it. That is
// circular — the transcriber proposes the boundary and is then used to judge
// whether the boundary was right. Ground truth, project 6a7d874aa2ddd372f426a4df
// line 18: the provider ended the segment at 93,664ms while the words are really
// spoken out to ~96,200ms, so five words were stacked against the wall at
// 93,986→93,987. No downstream repair could recover them, because the audio they
// occupy was never inside the window anyone looked at.
//
// The authoritative core of a segment is therefore the FIRST-TO-LAST VALIDATED
// WORD. Everything else is policy applied around that core.
//
// THREE RULES, IN THIS ORDER:
//
//  1. THE CORE IS NEVER TRIMMED. final IN <= first validated word start, and
//     final OUT >= last validated word end, unconditionally. This is what makes
//     "no word sits outside its segment" and "no boundary contradicts its own
//     words" structural facts rather than checks that might fail.
//
//  2. PADDING IS EARNED FROM MEASURED SILENCE, NEVER INHERITED. Editorial
//     lead-in / lead-out exists (a line clipped hard on the first phoneme reads
//     as a defect to an operator), but it is capped at LEAD_IN_MS / LEAD_OUT_MS
//     AND at half the measured gap to the neighbouring core. Half, because two
//     adjacent rows each take their own half and can never claim the same
//     silence. This is the same evidence-derived-padding posture the alignment
//     engine uses at chunk edges, for the same reason: a fixed pad is a fixed
//     absorption budget. Line 17's 1.86s of station-ident music can contribute
//     at most LEAD_OUT_MS to the preceding line — the remaining ~1.7s stays an
//     honest visible gap instead of stretching the final spoken word.
//
//  3. EDITORIAL STABILITY IS PRESERVED WHERE POLICY ALLOWS. A healthy line whose
//     provider boundary already sits within BOUNDARY_STABILITY_EPSILON_MS of the
//     derived one — and which does not contradict the validated words — keeps the
//     provider value, so re-deriving every boundary architecturally does not
//     reshape a whole programme's lines by a few frames each. The persisted
//     authority is still the validated timeline: the provider value is retained
//     only because the validated timeline agrees with it, and every row records
//     which happened (boundary_source) plus the deltas.
//
// CROSS-SPEAKER OVERLAP SURVIVES. Padding is clamped against neighbouring final
// boundaries, but a CORE is never clamped, so genuinely simultaneous speech
// stays overlapping — the mixer sums those clips by design.
//
// SOC 2 CC7.4 / CC8.1 — the provider boundary is preserved on every row as
// evidence, and each row states which source its boundary came from, how much
// padding policy granted, and by how much it moved.
// =============================================================================

export const BOUNDARY_POLICY_VERSION = 1;

/** Editorial lead-in before the first validated word, when silence allows it. */
export const LEAD_IN_MS = 120;
/** Editorial lead-out after the last validated word, when silence allows it. */
export const LEAD_OUT_MS = 200;
/**
 * Share of the measured gap to the neighbouring core that one side may claim.
 * Half guarantees two adjacent rows never pad into the same silence, and that
 * padding can never reach a neighbour's speech.
 */
export const NEIGHBOUR_GAP_SHARE = 0.5;
/**
 * A provider boundary this close to the derived one is treated as agreement, so
 * the row is left editorially stable. Deliberately smaller than the 250ms
 * overlap auto-repair ceiling and far below the 650ms breath boundary used by
 * segmentation — an accepted difference can never be large enough to change how
 * a line reads or where it breaks.
 */
export const BOUNDARY_STABILITY_EPSILON_MS = 150;

export type BoundaryWord = { start_ms: number; end_ms: number };

export type BoundaryRow = {
  start_ms: number;
  end_ms: number;
  is_music?: boolean;
  /** Validated (arbitrated + clamped) word timings this row was grouped from. */
  _boundary_words?: BoundaryWord[];
  /**
   * The provider's own segment IN/OUT, supplied ONLY when this row corresponds
   * 1:1 to one provider segment. Null when the row is a split of one (there is
   * no comparable provider boundary), which forces full derivation.
   */
  provider_boundary_start_ms?: number | null;
  provider_boundary_end_ms?: number | null;
  boundary_source?: string;
  boundary_lead_in_ms?: number;
  boundary_lead_out_ms?: number;
  boundary_delta_start_ms?: number;
  boundary_delta_end_ms?: number;
  boundary_policy_version?: number;
};

export type BoundaryReport = {
  policy_version: number;
  lead_in_ms: number;
  lead_out_ms: number;
  stability_epsilon_ms: number;
  rows_derived: number;
  rows_stable: number;
  rows_music_preserved: number;
  /**
   * Rows whose provider boundary cut INSIDE their own validated words — the
   * defect class this module removes. Line 18 is one of these. A non-zero value
   * is a measurement of upstream segmentation quality, not of this stage.
   */
  provider_contradictions_prevented: number;
  worst_extension_ms: number;
  worst_reduction_ms: number;
  worst_lead_out_granted_ms: number;
};

const finite = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** first-to-last validated word span — the authoritative core of the segment. */
function coreOf(row: BoundaryRow): { start: number; end: number } | null {
  const words = row._boundary_words || [];
  let start = Infinity;
  let end = -Infinity;
  for (const word of words) {
    const s = finite(word?.start_ms);
    const e = finite(word?.end_ms);
    if (s === null || e === null) continue;
    if (s < start) start = s;
    if (e > end) end = e;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/**
 * Re-derive every segment's final IN/OUT from its validated words, IN PLACE
 * (matching auditTimelineIntegrity's convention so the processor holds one list).
 *
 * @param rows chronologically ordered reconciled rows carrying `_boundary_words`.
 * @param opts durationMs — programme length, so the last row's lead-out cannot
 *             run past the end of the media.
 */
export function deriveSegmentBoundaries(
  rows: BoundaryRow[],
  opts: { durationMs?: number } = {},
): BoundaryReport {
  const report: BoundaryReport = {
    policy_version: BOUNDARY_POLICY_VERSION,
    lead_in_ms: LEAD_IN_MS,
    lead_out_ms: LEAD_OUT_MS,
    stability_epsilon_ms: BOUNDARY_STABILITY_EPSILON_MS,
    rows_derived: 0,
    rows_stable: 0,
    rows_music_preserved: 0,
    provider_contradictions_prevented: 0,
    worst_extension_ms: 0,
    worst_reduction_ms: 0,
    worst_lead_out_granted_ms: 0,
  };

  const list = rows || [];
  const cores = list.map(coreOf);
  const durationMs = finite(opts.durationMs);

  // Nearest neighbouring CORE on each side — the only acoustic evidence allowed
  // to bound padding. Music rows have no validated words, so their existing
  // window stands in as their core: music is a neighbour that must not be eaten.
  const spanOf = (index: number): { start: number; end: number } | null => {
    const core = cores[index];
    if (core) return core;
    const s = finite(list[index]?.start_ms);
    const e = finite(list[index]?.end_ms);
    return s !== null && e !== null ? { start: s, end: e } : null;
  };

  let previousFinalEnd: number | null = null;

  for (let index = 0; index < list.length; index++) {
    const row = list[index];
    const core = cores[index];
    row.boundary_policy_version = BOUNDARY_POLICY_VERSION;

    if (!core) {
      // No validated words (music / non-dialogue). Its window is not derived
      // from speech, so there is nothing here to re-derive — and inventing a
      // boundary for it would be a claim the evidence does not support.
      row.boundary_source = 'music_preserved';
      row.boundary_lead_in_ms = 0;
      row.boundary_lead_out_ms = 0;
      row.boundary_delta_start_ms = 0;
      row.boundary_delta_end_ms = 0;
      report.rows_music_preserved += 1;
      previousFinalEnd = finite(row.end_ms);
      continue;
    }

    let previousEnd: number | null = null;
    for (let look = index - 1; look >= 0; look--) {
      const span = spanOf(look);
      if (span) { previousEnd = span.end; break; }
    }
    let nextStart: number | null = null;
    for (let look = index + 1; look < list.length; look++) {
      const span = spanOf(look);
      if (span) { nextStart = span.start; break; }
    }

    // Padding earned from MEASURED silence: capped by policy AND by half the gap.
    const leadRoom = previousEnd === null
      ? Math.max(0, core.start)
      : Math.max(0, (core.start - previousEnd) * NEIGHBOUR_GAP_SHARE);
    const trailRoom = nextStart === null
      ? (durationMs === null ? LEAD_OUT_MS : Math.max(0, durationMs - core.end))
      : Math.max(0, (nextStart - core.end) * NEIGHBOUR_GAP_SHARE);
    let leadIn = Math.round(Math.min(LEAD_IN_MS, leadRoom));
    let leadOut = Math.round(Math.min(LEAD_OUT_MS, trailRoom));

    let start = core.start - leadIn;
    let end = core.end + leadOut;

    // Padding may never cross a neighbour's final boundary. The CORE is exempt:
    // overlapping cores mean genuinely simultaneous speech, which is legitimate.
    if (previousFinalEnd !== null && start < previousFinalEnd) {
      start = Math.min(core.start, previousFinalEnd);
      leadIn = Math.round(core.start - start);
    }
    if (nextStart !== null && end > nextStart) {
      end = Math.max(core.end, nextStart);
      leadOut = Math.round(end - core.end);
    }
    if (start < 0) { start = 0; leadIn = Math.round(core.start); }

    const providerStart = finite(row.provider_boundary_start_ms);
    const providerEnd = finite(row.provider_boundary_end_ms);

    // Did the provider's own boundary cut inside its validated words? That is the
    // failure this module exists to end, and it is worth counting explicitly.
    if ((providerStart !== null && providerStart > core.start)
      || (providerEnd !== null && providerEnd < core.end)) {
      report.provider_contradictions_prevented += 1;
    }

    // Editorial stability — accept the provider value ONLY where the validated
    // timeline agrees with it and it cannot contradict a word or a neighbour.
    let keptStart = false;
    let keptEnd = false;
    if (providerStart !== null
      && providerStart <= core.start
      && Math.abs(providerStart - start) <= BOUNDARY_STABILITY_EPSILON_MS
      && (previousFinalEnd === null || providerStart >= previousFinalEnd)
      && providerStart >= 0) {
      start = providerStart;
      leadIn = Math.round(core.start - providerStart);
      keptStart = true;
    }
    if (providerEnd !== null
      && providerEnd >= core.end
      && Math.abs(providerEnd - end) <= BOUNDARY_STABILITY_EPSILON_MS
      && (nextStart === null || providerEnd <= nextStart)) {
      end = providerEnd;
      leadOut = Math.round(providerEnd - core.end);
      keptEnd = true;
    }

    // Structural invariants — the whole point of the module. If either fails, the
    // derivation is wrong and must not be persisted.
    if (start > core.start || end < core.end) {
      throw new Error(`segment_boundary_contradicts_words: derived [${start},${end}] excludes validated core [${core.start},${core.end}]`);
    }

    const priorStart = finite(row.start_ms);
    const priorEnd = finite(row.end_ms);
    row.boundary_delta_start_ms = priorStart === null ? 0 : Math.round(start - priorStart);
    row.boundary_delta_end_ms = priorEnd === null ? 0 : Math.round(end - priorEnd);
    row.boundary_lead_in_ms = Math.max(0, leadIn);
    row.boundary_lead_out_ms = Math.max(0, leadOut);
    row.boundary_source = (keptStart && keptEnd) ? 'validated_words_stable' : 'validated_words';
    row.start_ms = Math.round(start);
    row.end_ms = Math.round(end);

    if (keptStart && keptEnd) report.rows_stable += 1; else report.rows_derived += 1;
    if (providerEnd !== null) {
      const extension = Math.round(end - providerEnd);
      if (extension > report.worst_extension_ms) report.worst_extension_ms = extension;
      const reduction = Math.round(providerEnd - end);
      if (reduction > report.worst_reduction_ms) report.worst_reduction_ms = reduction;
    }
    if (row.boundary_lead_out_ms > report.worst_lead_out_granted_ms) {
      report.worst_lead_out_granted_ms = row.boundary_lead_out_ms;
    }

    previousFinalEnd = row.end_ms;
  }

  return report;
}
