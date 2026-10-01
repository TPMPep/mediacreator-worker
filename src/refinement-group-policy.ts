import { resolveOutputGroups, textIsAuthoritative, type ClusterWord, type ClusterGroup } from './text-authority.js';

export const joinRefinementWords = (words: any[]) => words.map(w => String(w.text || '').trim()).filter(Boolean).join(' ').replace(/\s+([,.;:!?])/g, '$1').replace(/\s+/g, ' ').trim();
const normalize = (text: unknown) => String(text || '').replace(/\s+/g, ' ').trim();

// A fidelity check is not an authorship inference: machine rows whose text
// cannot be partitioned exactly are held for review, not relabeled as edited.
export function refinementStructureHoldReason(segment: any): string {
  if (textIsAuthoritative(segment)) return 'Operator-authored wording and line structure are preserved.';
  if (segment.source_text_status !== 'machine') return 'Text provenance is unspecified; automatic splitting was withheld.';
  if (segment.source_text_approved === true) return 'Approved wording and line structure are preserved.';
  if (segment.boundary_source === 'authored_preserved' || segment.timing_manual_override_at || segment.rythmo_timings_edited_at || segment.rythmo_word_timings?.length) return 'Operator timing and line structure are preserved.';
  const words = segment.aai_word_timings || [];
  if (!words.length || normalize(joinRefinementWords(words)) !== normalize(segment.source_text)) return 'The captured word stream does not reproduce this line exactly; splitting was withheld to preserve its wording.';
  if (words.some((w: any) => !Number.isFinite(w.start_ms) || !Number.isFinite(w.end_ms) || w.start_ms < 0 || w.end_ms <= w.start_ms)) return 'Invalid provider word windows cannot support a speaker-boundary split.';
  return '';
}

export function resolveRefinementGroups<W extends ClusterWord & { speaker_unresolved?: boolean }>(segment: any, groups: ClusterGroup<W>[]) {
  const uncertain = groups.some(group => group.words.some((word: any) => word.speaker_unresolved === true));
  const reason = refinementStructureHoldReason(segment) || (uncertain ? 'Some words have ambiguous speaker attribution; the line was kept intact for review.' : '');
  return resolveOutputGroups(segment, groups, reason);
}

// Proof of one-to-many lineage before any staging; timings and words must be
// conserved exactly, even when adjacent speakers overlap.
export function assertRefinementPartition(source: any, children: any[]) {
  if (refinementStructureHoldReason(source)) throw new Error('protected_source_structure_changed');
  const delivered = children.flatMap(row => row.aai_word_timings || []);
  if (JSON.stringify(delivered) !== JSON.stringify(source.aai_word_timings || [])) throw new Error('refinement_word_capture_changed');
  if (normalize(children.map(row => row.source_text).join(' ')) !== normalize(source.source_text)) throw new Error('refinement_text_conservation_failed');
  if (children.some(row => !Number.isFinite(row.start_ms) || !Number.isFinite(row.end_ms) || row.end_ms <= row.start_ms)) throw new Error('refinement_split_window_invalid');
}
