// =============================================================================
// canonical-language (worker mirror) — provider-dialect → canonical language,
// and the fail-closed gate at the forced-alignment boundary.
// -----------------------------------------------------------------------------
// LOGIC-FOR-LOGIC MIRROR of base44/shared/canonical-language.ts. The worker is a
// separate deployable and cannot import base44/shared, so the rule is duplicated
// deliberately and the two copies are drift-guarded by
// src/lib/__tests__/canonical-language-parity.test.js.
//
// WHY THE WORKER NEEDS ITS OWN COPY AT ALL (incident 2026-08-25). The refinement
// processor forwarded Project.source_language to the alignment engine verbatim:
// `languageCode: String(prep.project.source_language || 'en')`. On project
// 6a8d904d15662678be3befd7 that value was Scribe's ISO-639-3 'eng', the engine's
// allowlist is ISO-639-1, and three runs died on
// `422 ... not commercially supported for language: eng` — for English. Fixing
// only the write path would leave the worker trusting a field it cannot verify;
// this module makes the boundary itself fail closed, with a named reason, before
// any paid alignment call.
// =============================================================================

export const PROVIDER_DIALECT_TO_CANONICAL: Record<string, string> = {
  nor: 'nb', nno: 'nn', swe: 'sv', dan: 'da', fin: 'fi', isl: 'is', ice: 'is',
  eng: 'en', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', ita: 'it',
  nld: 'nl', dut: 'nl', spa: 'es', por: 'pt', cat: 'ca', glg: 'gl',
  eus: 'eu', baq: 'eu',
  pol: 'pl', ces: 'cs', cze: 'cs', slk: 'sk', slo: 'sk', slv: 'sl',
  hrv: 'hr', srp: 'sr', bul: 'bg', ukr: 'uk', rus: 'ru', bel: 'be',
  mkd: 'mk', mac: 'mk', bos: 'bs',
  est: 'et', lav: 'lv', lit: 'lt',
  ron: 'ro', rum: 'ro', hun: 'hu', ell: 'el', gre: 'el', sqi: 'sq', alb: 'sq',
  ara: 'ar', heb: 'he', fas: 'fa', per: 'fa', tur: 'tr',
  amh: 'am', swa: 'sw', afr: 'af', som: 'so',
  hin: 'hi', ben: 'bn', urd: 'ur', pan: 'pa', tam: 'ta', tel: 'te',
  mar: 'mr', guj: 'gu', kan: 'kn', mal: 'ml', sin: 'si', nep: 'ne',
  jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh',
  vie: 'vi', tha: 'th', ind: 'id', msa: 'ms', may: 'ms', tgl: 'fil',
  khm: 'km', lao: 'lo', mya: 'my', bur: 'my',
  kat: 'ka', geo: 'ka', hye: 'hy', arm: 'hy', aze: 'az',
  kaz: 'kk', kir: 'ky', uzb: 'uz', tgk: 'tg',
  cym: 'cy', wel: 'cy', gle: 'ga', mlt: 'mt',
};

const CANONICAL_CODES = new Set<string>([
  'en', 'en-us', 'en-gb', 'en-au', 'en-ca', 'en-in', 'es', 'es-419', 'de', 'fr', 'fr-ca', 'it', 'pt', 'pt-br',
  'ja', 'ko', 'zh', 'zh-tw', 'ar', 'ru', 'nl', 'pl', 'tr', 'sv', 'da', 'fi', 'nb',
  'nn', 'hi', 'ta', 'bn', 'mr', 'te', 'gu', 'kn', 'ml', 'pa', 'ur', 'id', 'vi',
  'th', 'uk', 'cs', 'ro', 'hu', 'el', 'bg', 'ms', 'fil', 'is', 'ca', 'gl', 'eu',
  'sk', 'sl', 'hr', 'sr', 'be', 'mk', 'bs', 'et', 'lv', 'lt', 'sq', 'he', 'fa',
  'am', 'sw', 'af', 'so', 'si', 'ne', 'km', 'lo', 'my', 'ka', 'hy', 'az', 'kk',
  'ky', 'uz', 'tg', 'cy', 'ga', 'mt',
]);

/** Mirrors SUPPORTED_LANGUAGES in forced-alignment-engine/app.py EXACTLY. */
export const ALIGNMENT_SUPPORTED_LANGUAGES = new Set<string>([
  'en', 'ja', 'zh', 'de', 'hi', 'fr', 'ko', 'pt', 'it', 'es', 'id', 'nl', 'tr',
  'fil', 'pl', 'sv', 'bg', 'ro', 'ar', 'cs', 'el', 'fi', 'hr', 'ms', 'sk', 'da',
  'ta', 'uk', 'ru',
]);

export function toCanonicalLanguage(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const key = String(raw).trim().toLowerCase().replace(/_/g, '-');
  if (!key) return null;
  if (key === 'auto') return 'auto';
  if (CANONICAL_CODES.has(key)) return key;
  if (PROVIDER_DIALECT_TO_CANONICAL[key]) return PROVIDER_DIALECT_TO_CANONICAL[key];
  const root = key.split('-')[0];
  if (CANONICAL_CODES.has(root)) return root;
  if (PROVIDER_DIALECT_TO_CANONICAL[root]) return PROVIDER_DIALECT_TO_CANONICAL[root];
  return null;
}

export type AlignmentLanguageResolution =
  | { ok: true; code: string; normalized_from: string | null }
  | { ok: false; code: 'alignment_language_unresolvable' | 'alignment_language_unsupported'; language_base: string | null; message: string };

/**
 * FAIL-CLOSED resolution for the alignment boundary. A raw code is NEVER
 * forwarded: either it resolves to a supported canonical base, or the caller
 * fails the run with one of two named, actionable reasons.
 */
export function resolveAlignmentLanguage(raw: unknown): AlignmentLanguageResolution {
  const original = raw === null || raw === undefined ? '' : String(raw).trim();
  const canonical = toCanonicalLanguage(raw);
  if (!canonical || canonical === 'auto') {
    return {
      ok: false,
      code: 'alignment_language_unresolvable',
      language_base: null,
      message: `Source language "${original || 'unset'}" could not be resolved to a known language, so acoustic verification was not attempted. Confirm the project's source language and run refinement again.`,
    };
  }
  const base = canonical.split('-')[0];
  if (!ALIGNMENT_SUPPORTED_LANGUAGES.has(base)) {
    return {
      ok: false,
      code: 'alignment_language_unsupported',
      language_base: base,
      message: `Acoustic verification is not available for ${base} (resolved from "${original}"). Speaker refinement requires a language supported by the commercial forced-alignment engine.`,
    };
  }
  return { ok: true, code: base, normalized_from: base === original.toLowerCase() ? null : original };
}
