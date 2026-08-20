// =============================================================================
// text-authority — the single refinement invariant separating TEXT AUTHORITY
// from ACOUSTIC/TIMING EVIDENCE.
// -----------------------------------------------------------------------------
// THE INVARIANT, in one sentence:
//
//   Machine evidence may refine timing, speaker and boundary structure.
//   Authoritative text may not be overwritten by machine evidence, and an
//   authoritative row may not be structurally divided by machine evidence.
//
// WHY THIS MODULE EXISTS. Refinement rebuilt every output row's text as
// `join(g.words)` — the provider's word tokens — unconditionally. That is
// correct for an untouched machine transcript and silently destructive the
// moment a human has authored the text: an operator who corrects a
// mis-transcription, merges two lines, or splits one has produced the
// AUTHORITATIVE version of that line, and a later speaker/timing pass would
// replace it with the original machine words. The edit survives in the editor
// until refinement runs, then reverts with no signal.
//
// WHY IT IS ONE PREDICATE RATHER THAN A BRANCH PER PRODUCER. Every producer of
// human-authored text already converges on ONE field before refinement ever
// sees the row:
//   • saveEditorialSegmentEdit (source_text edit)      -> 'edited'
//   • mutateDubbingSegmentStructure mergePair          -> 'edited'
//   • batchMergeSegments (merge survivor)              -> 'edited'
//   • mutateDubbingSegmentStructure split (both halves)-> 'edited'
//   • setSegmentApproval / editorial approval          -> 'approved'
//   • untouched machine transcript                     -> 'machine'
// So the invariant needs no knowledge of merges, edits or splits. It asks one
// question — "did a human author this text?" — and that question is answered by
// provenance, never by comparing the text against the words.
//
// PROVENANCE, NOT COMPARISON. A divergence between `source_text` and
// `aai_word_timings` is a SYMPTOM, and it cannot distinguish a human correction
// from an ordinary machine artifact. Keying on divergence would hand text
// authority to rows no human ever touched. This module therefore reads
// `source_text_status` and nothing else.
//
// SOC 2 CC8.1 — a delivered line's text is provably attributable to either the
// transcription provider or a named operator, and refinement can never move a
// line from the second category to the first.
// =============================================================================

/**
 * Statuses that mark `source_text` as HUMAN-AUTHORED and therefore
 * authoritative over any machine word tokens.
 *
 * 'edited'   a human (or a human-initiated structural operation) wrote this text.
 * 'approved' a human ratified this text; ratification is authorship of record.
 *
 * 'machine' is deliberately absent: an untouched provider transcript has no
 * human authority, so it keeps the existing rebuild-from-words behaviour exactly.
 */
export const AUTHORITATIVE_TEXT_STATUSES = ['edited', 'approved'] as const;

export type AuthoritySegment = {
  source_text?: string;
  source_text_status?: string;
};

export type ClusterWord = { start_ms?: number; end_ms?: number };
export type ClusterGroup<W extends ClusterWord = ClusterWord> = { cluster: string; words: W[] };

export type ResolvedGroups<W extends ClusterWord = ClusterWord> = {
  /** The groups refinement should actually emit rows for. */
  groups: ClusterGroup<W>[];
  /** True when a machine-proposed split of an authoritative row was refused. */
  collapsed: boolean;
  /** Cluster carried by the collapsed row, chosen by measured duration. */
  dominant_cluster: string | null;
  /** Plain-English reason for the operator, when collapsed. */
  reason: string;
};

/** Is this row's `source_text` human-authored, and therefore authoritative? */
export function textIsAuthoritative(segment: AuthoritySegment | null | undefined): boolean {
  const status = String(segment?.source_text_status || '');
  return (AUTHORITATIVE_TEXT_STATUSES as readonly string[]).includes(status);
}

/**
 * The text an output row must carry.
 *
 * Machine rows behave EXACTLY as before (`machineText || source_text`), so this
 * function is a no-op for every untouched transcript. An authoritative row keeps
 * its own text.
 *
 * An authoritative row whose text is blank falls back to the machine text: an
 * empty line is not an editorial assertion worth preserving, and emitting an
 * empty row would be a worse outcome than showing the measured words.
 */
export function resolveOutputText(
  segment: AuthoritySegment,
  machineText: string,
): string {
  const own = String(segment?.source_text || '');
  if (textIsAuthoritative(segment) && own.trim()) return own;
  return machineText || own;
}

/**
 * Decide the output grouping for one source row.
 *
 * Refinement groups a row's words by consecutive diarization cluster, and emits
 * one row per group — i.e. it SPLITS a line when it hears a speaker change
 * inside it. That is right for a machine transcript and unsafe for an
 * authoritative one: there is no way to divide operator-authored text across two
 * output rows without guessing which words belong to which half, and a wrong
 * guess silently rewrites both the line's text and its attribution.
 *
 * So an authoritative row is kept STRUCTURALLY INTACT. It still receives every
 * refinement that does not require dividing it (window from its first-to-last
 * validated word, boundary policy, timing arbitration, evidence), and the
 * unresolved speaker attribution is disclosed rather than guessed — the caller
 * marks it UNRESOLVED_SPEAKER so an operator rules on it. Only that row is
 * affected; the rest of the project refines normally.
 *
 * The carried cluster is the one with the greatest MEASURED SPEECH DURATION, not
 * the most words: duration is the honest measure of who holds the line. Ties
 * fall to first appearance, so the outcome is deterministic.
 */
export function resolveOutputGroups<W extends ClusterWord>(
  segment: AuthoritySegment,
  groups: ClusterGroup<W>[],
): ResolvedGroups<W> {
  const list = Array.isArray(groups) ? groups : [];
  if (!textIsAuthoritative(segment) || list.length <= 1) {
    return { groups: list, collapsed: false, dominant_cluster: list[0]?.cluster ?? null, reason: '' };
  }

  const totals = new Map<string, number>();
  for (const group of list) {
    const measured = (group.words || []).reduce((sum, word) => {
      const start = Number(word?.start_ms);
      const end = Number(word?.end_ms);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return sum;
      return sum + Math.max(0, end - start);
    }, 0);
    totals.set(group.cluster, (totals.get(group.cluster) || 0) + measured);
  }

  // Strict `>` walking the groups in order gives first-appearance tie-breaking.
  let dominant = list[0].cluster;
  let bestMs = -1;
  for (const group of list) {
    const measured = totals.get(group.cluster) || 0;
    if (measured > bestMs) { bestMs = measured; dominant = group.cluster; }
  }

  const speakerCount = new Set(list.map(group => group.cluster)).size;
  return {
    groups: [{ cluster: dominant, words: list.flatMap(group => group.words || []) }],
    collapsed: true,
    dominant_cluster: dominant,
    reason: `Refinement heard ${speakerCount} different speakers inside this operator-authored line. The line was kept whole rather than divided — splitting it would mean guessing which words belong to which speaker — so its speaker attribution is not proven and needs an operator ruling.`,
  };
}
