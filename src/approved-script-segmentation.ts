export type ApprovedWord = {
  text?: string;
  start_ms: number;
  end_ms: number;
  cluster?: string | null;
};

export type ApprovedGroup<W extends ApprovedWord = ApprovedWord> = { cluster: string; words: W[] };

const PAUSE_BREAK_MS = 650;
const SOFT_PAUSE_MS = 200;
const MAX_DURATION_MS = 12_000;
const SOFT_CHAR_LIMIT = 180;
const HARD_CHAR_LIMIT = 260;
const ENDS_UTTERANCE = /[.!?…]["'”’)}\]]*$/;

export function approvedTextHash(text: string): string {
  let hash = 0x811c9dc5;
  const value = String(text || '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function segmentApprovedScriptWords<W extends ApprovedWord>(words: W[]): ApprovedGroup<W>[] {
  const groups: ApprovedGroup<W>[] = [];
  for (const word of words) {
    const cluster = String(word.cluster || '');
    const current = groups.at(-1);
    if (!current) { groups.push({ cluster, words: [word] }); continue; }
    const previous = current.words.at(-1)!;
    const gap = Number(word.start_ms) - Number(previous.end_ms);
    const duration = Number(previous.end_ms) - Number(current.words[0].start_ms);
    const chars = current.words.reduce((sum, item) => sum + String(item.text || '').length + 1, 0);
    const semanticPause = ENDS_UTTERANCE.test(String(previous.text || '')) && gap >= SOFT_PAUSE_MS;
    const sizeBreak = duration >= MAX_DURATION_MS || chars >= HARD_CHAR_LIMIT || (chars >= SOFT_CHAR_LIMIT && semanticPause);
    if (cluster !== current.cluster || gap >= PAUSE_BREAK_MS || sizeBreak) groups.push({ cluster, words: [word] });
    else current.words.push(word);
  }
  return groups;
}
