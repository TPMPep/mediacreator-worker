import { env } from './env.js';

export type AlignmentInputWord = {
  key: string;
  text: string;
  provider_start_ms: number;
  provider_end_ms: number;
};

export type AlignmentWord = AlignmentInputWord & {
  start_ms: number;
  end_ms: number;
  confidence: number;
  raw_start_ms?: number;
  raw_end_ms?: number;
  timing_repaired?: boolean;
};

export type AlignmentResult = {
  ok: true;
  verified: true;
  request_id: string;
  provider: 'elevenlabs_forced_alignment';
  model: string;
  model_revision: string;
  language_code: string;
  audio_sha256: string;
  word_count: number;
  mean_confidence: number;
  max_provider_shift_ms: number;
  timing_repair_count: number;
  max_regression_ms: number;
  duration_ms: number;
  words: AlignmentWord[];
};

function normalize(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export async function alignTranscript(input: {
  requestId: string;
  audioUrl: string;
  languageCode: string;
  words: AlignmentInputWord[];
  signal: AbortSignal;
}): Promise<AlignmentResult> {
  if (!env.ALIGNMENT_ENGINE_URL || !env.ALIGNMENT_ENGINE_SECRET) {
    throw new Error('Forced alignment engine is not configured');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ALIGNMENT_ENGINE_TIMEOUT_MS);
  const abort = () => controller.abort();
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(`${env.ALIGNMENT_ENGINE_URL.replace(/\/$/, '')}/align`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Alignment-Secret': env.ALIGNMENT_ENGINE_SECRET,
      },
      body: JSON.stringify({
        request_id: input.requestId,
        audio_url: input.audioUrl,
        language_code: input.languageCode,
        words: input.words,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Partial<AlignmentResult> & { detail?: string };
    if (!response.ok) throw new Error(`Forced alignment HTTP ${response.status}: ${body.detail || 'request failed'}`);
    if (!body.verified || !Array.isArray(body.words) || body.words.length !== input.words.length) {
      throw new Error('Forced alignment returned an incomplete verification result');
    }
    for (let index = 0; index < input.words.length; index += 1) {
      const expected = input.words[index];
      const actual = body.words[index];
      if (actual.key !== expected.key || normalize(actual.text) !== normalize(expected.text)) {
        throw new Error(`Forced alignment lineage mismatch at word ${index}`);
      }
      if (!Number.isFinite(actual.start_ms) || !Number.isFinite(actual.end_ms) || actual.end_ms <= actual.start_ms) {
        throw new Error(`Forced alignment produced an invalid window at ${actual.key}`);
      }
    }
    return body as AlignmentResult;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener('abort', abort);
  }
}
