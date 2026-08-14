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
  median_provider_shift_ms?: number;
  p95_provider_shift_ms?: number;
  p99_provider_shift_ms?: number;
  outlier_tolerance_ms?: number;
  outlier_word_count?: number;
  outlier_ratio?: number;
  outlier_sample?: Array<{ key: string; shift_ms: number }>;
  timing_repair_count: number;
  max_regression_ms: number;
  duration_ms: number;
  words: AlignmentWord[];
};

// ─── Release-blocking quality policy (SINGLE source of truth) ───────────────
// Consumed by BOTH the Duo consensus acoustic-evidence gate and the mandatory
// pyannote speaker-refinement gate, so the two can never drift apart.
//
// POSTURE — fail closed on SYSTEMIC failure, never on one word:
//   • mean_confidence below MIN_MEAN_CONFIDENCE  → the aligner itself is unsure.
//   • p99 shift above MAX_SYSTEMIC_SHIFT_MS      → the provider timeline is
//     broadly wrong, so the acoustic anchor cannot be trusted wholesale.
//   • outlier ratio above MAX_OUTLIER_RATIO      → disagreement is widespread
//     rather than incidental.
// The absolute max shift is retained verbatim as immutable evidence (archived
// to S3 with the alignment result and reported on the run) but is NOT a veto:
// a single provider timestamp outlier in ~8,000 words previously aborted an
// entire paid dual-model run and blocked a fully usable transcript.
// Engines that predate the distribution metrics fall back to the strict
// max-based rule, so this can never silently weaken an older deployment.
export const ALIGNMENT_QUALITY_POLICY_VERSION = 2;
const MIN_MEAN_CONFIDENCE = 0.5;
const MAX_SYSTEMIC_SHIFT_MS = 30_000;
const MAX_OUTLIER_RATIO = 0.005;

export function assertAlignmentQuality(label: string, result: AlignmentResult) {
  if (!result.verified) throw new Error(`${label} forced alignment was not verified`);
  const meanConfidence = Number(result.mean_confidence || 0);
  if (meanConfidence < MIN_MEAN_CONFIDENCE) {
    throw new Error(`${label} forced alignment confidence ${meanConfidence.toFixed(3)} is below ${MIN_MEAN_CONFIDENCE}`);
  }
  const hasDistribution = Number.isFinite(Number(result.p99_provider_shift_ms)) && Number.isFinite(Number(result.outlier_ratio));
  if (!hasDistribution) {
    const maxShift = Number(result.max_provider_shift_ms || 0);
    if (maxShift > MAX_SYSTEMIC_SHIFT_MS) {
      throw new Error(`${label} forced alignment shift ${Math.round(maxShift)}ms exceeds ${MAX_SYSTEMIC_SHIFT_MS}ms (alignment engine predates distribution metrics)`);
    }
    return;
  }
  const p99 = Number(result.p99_provider_shift_ms);
  const outlierRatio = Number(result.outlier_ratio);
  if (p99 > MAX_SYSTEMIC_SHIFT_MS) {
    throw new Error(`${label} forced alignment is systemically misaligned: p99 shift ${Math.round(p99)}ms exceeds ${MAX_SYSTEMIC_SHIFT_MS}ms`);
  }
  if (outlierRatio > MAX_OUTLIER_RATIO) {
    throw new Error(`${label} forced alignment disagreement is widespread: ${Number(result.outlier_word_count || 0)} of ${result.word_count} words (${(outlierRatio * 100).toFixed(2)}%) exceed ${Number(result.outlier_tolerance_ms || MAX_SYSTEMIC_SHIFT_MS)}ms, above the ${(MAX_OUTLIER_RATIO * 100).toFixed(2)}% limit`);
  }
}

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
