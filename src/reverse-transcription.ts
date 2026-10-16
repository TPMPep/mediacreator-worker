export const REVERSE_POLICY_VERSION = 1;
export const REVERSE_MIN_GAP_MS = 3000;
export function reverseDialogueGaps(raw: any, provider: string, projectDuration: number, fps = 25) {
  if (!['assemblyai', 'elevenlabs'].includes(provider)) throw new Error('Unsupported reverse transcription provider');
  if (provider === 'assemblyai' && raw?.status !== 'completed') throw new Error('Reverse transcription requires completed provider evidence');
  if (!Array.isArray(raw?.words)) throw new Error('Reverse transcription requires word timing evidence');
  const duration = Number(projectDuration) > 0 ? Number(projectDuration) : Number(raw.audio_duration) * 1000;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 14400000) throw new Error('Reverse transcription needs a measured full media duration (maximum 4 hours)');
  if (!Number.isFinite(fps) || fps <= 0 || fps > 120) throw new Error('Reverse transcription needs a valid frame rate');
  const words = raw.words.filter((w: any) => provider === 'assemblyai' || w.type === 'word');
  if (provider === 'assemblyai' && !words.length && String(raw.text || '').trim()) throw new Error('Speech was detected without usable word timings');
  const speech: Array<[number, number]> = words.map((w: any) => {
    const scale = provider === 'assemblyai' ? 1 : 1000;
    if (typeof w.start !== 'number' || typeof w.end !== 'number' || !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start < 0 || w.end <= w.start || w.end * scale > duration + 250) throw new Error('Invalid speech timing evidence; refusing to invent dialogue-free gaps');
    return [Math.max(0, Math.floor(w.start * scale)), Math.min(duration, Math.ceil(w.end * scale))];
  });
  speech.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const span of speech) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else merged.push([...span]);
  }
  const gaps: Array<{ start: number; end: number }> = [];
  const add = (start: number, end: number) => {
    const a = Math.ceil(start * fps / 1000 - 1e-9) * 1000 / fps;
    const b = Math.floor(end * fps / 1000 + 1e-9) * 1000 / fps;
    const startMs = Math.max(0, Math.ceil(a - 1e-6)), endMs = Math.floor(b + 1e-6);
    if (endMs - startMs >= REVERSE_MIN_GAP_MS) gaps.push({ start: startMs, end: endMs });
  };
  let cursor = 0;
  for (const [start, end] of merged) { add(cursor, start); cursor = Math.max(cursor, end); }
  add(cursor, duration);
  return { gaps, evidence: { policy_version: REVERSE_POLICY_VERSION, minimum_gap_ms: REVERSE_MIN_GAP_MS, source_word_count: words.length, speech_interval_count: merged.length, gap_count: gaps.length, duration_ms: duration, timing_basis: 'provider_word_union', review_required: true } };
}
