import type { AlignmentInputWord, AlignmentResult, AlignmentWord } from './alignment-client.js';
type BaselineEvidence = Omit<AlignmentResult, 'verified' | 'provider' | 'audio_sha256'> & { verified: false; provider: 'transcription_provider'; audio_sha256: null };
// Preservation is not validation: keep the committed row's text, sequence and
// editorial timing exactly; retained provider evidence is never a replacement
// for a later operator edit. This module performs no I/O.
export function preserveCommittedRows(output: any[], source: any[]) {
  if (output.length !== source.length) throw new Error('provider_baseline_structure_changed');
  output.forEach((row, index) => {
    const original = source[index];
    if (row.source_text !== original.source_text) throw new Error('provider_baseline_text_changed');
    row.sequence_index = original.sequence_index;
    row.start_ms = original.start_ms;
    row.end_ms = original.end_ms;
    row.aai_word_timings = original.aai_word_timings || [];
    row.boundary_source = original.boundary_source || '';
    for (const key of ['source_text_approved','source_text_approved_text_hash','source_text_approved_by','source_text_approved_at','rythmo_word_timings','rythmo_timings_source','rythmo_timings_edited_by','rythmo_timings_edited_at','timing_manual_override_by','timing_manual_override_at','timing_manual_override_reason','timing_manual_override_prior_state','timing_manual_override_prior_start_ms','timing_manual_override_prior_end_ms','consensus_run_id','consensus_word_sources']) {
      if (original[key] !== undefined) row[key] = original[key];
    }
  });
  for (let index=1;index<output.length;index++) {
    const delta=output[index-1].start_ms-output[index].start_ms;
    if(delta>0)for(const row of [output[index-1],output[index]]){row.chronology_conflict=true;row.chronology_conflict_ms=Math.max(row.chronology_conflict_ms||0,delta);}
  }
}

export function providerBaselineEvidence(input: AlignmentInputWord[], language: string, build: string): BaselineEvidence {
  return { ok: true, verified: false, request_id: '', audio_sha256: null, max_regression_ms: 0, provider: 'transcription_provider', model: 'provider-baseline', model_revision: build,
    language_code: language, words: input.map((word): AlignmentWord => ({ ...word,
      start_ms: word.provider_start_ms, end_ms: word.provider_end_ms, confidence: 0,
      unresolved: true, unresolved_reason: 'provider_baseline_not_independently_aligned' })),
    word_count: input.length, mean_confidence: 0, max_provider_shift_ms: 0,
    p99_provider_shift_ms: 0, median_provider_shift_ms: 0, outlier_tolerance_ms: 0,
    outlier_word_count: 0, outlier_ratio: 0, unresolved_word_count: input.length,
    timing_repair_count: 0, expansion_policy_version: 0, alignment_pass_count: 0,
    expanded_chunk_count: 0, max_expansion_ms: 0, duration_ms: 0 };
}
