export const SPEAKER_MIN_COVERAGE = 0.6;
export const SPEAKER_MIN_WIN_MARGIN = 0.2;

type Turn = { speaker: string; start: number; end: number };

export function attributeProviderWindow(turns: Turn[], startMs: number, endMs: number) {
  const start = Number(startMs) / 1000;
  const end = Number(endMs) / 1000;
  if (startMs == null || endMs == null || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { cluster: null, resolved: false, coverage: 0, margin: 0 };
  const duration = end - start;
  const intervals = new Map<string, Array<[number, number]>>();
  for (const turn of turns || []) {
    const left = Math.max(start, Number(turn.start)), right = Math.min(end, Number(turn.end));
    if (!turn.speaker || !Number.isFinite(left) || !Number.isFinite(right) || right <= left) continue;
    const list = intervals.get(turn.speaker) || []; list.push([left, right]); intervals.set(turn.speaker, list);
  }
  const totals = new Map<string, number>();
  for (const [speaker, spans] of intervals) {
    spans.sort((a,b) => a[0] - b[0]); let total = 0, until = -Infinity;
    for (const [left, right] of spans) { total += Math.max(0, right - Math.max(left, until)); until = Math.max(until, right); }
    totals.set(speaker, total);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const winner = ranked[0];
  if (!winner) return { cluster: null, resolved: false, coverage: 0, margin: 0 };
  const coverage = Math.min(1, winner[1] / duration);
  const runnerCoverage = Math.min(1, (ranked[1]?.[1] || 0) / duration);
  const margin = coverage - runnerCoverage;
  return {
    cluster: winner[0], coverage, margin,
    resolved: coverage >= SPEAKER_MIN_COVERAGE && margin >= SPEAKER_MIN_WIN_MARGIN,
  };
}

export function preserveProviderBaselineBoundaries(rows: any[]) {
  let preserved = 0;
  for (const row of rows || []) {
    if (typeof row.provider_boundary_start_ms === 'number' && typeof row.provider_boundary_end_ms === 'number' && Number.isFinite(row.provider_boundary_start_ms) && Number.isFinite(row.provider_boundary_end_ms) && row.provider_boundary_start_ms >= 0 && row.provider_boundary_end_ms > row.provider_boundary_start_ms) {
      // This reports preservation, not independent validation. Committed windows
      // (including human edits) already win and must not be replaced by evidence.
      row.boundary_source = row.boundary_source || '';
      row.boundary_delta_start_ms = 0;
      row.boundary_delta_end_ms = 0;
      row.boundary_lead_in_ms = 0;
      row.boundary_lead_out_ms = 0;
      preserved++;
    }
  }
  return { policy_version: 3, mode: 'benchmark_gated_provider_baseline', rows_derived: 0, rows_stable: 0, rows_provider_preserved: preserved, rows_music_preserved: 0, rows_authored_preserved: 0, rows_unresolved_preserved: 0, provider_contradictions_prevented: 0, worst_extension_ms: 0, worst_reduction_ms: 0 };
}
