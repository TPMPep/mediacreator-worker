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

// v2 adds the CROSS-ROW CHRONOLOGY INVARIANT (see enforceChronology at the foot
// of this module) and changes no threshold, no padding rule and no boundary
// source. Rules 1-3 above are per-row: each row's window is judged against its own
// words and its own provider evidence. Nothing checked that the SET of windows was
// still ordered afterwards — and it can stop being ordered, because adjacent rows
// are resolved on DIFFERENT timelines. A row with a validated core is derived from
// its aligned words; a row with no validated core is recovered from its preserved
// provider boundary. Where the aligner has displaced one row and the other falls
// back to the transcriber, the two can cross.
// Ground truth, project 6a85757eb3fb1626eb1fea43: row 42 ("Harry Potter and the")
// was derived to 125,043-125,724 from aligned words the aligner had placed 4.3s
// late, while row 43 ("Order of the Phoenix.") was correctly recovered to its
// provider window 123,444-125,406 — so row 43 began 1.6 SECONDS BEFORE row 42
// despite following it. Both rows were already quarantined for their own reasons,
// which is the only thing that kept the inverted geometry off a deliverable.
// The invariant NEVER reorders and NEVER nudges a window: choosing a corrected
// placement would mean deciding which of two disagreeing measurements is right,
// which is precisely the judgement this module refuses to make on a guess. It
// quarantines both sides and records the conflict.
export const BOUNDARY_POLICY_VERSION = 2;

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

export type BoundaryWord = {
  start_ms: number;
  end_ms: number;
  /**
   * TRUE when the pipeline judged this word unplaceable (see the alignment
   * engine's verdict plus the policy-v6 reconciliation). Such a word is NOT
   * validated timing and is therefore excluded from the authoritative core —
   * see coreOf(). Carried here because the core cannot honour its own contract
   * without knowing which words were actually validated.
   */
  unresolved?: boolean;
};

export type BoundaryRow = {
  start_ms: number;
  end_ms: number;
  is_music?: boolean;
  /**
   * [Text authority] This row's text is operator-authored and it has no measured
   * words, so refinement carried it through unchanged. Set EXPLICITLY by the
   * caller — never inferred from the absence of words — so 'authored_preserved'
   * can only ever describe that deliberate decision and can never become a
   * generic label for a row whose alignment simply produced nothing.
   */
  _authored_preserved?: boolean;
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
  /** Position in the delivered order. Used only to report a conflict's location. */
  sequence_index?: number;
  /**
   * [v2] This row's final window is chronologically inverted against its adjacent
   * neighbour. Consumed by the segment-state model (quarantine) and the integrity
   * audit (run-level counters). Never set on a healthy timeline.
   */
  chronology_conflict?: boolean;
  chronology_conflict_ms?: number;
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
   * [Text authority] Rows whose operator-authored boundary was deliberately
   * preserved because refinement had no measured word evidence to re-derive it
   * from. Counted separately from music so the audit never conflates "a
   * non-dialogue line has no words" with "a human wrote this line and we
   * measured nothing".
   */
  rows_authored_preserved: number;
  /**
   * Rows that DO carry measured words but not one validated one, so no core
   * could be formed and the window was taken from preserved evidence instead of
   * derived from the unplaceable positions. Counted separately from music and
   * authored rows because the cause is different in kind: this is a dialogue row
   * whose alignment failed outright, and it is always quarantined
   * UNRESOLVED_TIMING. A rising value is a measurement of alignment quality
   * upstream, not of this stage.
   */
  rows_unresolved_preserved: number;
  /**
   * Rows in that state whose window was recovered from the PROVIDER's own
   * segment boundary (real preserved measurement) rather than merely left at the
   * unplaceable positions the grouping stage had put on the row.
   */
  rows_unresolved_provider_recovered: number;
  /**
   * Rows whose provider boundary cut INSIDE their own validated words — the
   * defect class this module removes. Line 18 is one of these. A non-zero value
   * is a measurement of upstream segmentation quality, not of this stage.
   */
  provider_contradictions_prevented: number;
  worst_extension_ms: number;
  worst_reduction_ms: number;
  worst_lead_out_granted_ms: number;
  /**
   * [v2] Rows quarantined because the derived timeline is chronologically
   * inverted across adjacent rows. BOTH sides of each inversion are counted — a
   * reviewer needs the pair, not one half of it. Zero is the expected steady
   * state; a non-zero value means two adjacent rows were resolved on timelines
   * that disagree about their ORDER, which no downstream stage can repair and
   * which must therefore never be emitted silently.
   */
  chronology_conflict_rows: number;
  worst_chronology_inversion_ms: number;
  /** sequence_index of every row involved in an inversion, ascending. Bounded. */
  chronology_conflict_sequences: number[];
};

const finite = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Does this row carry any measured word evidence at all (resolved or not)? */
function hasWords(row: BoundaryRow): boolean {
  return (row._boundary_words || []).length > 0;
}

/**
 * first-to-last VALIDATED word span — the authoritative core of the segment.
 *
 * UNRESOLVED WORDS ARE EXCLUDED. This is the contract stated at the top of this
 * module ("FIRST-TO-LAST VALIDATED WORD"), and until 2026-08-20 the
 * implementation did not honour it: every word was folded in regardless of its
 * verdict, so a word the pipeline had *just declared unplaceable* became the
 * authority for the segment's window.
 *
 * GROUND TRUTH (project 6a85757eb3fb1626eb1fea43, run 6a8621e09fe756d206e5fd25):
 * on row 5 the aligner stacked all three words of "Things at Hogwarts?" onto
 * 30139->30140 and flagged all three unresolved. That 1ms stack became the core,
 * padding was added around it, and the row shipped a 211ms window at 30129-30340
 * for a line the transcriber had measured at 29497-29846 — a 632ms placement
 * error and a physically impossible 90 cps. Row 43 failed identically. The
 * structural invariant below could not catch it, because a 1ms core is trivially
 * contained by any window, and the provider-stability escape hatch could not
 * rescue it either, because the 632ms disagreement exceeds the epsilon.
 *
 * A row with no validated words therefore has NO core, and the caller must fall
 * back to preserved evidence rather than derive a window from a collapse stack.
 */
function coreOf(row: BoundaryRow): { start: number; end: number } | null {
  const words = row._boundary_words || [];
  let start = Infinity;
  let end = -Infinity;
  for (const word of words) {
    if (word?.unresolved === true) continue;
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
    rows_authored_preserved: 0,
    rows_unresolved_preserved: 0,
    rows_unresolved_provider_recovered: 0,
    provider_contradictions_prevented: 0,
    worst_extension_ms: 0,
    worst_reduction_ms: 0,
    worst_lead_out_granted_ms: 0,
    chronology_conflict_rows: 0,
    worst_chronology_inversion_ms: 0,
    chronology_conflict_sequences: [],
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

    if (!core && hasWords(row)) {
      // MEASURED WORDS EXIST, BUT NOT ONE OF THEM IS VALIDATED. This is the
      // alignment-collapse case, and it is emphatically NOT the music/authored
      // case below: this row is dialogue, words were measured for it, and the
      // aligner simply could not place any of them. Deriving a window from those
      // positions is what produced the 632ms placement error described on
      // coreOf(), so nothing here is derived from them.
      //
      // THE PROVIDER'S SEGMENT BOUNDARY IS PREFERRED, and it is evidence rather
      // than a guess: it is the transcriber's own measurement, preserved
      // untouched on the row precisely so it can answer this question. It is
      // supplied only when the row corresponds 1:1 to one provider segment, so
      // it can never be borrowed from a sibling of a split.
      //
      // Only when no comparable provider boundary exists is the incoming window
      // left exactly as it arrived — that is the least-bad visible timing, and
      // the row is quarantined either way, so it is never mistaken for proven.
      const providerStart = finite(row.provider_boundary_start_ms);
      const providerEnd = finite(row.provider_boundary_end_ms);
      const recoverable = providerStart !== null && providerEnd !== null
        && providerEnd > providerStart && providerStart >= 0;

      const priorStart = finite(row.start_ms);
      const priorEnd = finite(row.end_ms);
      if (recoverable) {
        row.start_ms = Math.round(providerStart);
        row.end_ms = Math.round(providerEnd);
        report.rows_unresolved_provider_recovered += 1;
      }
      row.boundary_source = 'unresolved_words_preserved';
      // No padding is granted. Padding is earned from measured silence around a
      // validated core, and there is no validated core here.
      row.boundary_lead_in_ms = 0;
      row.boundary_lead_out_ms = 0;
      row.boundary_delta_start_ms = priorStart === null ? 0 : Math.round(Number(row.start_ms) - priorStart);
      row.boundary_delta_end_ms = priorEnd === null ? 0 : Math.round(Number(row.end_ms) - priorEnd);
      report.rows_unresolved_preserved += 1;
      previousFinalEnd = finite(row.end_ms);
      continue;
    }

    if (!core) {
      // No validated words. Its window is not derived from speech, so there is
      // nothing here to re-derive — and inventing a boundary for it would be a
      // claim the evidence does not support.
      //
      // TWO DISTINCT CAUSES, LABELLED DISTINCTLY. A music/non-dialogue row has no
      // words because it carries no speech. An AUTHORED row has no words because a
      // human wrote its text and nothing was ever measured for it. Recording both
      // as 'music_preserved' would put a false statement on a dialogue line's audit
      // record, so the authored case gets its own value — and only ever when the
      // caller set the flag explicitly, so it can never degrade into a fallback for
      // missing or failed alignment on a machine-owned row.
      const authored = row._authored_preserved === true && row.is_music !== true;
      row.boundary_source = authored ? 'authored_preserved' : 'music_preserved';
      row.boundary_lead_in_ms = 0;
      row.boundary_lead_out_ms = 0;
      row.boundary_delta_start_ms = 0;
      row.boundary_delta_end_ms = 0;
      if (authored) report.rows_authored_preserved += 1;
      else report.rows_music_preserved += 1;
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

  enforceChronology(list, report);
  return report;
}

/**
 * [v2] CROSS-ROW CHRONOLOGY INVARIANT — the delivered timeline must not go
 * backwards.
 *
 * Runs after every row's window is final, because that is the only point at which
 * the question can be asked: the per-row rules are individually correct and the
 * conflict is a property of the PAIR.
 *
 * WHAT IS CHECKED, AND WHAT DELIBERATELY IS NOT. Only the START ORDER of ADJACENT
 * rows. Overlap is NOT a violation: two rows overlap legitimately whenever two
 * people speak at once, cross-speaker overlap is preserved by design (see the
 * header), and the final mixer sums those clips deliberately. Same-speaker
 * overlap — the case that IS an attribution error — is already detected and
 * bounded-repaired by the timeline-integrity audit, and duplicating it here would
 * quarantine rows that stage repairs correctly. So this invariant catches exactly
 * the class nothing else can see: row N+1 beginning before row N.
 *
 * NOTHING IS RESOLVED. No reorder, no clamp, no nudge. Both sides are marked and
 * the magnitude recorded; the state model quarantines them UNRESOLVED_TIMING and
 * an operator rules. Picking a "corrected" placement would mean choosing between
 * two measurements that disagree, on no evidence — the exact guess this module
 * exists to refuse.
 */
function enforceChronology(list: BoundaryRow[], report: BoundaryReport): void {
  const conflicted = new Set<number>();

  for (let index = 1; index < list.length; index++) {
    const previousStart = finite(list[index - 1]?.start_ms);
    const currentStart = finite(list[index]?.start_ms);
    if (previousStart === null || currentStart === null) continue;
    if (currentStart >= previousStart) continue;

    const inversion = Math.round(previousStart - currentStart);
    if (inversion > report.worst_chronology_inversion_ms) {
      report.worst_chronology_inversion_ms = inversion;
    }
    // Both sides. Each row keeps the WORST inversion it participates in, so a row
    // caught between two conflicts reports the more serious one.
    for (const side of [index - 1, index]) {
      const row = list[side];
      if (!row) continue;
      conflicted.add(side);
      row.chronology_conflict = true;
      row.chronology_conflict_ms = Math.max(Number(row.chronology_conflict_ms || 0), inversion);
    }
  }

  report.chronology_conflict_rows = conflicted.size;
  report.chronology_conflict_sequences = [...conflicted]
    .map((index) => Number(list[index]?.sequence_index ?? index))
    .sort((a, b) => a - b)
    .slice(0, 500);
}
