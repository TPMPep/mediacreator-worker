// APPROVED-SCRIPT TIMING — line identity, alignment tokens and speaker authority.
//
// An approved script is a frozen deliverable: every line's wording AND its named
// speaker were signed off by a person. Timing may move a line on the timeline; it
// may never merge, split, reword or re-attribute it. So:
//   • each approved line becomes exactly one timed row (line identity is kept);
//   • the script's speaker name is the attribution, and the diarization only
//     CHECKS it — a measured disagreement is flagged for a person, never applied;
//   • text is tokenized for alignment so scripts written without spaces
//     (Japanese, Chinese, Korean) are placed character by character instead of as
//     whole-sentence blobs that cannot be matched to speech.

export type ApprovedWord = {
  text?: string;
  start_ms: number;
  end_ms: number;
  cluster?: string | null;
  speaker_unresolved?: boolean;
  space_before?: boolean;
  _line_id?: string;
  _line_label?: string;
};

export type ApprovedGroup<W extends ApprovedWord = ApprovedWord> = { cluster: string; line_id?: string; words: W[] };
export type ApprovedToken = { text: string; space_before: boolean };

export const UNATTRIBUTED_LABEL = 'Unattributed';
export const scriptSpeakerKey = (label: string) => `script:${label || UNATTRIBUTED_LABEL}`;

// Scripts written without inter-word spaces. Each character is its own alignment
// token; the prolonged-sound mark and iteration mark belong to these scripts too.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC\u3005\u303B]/u;
const ALNUM = /[\p{L}\p{N}\p{M}]/u;

export function approvedTextHash(text: string): string {
  let hash = 0x811c9dc5;
  const value = String(text || '');
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The approved line as delivered: every character kept, whitespace runs as one space. */
export const normalizeApprovedLine = (text: string) => String(text || '').replace(/\s+/g, ' ').trim();

/**
 * Split one approved line into alignment tokens. Lossless by construction:
 * joinApprovedTokens(tokenizeApprovedLine(t)) === normalizeApprovedLine(t).
 * Punctuation never forms its own token (it has no speech): trailing marks attach
 * to the token before them, opening marks to the token after them.
 */
export function tokenizeApprovedLine(text: string): ApprovedToken[] {
  const tokens: ApprovedToken[] = [];
  let run = '', prefix = '', space = false;
  const emit = (value: string) => { tokens.push({ text: value, space_before: space && tokens.length > 0 }); space = false; };
  const flushRun = () => { if (run) { emit(run); run = ''; } };
  for (const ch of String(text || '')) {
    if (/\s/u.test(ch)) { flushRun(); if (prefix) { emit(prefix); prefix = ''; } space = true; continue; }
    if (UNSPACED.test(ch)) { flushRun(); emit(prefix + ch); prefix = ''; continue; }
    if (ALNUM.test(ch)) { if (!run) { run = prefix; prefix = ''; } run += ch; continue; }
    if (run) { run += ch; continue; }
    if (tokens.length && !space && !prefix) { tokens[tokens.length - 1].text += ch; continue; }
    prefix += ch;
  }
  flushRun();
  if (prefix) { if (tokens.length && !space) tokens[tokens.length - 1].text += prefix; else emit(prefix); }
  return tokens;
}

export function joinApprovedTokens(words: Array<{ text?: string; space_before?: boolean }>): string {
  return words.map((word, index) => (index && word.space_before ? ' ' : '') + String(word.text || '')).join('');
}

/** One group per approved line, in order. The cluster is the script's speaker. */
export function groupApprovedLines<W extends ApprovedWord>(words: W[]): ApprovedGroup<W>[] {
  const groups: ApprovedGroup<W>[] = [];
  for (const word of words) {
    const last = groups.at(-1);
    if (last && last.line_id === word._line_id) last.words.push(word);
    else groups.push({ cluster: scriptSpeakerKey(String(word._line_label || '')), line_id: word._line_id, words: [word] });
  }
  return groups;
}

// A line is only judged when diarization measured enough of it, and a voice is
// only "another character's" when it is that character's dominant voice.
const MIN_MEASURED_TOKENS = 3;
const MIN_MEASURED_SHARE = 0.6;

/**
 * Check the script's speaker names against the measured voices. Each script
 * speaker's dominant diarization cluster is learned from all of its lines; a line
 * whose own measured voice is clearly another script speaker's dominant voice is
 * returned with a plain-English reason. The name is never changed.
 */
export function scriptSpeakerDisagreements<W extends ApprovedWord>(groups: ApprovedGroup<W>[]): Map<ApprovedGroup<W>, string> {
  const measured = groups.map((group) => {
    const weights = new Map<string, number>();
    let total = 0, tokens = 0;
    for (const word of group.words) {
      if (word.speaker_unresolved === true || !word.cluster) continue;
      const weight = Math.max(1, String(word.text || '').length);
      weights.set(String(word.cluster), (weights.get(String(word.cluster)) || 0) + weight);
      total += weight; tokens += 1;
    }
    const top = [...weights.entries()].sort((a, b) => b[1] - a[1])[0];
    return top && tokens >= MIN_MEASURED_TOKENS && top[1] / total >= MIN_MEASURED_SHARE ? top[0] : null;
  });
  const votes = new Map<string, Map<string, number>>();
  groups.forEach((group, index) => {
    const voice = measured[index];
    if (!voice) return;
    const tally = votes.get(group.cluster) || new Map<string, number>();
    tally.set(voice, (tally.get(voice) || 0) + group.words.length);
    votes.set(group.cluster, tally);
  });
  const dominant = new Map<string, string>();
  for (const [speaker, tally] of votes) dominant.set(speaker, [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  const ownerOf = new Map<string, string>();
  for (const [speaker, voice] of dominant) if (!ownerOf.has(voice)) ownerOf.set(voice, speaker);
  const out = new Map<ApprovedGroup<W>, string>();
  groups.forEach((group, index) => {
    const voice = measured[index];
    if (!voice || dominant.get(group.cluster) === voice) return;
    const other = ownerOf.get(voice);
    if (!other || other === group.cluster) return;
    const name = (key: string) => key.replace(/^script:/, '');
    out.set(group, `The script names ${name(group.cluster)} for this line, but the voice heard here matches ${name(other)} elsewhere in the programme. The script's name is kept; please confirm who speaks this line.`);
  });
  return out;
}
