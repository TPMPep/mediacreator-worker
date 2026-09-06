export type CanonicalWord = { text: string; start: number; end: number; confidence?: number | null };
export type CanonicalSegment = { speaker: string; start: number; end: number; text: string; confidence?: number | null; avg_word_confidence?: number | null; word_timings?: Array<{text:string;start_ms:number;end_ms:number;confidence?:number}>; is_music?: boolean; music_source?: string; music_context?: string };

const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/;
export function shapeCanonicalWords(words: CanonicalWord[]) {
  const chunks: CanonicalWord[][] = []; let current: CanonicalWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]; current.push(word);
    const next = words[i + 1];
    if (!next || SENTENCE_END.test(String(word.text).trim()) || next.start - word.end >= 650) { chunks.push(current); current = []; }
  }
  const merged: CanonicalWord[][] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]; const duration = chunk.at(-1)!.end - chunk[0].start;
    const previous = merged.at(-1); const next = chunks[i + 1];
    const gapPrevious = previous ? chunk[0].start - previous.at(-1)!.end : Infinity;
    const gapNext = next ? next[0].start - chunk.at(-1)!.end : Infinity;
    if (duration < 1200 && chunk.length < 3 && previous && gapPrevious < 650) merged[merged.length - 1] = previous.concat(chunk);
    else if (duration < 1200 && chunk.length < 3 && next && gapNext < 650) chunks[i + 1] = chunk.concat(next);
    else merged.push(chunk);
  }
  return merged;
}

export function isDialogueWord(text: unknown) { return /[\p{L}\p{N}]/u.test(String(text || '')); }
export function isMusicOnly(dialogueWords: CanonicalWord[]) { return dialogueWords.filter(word => isDialogueWord(word.text)).length === 0; }
export function wordTimings(words: CanonicalWord[]) { return words.filter(word => isDialogueWord(word.text)).map(word => ({ text: word.text, start_ms: word.start, end_ms: word.end, ...(typeof word.confidence === 'number' ? { confidence: +word.confidence.toFixed(4) } : {}) })); }
