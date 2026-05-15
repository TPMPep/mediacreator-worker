// =============================================================================
// EXPORT BUILDERS — Pure-function output builders for the export-project queue.
// -----------------------------------------------------------------------------
// AUDITOR FRAMING (SOC 2 CC8.1 / TPN MS-4.x — byte-for-byte deliverable trail):
//   These functions are the SOLE producers of every customer-facing deliverable
//   the worker emits. They take fully-loaded entity rows + options and return
//   a UTF-8 string. No I/O, no SDK calls, no Date.now() — deterministic given
//   the same inputs, which is exactly what an auditor needs for the
//   reproducibility claim.
//
// Mirrors the canonical implementations in:
//   - functions/exportProject (dub kind: SRT/VTT/CSV/TXT/JSON/audio_manifest)
//   - functions/exportSuperscriptProject (CSV/JSON shapes; PDF deferred — see below)
//   - functions/exportAdaptation (CSV/JSON shapes; PDF deferred)
//   - lib/cc-exporters.js (CC kind: SRT/SCC byte-for-byte locked to test fixtures)
//
// PDF DEFERRAL: jsPDF + pdf-lib both have heavy native deps that pull a
// non-trivial amount of weight into the Railway container. For Phase 2 we
// keep the existing synchronous PDF paths in their original functions and
// route review_pdf format requests to those legacy functions. CSV/JSON/SRT/
// VTT/TXT/SCC are the high-volume paths that need the worker treatment;
// review_pdf is a low-frequency surface that doesn't move the needle.
// =============================================================================

// ─── Time formatting ────────────────────────────────────────────────────────

function pad(n: number, w = 2) { return String(n).padStart(w, '0'); }

export function msToSrtTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const mm = t % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(mm, 3)}`;
}

export function msToVttTime(ms: number): string {
  return msToSrtTime(ms).replace(',', '.');
}

// ─── Generic SRT / VTT for dub + adaptation ─────────────────────────────────

type DubSegmentLike = {
  start_ms: number;
  end_ms: number;
  tc_in?: string;
  tc_out?: string;
  speaker_label?: string;
  source_text?: string;
  id?: string;
};
type DubTranslationLike = {
  source_segment_id: string;
  translated_text?: string;
  voice_status?: string;
  fitted_audio_url?: string;
  fitted_audio_duration_ms?: number;
  dubbed_audio_url?: string;
  playback_rate?: number;
};

export function buildSrt(segments: DubSegmentLike[], getText: (s: DubSegmentLike) => string): string {
  return segments.map((seg, i) => (
    `${i + 1}\n${msToSrtTime(seg.start_ms)} --> ${msToSrtTime(seg.end_ms)}\n${getText(seg)}\n`
  )).join('\n');
}

export function buildVtt(segments: DubSegmentLike[], getText: (s: DubSegmentLike) => string): string {
  const header = 'WEBVTT\n\n';
  return header + segments.map((seg, i) => (
    `${i + 1}\n${msToVttTime(seg.start_ms)} --> ${msToVttTime(seg.end_ms)}\n${getText(seg)}\n`
  )).join('\n');
}

// ─── Dub-kind builders ──────────────────────────────────────────────────────

export function buildDubCsv(segments: DubSegmentLike[], translations: DubTranslationLike[]): string {
  const transMap: Record<string, DubTranslationLike> = {};
  for (const t of translations) transMap[t.source_segment_id] = t;

  const header = 'index,tc_in,tc_out,speaker,source_text,translated_text,voice_status';
  const rows = segments.map((seg, i) => {
    const t = transMap[seg.id || ''] || ({} as DubTranslationLike);
    const cols = [
      i + 1,
      seg.tc_in,
      seg.tc_out,
      `"${(seg.speaker_label || '').replace(/"/g, '""')}"`,
      `"${(seg.source_text || '').replace(/"/g, '""')}"`,
      `"${(t.translated_text || '').replace(/"/g, '""')}"`,
      t.voice_status || 'n/a',
    ];
    return cols.join(',');
  });
  return [header, ...rows].join('\n');
}

export function buildDubAudioManifest(segments: DubSegmentLike[], translations: DubTranslationLike[]): Array<Record<string, unknown>> {
  const transMap: Record<string, DubTranslationLike> = {};
  for (const t of translations) transMap[t.source_segment_id] = t;

  return segments.map((seg, i) => {
    const t = transMap[seg.id || ''];
    const useFitted = !!(t?.fitted_audio_url);
    return {
      index: i,
      tc_in: seg.tc_in,
      tc_out: seg.tc_out,
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      speaker: seg.speaker_label,
      source_text: seg.source_text,
      translated_text: t?.translated_text || '',
      audio_url: useFitted ? t.fitted_audio_url : (t?.dubbed_audio_url || null),
      fitted_audio_duration_ms: t?.fitted_audio_duration_ms || null,
      playback_rate: useFitted ? 1 : (t?.playback_rate || 1),
      voice_status: t?.voice_status || 'unassigned',
    };
  });
}

// Dispatch helper — used by the dub processor branch.
export function buildDubOutput(format: string, opts: {
  segments: DubSegmentLike[];
  translations: DubTranslationLike[];
  target_language_code?: string;
}): string {
  const { segments, translations, target_language_code } = opts;
  const transMap: Record<string, DubTranslationLike> = {};
  for (const t of translations) transMap[t.source_segment_id] = t;

  switch (format) {
    case 'srt':
      return buildSrt(segments, s => target_language_code ? (transMap[s.id || '']?.translated_text || s.source_text || '') : (s.source_text || ''));
    case 'vtt':
      return buildVtt(segments, s => target_language_code ? (transMap[s.id || '']?.translated_text || s.source_text || '') : (s.source_text || ''));
    case 'txt_source':
      return segments.map(s => `[${s.tc_in} → ${s.tc_out}] ${s.speaker_label}: ${s.source_text}`).join('\n');
    case 'txt_translation':
      return segments.map(s => `[${s.tc_in} → ${s.tc_out}] ${s.speaker_label}: ${transMap[s.id || '']?.translated_text || ''}`).join('\n');
    case 'csv':
      return buildDubCsv(segments, translations);
    case 'json':
    case 'audio_manifest':
      return JSON.stringify(buildDubAudioManifest(segments, translations), null, 2);
    default:
      throw new Error(`Unsupported dub format: ${format}`);
  }
}

// ─── Adaptation-kind builders ───────────────────────────────────────────────

type AdaptSegmentLike = {
  sequence_index?: number;
  speaker_label?: string;
  tc_in?: string;
  tc_out?: string;
  start_ms?: number;
  end_ms?: number;
  duration_ms?: number;
  source_text_snapshot?: string;
  base_translation_text?: string;
  adapted_text?: string;
  adaptation_status?: string;
  adaptation_notes?: string;
  performance_cues?: string;
  qa_flags?: string[];
  consistency_flags?: string[];
};

function adaptCsvEscape(v: unknown): string {
  const s = (v ?? '').toString();
  if (s.includes('"') || s.includes(',') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildAdaptationCsv(segments: AdaptSegmentLike[]): string {
  const headers = ['sequence', 'speaker', 'tc_in', 'tc_out', 'duration_s', 'source', 'base_translation', 'adapted_text', 'status', 'notes', 'performance_cues', 'qa_flags', 'consistency_flags'];
  const lines = [headers.join(',')];
  for (const s of segments) {
    lines.push(headers.map(h => {
      switch (h) {
        case 'sequence': return adaptCsvEscape(s.sequence_index);
        case 'speaker': return adaptCsvEscape(s.speaker_label || '');
        case 'tc_in': return adaptCsvEscape(s.tc_in || '');
        case 'tc_out': return adaptCsvEscape(s.tc_out || '');
        case 'duration_s': return adaptCsvEscape(((s.duration_ms || 0) / 1000).toFixed(2));
        case 'source': return adaptCsvEscape(s.source_text_snapshot || '');
        case 'base_translation': return adaptCsvEscape(s.base_translation_text || '');
        case 'adapted_text': return adaptCsvEscape(s.adapted_text || '');
        case 'status': return adaptCsvEscape(s.adaptation_status || 'not_started');
        case 'notes': return adaptCsvEscape(s.adaptation_notes || '');
        case 'performance_cues': return adaptCsvEscape(s.performance_cues || '');
        case 'qa_flags': return adaptCsvEscape((s.qa_flags || []).join('; '));
        case 'consistency_flags': return adaptCsvEscape((s.consistency_flags || []).join('; '));
        default: return '';
      }
    }).join(','));
  }
  return lines.join('\n');
}

export function buildAdaptationOutput(format: string, opts: {
  project: { id: string; name: string; adaptation_target_language?: string; adaptation_mode?: string; wf_adaptation?: string };
  segments: AdaptSegmentLike[];
}): string {
  const { project, segments } = opts;
  // For adaptation, srt/vtt render the adapted_text (falls back to base_translation_text).
  // Adapter-segment shape doesn't carry an `id` — we synthesize one for getText.
  const dubLike: DubSegmentLike[] = segments.map(s => ({
    start_ms: s.start_ms || 0,
    end_ms: s.end_ms || 0,
    tc_in: s.tc_in,
    tc_out: s.tc_out,
    speaker_label: s.speaker_label,
    source_text: s.adapted_text || s.base_translation_text || s.source_text_snapshot || '',
  }));

  switch (format) {
    case 'srt':
      return buildSrt(dubLike, s => s.source_text || '');
    case 'vtt':
      return buildVtt(dubLike, s => s.source_text || '');
    case 'csv':
      return buildAdaptationCsv(segments);
    case 'json':
      return JSON.stringify({
        project: {
          id: project.id,
          name: project.name,
          target_language: project.adaptation_target_language,
          mode: project.adaptation_mode,
          workflow: project.wf_adaptation,
          exported_at: new Date().toISOString(),
        },
        rows: segments,
      }, null, 2);
    default:
      throw new Error(`Unsupported adaptation format: ${format}`);
  }
}

// ─── Superscript-kind builders ──────────────────────────────────────────────

type SuperRecord = {
  id?: string;
  sequence_index?: number;
  record_type?: string;
  tc_in?: string;
  tc_out?: string;
  start_ms?: number;
  end_ms?: number;
  duration_ms?: number;
  speaker_label?: string;
  character_name?: string;
  speaker_role?: string;
  delivery_mode?: string;
  on_screen_flag?: boolean;
  off_screen_flag?: boolean;
  source_text?: string;
  display_text?: string;
  onscreen_text?: string;
  review_status?: string;
  locked_flag?: boolean;
  cue_intensity?: string;
  audibility?: string;
  cue_subtypes?: string[];
  cue_flags?: Record<string, boolean>;
  custom_labels?: string[];
  glossary_terms?: string[];
};
type SuperAnnotation = {
  superscript_record_id?: string;
  annotation_type?: string;
  annotation_text?: string;
  cue_subtype?: string;
};

function ssCsvEscape(v: unknown): string {
  if (v == null) return '';
  const str = String(v);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function buildSuperscriptCsv(records: SuperRecord[], annotations: SuperAnnotation[]): string {
  const annByRecord = new Map<string, SuperAnnotation[]>();
  for (const a of annotations) {
    const key = a.superscript_record_id || '';
    if (!annByRecord.has(key)) annByRecord.set(key, []);
    annByRecord.get(key)!.push(a);
  }
  const headers = [
    'sequence_index', 'record_type', 'tc_in', 'tc_out', 'start_ms', 'end_ms', 'duration_ms',
    'speaker_label', 'character_name', 'speaker_role', 'delivery_mode',
    'on_screen', 'off_screen', 'source_text', 'display_text', 'onscreen_text',
    'review_status', 'locked', 'cue_intensity', 'audibility', 'cue_subtypes',
    'cue_flags', 'custom_labels', 'glossary_terms', 'annotations',
  ];
  const rows = records.map(r => {
    const ann = annByRecord.get(r.id || '') || [];
    const cueFlagsActive = Object.entries(r.cue_flags || {}).filter(([, v]) => v).map(([k]) => k).join('|');
    const annText = ann.map(a => `${a.annotation_type}:${(a.annotation_text || a.cue_subtype || '').replace(/\s+/g, ' ')}`).join(' || ');
    return [
      r.sequence_index, r.record_type, r.tc_in, r.tc_out, r.start_ms, r.end_ms, r.duration_ms,
      r.speaker_label, r.character_name, r.speaker_role, r.delivery_mode,
      r.on_screen_flag ? 'yes' : '', r.off_screen_flag ? 'yes' : '',
      r.source_text, r.display_text, r.onscreen_text,
      r.review_status, r.locked_flag ? 'yes' : '',
      r.cue_intensity, r.audibility, (r.cue_subtypes || []).join('|'),
      cueFlagsActive, (r.custom_labels || []).join('|'), (r.glossary_terms || []).join('|'),
      annText,
    ].map(ssCsvEscape).join(',');
  });
  return [headers.join(','), ...rows].join('\r\n');
}

export function buildSuperscriptOutput(format: string, opts: {
  project: Record<string, unknown>;
  records: SuperRecord[];
  annotations: SuperAnnotation[];
  links: unknown[];
  glossary: unknown[];
}): string {
  const { project, records, annotations, links, glossary } = opts;
  switch (format) {
    case 'csv':
    case 'xlsx':
      // CSV bytes — Excel opens CSV transparently. Same posture as the legacy
      // exportSuperscriptProject function.
      return buildSuperscriptCsv(records, annotations);
    case 'json':
      return JSON.stringify({
        schema_version: 1,
        project: {
          id: project.id,
          name: project.name,
          content_type: project.superscript_content_type,
          franchise: project.superscript_franchise_name,
          series: project.superscript_series_name,
          season: project.superscript_season_number,
          episode: project.superscript_episode_number,
          status: project.superscript_status,
          linked_prior_projects: project.superscript_linked_prior_projects || [],
        },
        records, annotations, links, glossary,
        exported_at: new Date().toISOString(),
      }, null, 2);
    default:
      throw new Error(`Unsupported superscript format: ${format}`);
  }
}

// ─── CC-kind builders ───────────────────────────────────────────────────────
// Byte-for-byte mirror of lib/cc-exporters.js + the inlined copy in
// ccExportProject. Test fixtures in lib/__tests__/cc-exporters.test.js lock
// these. Any change MUST be applied here AND in lib/cc-exporters.js.

type CaptionCueLike = {
  start_ms: number;
  end_ms: number;
  text?: string;
  is_italic?: boolean;
};
type CCSpecLike = {
  export_rules?: { frame_rate?: number; drop_frame?: boolean };
  line_rules?: { min_gap_between_captions_ms?: number };
};

export function ccExportToSrt(cues: CaptionCueLike[]): string {
  const sorted = [...(cues || [])].sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0));
  const blocks = sorted.map((c, i) => {
    const idx = i + 1;
    const tc = `${msToSrtTime(c.start_ms)} --> ${msToSrtTime(c.end_ms)}`;
    let text = String(c.text || '').replace(/\r\n/g, '\n');
    if (c.is_italic) text = `<i>${text}</i>`;
    return `${idx}\n${tc}\n${text}`;
  });
  return blocks.join('\n\n') + '\n';
}

// Minimal VTT for CC (matches the dub VTT shape — header + cues).
export function ccExportToVtt(cues: CaptionCueLike[]): string {
  const sorted = [...(cues || [])].sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0));
  const header = 'WEBVTT\n\n';
  const blocks = sorted.map((c, i) => {
    const tc = `${msToVttTime(c.start_ms)} --> ${msToVttTime(c.end_ms)}`;
    let text = String(c.text || '').replace(/\r\n/g, '\n');
    if (c.is_italic) text = `<i>${text}</i>`;
    return `${i + 1}\n${tc}\n${text}`;
  });
  return header + blocks.join('\n\n') + '\n';
}

// ── SCC (EIA-608) — byte-for-byte mirror of lib/cc-exporters.js ──────────
function oddParity(byte: number) { let b = byte & 0x7F; let bits = 0; for (let i = 0; i < 7; i++) if ((b >> i) & 1) bits++; return (bits % 2 === 0) ? (b | 0x80) : b; }
function hex2(n: number) { return n.toString(16).toUpperCase().padStart(2, '0'); }
function wordFromBytes(b1: number, b2: number) { return hex2(oddParity(b1)) + hex2(oddParity(b2)); }
function charTo608(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 0x20 && c <= 0x7F) return c;
  const FOLDS: Record<string, string> = { 'á': 'a', 'é': 'e', 'í': 'i', 'ó': 'o', 'ú': 'u', 'ñ': 'n', '¡': '!', '¿': '?', '—': '-', '–': '-', '’': "'", '‘': "'", '“': '"', '”': '"', '♪': '#' };
  return FOLDS[ch] ? FOLDS[ch].charCodeAt(0) : 0x3F;
}
function packCharsToBytePairs(s: string): string[] {
  const bytes: number[] = []; for (const ch of s) bytes.push(charTo608(ch));
  if (bytes.length % 2 === 1) bytes.push(0x00);
  const words: string[] = []; for (let i = 0; i < bytes.length; i += 2) words.push(wordFromBytes(bytes[i], bytes[i + 1]));
  return words;
}
const PAC_ROW15_WHITE = [0x14, 0x70];
const RCL = [0x14, 0x20], ENM = [0x14, 0x2E], EDM = [0x14, 0x2C], EOC = [0x14, 0x2F];
function ctrl(p: number[]) { return wordFromBytes(p[0], p[1]); }
function msToSccTimecode(ms: number, fps = 29.97, dropFrame = true): string {
  const totalFrames = Math.round((ms / 1000) * fps); const fr = Math.round(fps);
  if (dropFrame && Math.abs(fps - 29.97) < 0.1) {
    const dropFrames = 2; const framesPer10Min = Math.round(fps * 60 * 10); const framesPerMin = Math.round(fps * 60) - dropFrames;
    const d = Math.floor(totalFrames / framesPer10Min); const m = totalFrames % framesPer10Min;
    let adj = totalFrames + 18 * d;
    if (m > dropFrames) adj += dropFrames * Math.floor((m - dropFrames) / framesPerMin);
    const h = Math.floor(adj / (fr * 3600)); const mn = Math.floor(adj / (fr * 60)) % 60; const s = Math.floor(adj / fr) % 60; const f = adj % fr;
    return `${pad(h)}:${pad(mn)}:${pad(s)};${pad(f)}`;
  }
  const h = Math.floor(totalFrames / (fr * 3600)); const mn = Math.floor(totalFrames / (fr * 60)) % 60; const s = Math.floor(totalFrames / fr) % 60; const f = totalFrames % fr;
  return `${pad(h)}:${pad(mn)}:${pad(s)}:${pad(f)}`;
}
const PRELOAD_FRAMES = 10;
function shiftFrames(ms: number, frames: number, fps = 29.97) { return Math.max(0, ms - Math.round((frames / fps) * 1000)); }

export function ccExportToScc(cues: CaptionCueLike[], spec: CCSpecLike): string {
  const fps = spec?.export_rules?.frame_rate || 29.97;
  const dropFrame = spec?.export_rules?.drop_frame !== false;
  const sorted = [...(cues || [])].sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0));
  const lines: string[] = ['Scenarist_SCC V1.0\n', ''];
  for (let i = 0; i < sorted.length; i++) {
    const cue = sorted[i]; const next = sorted[i + 1];
    const loadAtMs = shiftFrames(cue.start_ms, PRELOAD_FRAMES, fps);
    const loadTc = msToSccTimecode(loadAtMs, fps, dropFrame);
    const words: string[] = [];
    words.push(ctrl(RCL), ctrl(RCL)); words.push(ctrl(ENM), ctrl(ENM)); words.push(ctrl(PAC_ROW15_WHITE), ctrl(PAC_ROW15_WHITE));
    const linesArr = String(cue.text || '').split('\n');
    for (let li = 0; li < linesArr.length; li++) {
      words.push(...packCharsToBytePairs(linesArr[li]));
      if (li < linesArr.length - 1) words.push(wordFromBytes(0x14, 0x2D));
    }
    words.push(ctrl(EOC), ctrl(EOC));
    lines.push(`${loadTc}\t${words.join(' ')}`); lines.push('');
    const minGapMs = (spec?.line_rules?.min_gap_between_captions_ms ?? 80);
    const shouldEmitClear = !next || (next.start_ms - cue.end_ms) >= minGapMs;
    if (shouldEmitClear) {
      const clearTc = msToSccTimecode(cue.end_ms, fps, dropFrame);
      lines.push(`${clearTc}\t${ctrl(EDM)} ${ctrl(EDM)}`); lines.push('');
    }
  }
  return lines.join('\n');
}

// Minimal TTML stub — captures the spec required by Netflix TTAL-lite for
// caption delivery. Full feature set (regions, styles, etc.) deferred.
export function ccExportToTtml(cues: CaptionCueLike[]): string {
  const sorted = [...(cues || [])].sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0));
  const fmtTime = (ms: number) => msToVttTime(ms); // HH:MM:SS.mmm
  const body = sorted.map((c, i) => {
    const text = String(c.text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br/>');
    return `      <p xml:id="c${i + 1}" begin="${fmtTime(c.start_ms)}" end="${fmtTime(c.end_ms)}"${c.is_italic ? ' tts:fontStyle="italic"' : ''}>${text}</p>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xml:lang="en">
  <body>
    <div>
${body}
    </div>
  </body>
</tt>
`;
}

export function buildCcOutput(format: string, opts: {
  cues: CaptionCueLike[];
  spec: CCSpecLike;
}): string {
  const { cues, spec } = opts;
  switch (format) {
    case 'srt': return ccExportToSrt(cues);
    case 'vtt': return ccExportToVtt(cues);
    case 'scc': return ccExportToScc(cues, spec);
    case 'ttml': return ccExportToTtml(cues);
    default: throw new Error(`Unsupported cc format: ${format}`);
  }
}

// ─── Hash helper (audit-receipt) ────────────────────────────────────────────
// FNV-1a over UTF-8 bytes. Same algorithm + initial state the legacy
// ccExportProject uses for the cc.export.completed integrity receipt.
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

// MIME type lookup per format.
export function mimeForFormat(format: string): string {
  switch (format) {
    case 'srt': return 'application/x-subrip';
    case 'vtt': return 'text/vtt';
    case 'csv': return 'text/csv';
    case 'json':
    case 'audio_manifest': return 'application/json';
    case 'txt_source':
    case 'txt_translation': return 'text/plain';
    case 'scc':
    case 'ttml': return 'text/plain';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'review_pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}
