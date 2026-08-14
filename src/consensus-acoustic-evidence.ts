import { alignTranscript, type AlignmentInputWord, type AlignmentResult } from './alignment-client.js';

type ProviderWord = { text?: string; start?: number; end?: number; confidence?: number; type?: string };

const punctuationOnly = (text: string) => {
  const value = String(text || '').trim();
  return !value || !/[\p{L}\p{N}]/u.test(value);
};

function primaryWords(raw: any): AlignmentInputWord[] {
  return (Array.isArray(raw?.words) ? raw.words : []).map((word: ProviderWord, index: number) => ({
    key: `p:${index}`,
    text: String(word.text || '').trim(),
    provider_start_ms: Number(word.start),
    provider_end_ms: Number(word.end),
  })).filter((word: AlignmentInputWord) => word.text && Number.isFinite(word.provider_start_ms) && Number.isFinite(word.provider_end_ms));
}

function secondaryWords(raw: any): AlignmentInputWord[] {
  const output: AlignmentInputWord[] = [];
  for (const word of Array.isArray(raw?.words) ? raw.words : []) {
    if (word?.type === 'spacing' || word?.type === 'audio_event' || punctuationOnly(word?.text)) continue;
    output.push({
      key: `s:${output.length}`,
      text: String(word.text || '').trim(),
      provider_start_ms: Math.round(Number(word.start || 0) * 1000),
      provider_end_ms: Math.round(Number(word.end || 0) * 1000),
    });
  }
  return output;
}

function languageCode(aaiRaw: any, fallback = 'en'): string {
  return String(aaiRaw?.language_code || fallback || 'en').toLowerCase().replace(/_/g, '-').split('-')[0];
}

function summarize(result: AlignmentResult) {
  return {
    verified: result.verified,
    provider: result.provider,
    model: result.model,
    model_revision: result.model_revision,
    language_code: result.language_code,
    audio_sha256: result.audio_sha256,
    word_count: result.word_count,
    mean_confidence: result.mean_confidence,
    max_provider_shift_ms: result.max_provider_shift_ms,
    duration_ms: result.duration_ms,
    words: result.words.map(word => ({ key: word.key, confidence: word.confidence, start_ms: word.start_ms, end_ms: word.end_ms })),
  };
}

export async function buildConsensusAcousticEvidence(input: {
  requestId: string;
  audioUrl: string;
  aaiRaw: any;
  scribeRaw: any;
  sourceLanguage?: string;
  signal: AbortSignal;
}) {
  const primary = primaryWords(input.aaiRaw);
  const secondary = secondaryWords(input.scribeRaw);
  if (!primary.length || !secondary.length) throw new Error('Consensus acoustic verification requires both provider word streams');
  const language = languageCode(input.aaiRaw, input.sourceLanguage);
  // Deliberately sequential: the alignment service is the bounded heavy lane.
  // Parallel calls would double source downloads and defeat its concurrency cap.
  const primaryResult = await alignTranscript({ requestId: `${input.requestId}:primary`, audioUrl: input.audioUrl, languageCode: language, words: primary, signal: input.signal });
  const secondaryResult = await alignTranscript({ requestId: `${input.requestId}:secondary`, audioUrl: input.audioUrl, languageCode: language, words: secondary, signal: input.signal });
  if (primaryResult.audio_sha256 !== secondaryResult.audio_sha256) throw new Error('Consensus acoustic evidence was computed from different source bytes');
  return {
    policy_version: 1,
    verified: true,
    source_audio_sha256: primaryResult.audio_sha256,
    language_code: language,
    generated_at: new Date().toISOString(),
    primary: summarize(primaryResult),
    secondary: summarize(secondaryResult),
  };
}
