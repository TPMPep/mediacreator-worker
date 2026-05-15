// =============================================================================
// export-project.ts — BullMQ worker processor for user-triggered exports.
// -----------------------------------------------------------------------------
// AUDITOR FRAMING (SOC 2 CC8.1 / TPN MS-4.x — deliverable chain of custody):
//   This processor runs OUTSIDE Base44's 3-min function timeout, so we can
//   paginate large entity trees (5000+ segment dub projects) without hitting
//   the ceiling under concurrent load. The legacy exportProject /
//   exportSuperscriptProject / exportAdaptation / ccExportProject functions
//   remain in place as fallbacks but new code should always go through this
//   pipeline via enqueueExportProject.
//
// Pipeline:
//   1. Load Project + all module-specific entity rows (paginated by 2000).
//   2. Dispatch by `kind` to the pure-function builders in shared/export-builders.
//   3. Upload the UTF-8 bytes to S3 at the producer-minted s3_key.
//   4. POST exportProjectWorkerStep to finalize ExportJob (sign URL, audit log).
//
// Retry posture: 2 attempts with 10s exponential backoff (EXPORT_JOB_OPTIONS).
// Exports are idempotent — same s3_key, same bytes — so a retry is safe.
// =============================================================================

import { Job } from 'bullmq';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '../base44-client';
import { env } from '../env';
import {
  buildDubOutput,
  buildSuperscriptOutput,
  buildAdaptationOutput,
  buildCcOutput,
  fnv1a,
  mimeForFormat,
} from '../../shared/export-builders';
import type { ExportJobData } from '../../shared/queue-contracts';

const PAGE_SIZE = 2000;

function buildS3(region: string, credentialSecretPrefix?: string): S3Client {
  const prefix = credentialSecretPrefix || '';
  const accessKeyId = prefix ? process.env[`${prefix}_ACCESS_KEY_ID`] : process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = prefix ? process.env[`${prefix}_SECRET_ACCESS_KEY`] : process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error(`Missing S3 credentials for prefix "${prefix}"`);
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

// Paginate any entity by project_id. Single-direction read; works for every
// entity used by export.
async function paginate<T>(
  base44: ReturnType<typeof createClient>,
  entityName: string,
  filter: Record<string, unknown>,
  sortField: string | null = null,
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  while (true) {
    const page = await base44.asServiceRole.entities[entityName].filter(filter, sortField, PAGE_SIZE, offset) as T[];
    if (!page || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

export async function processExportProject(job: Job<ExportJobData>): Promise<void> {
  const {
    kind, export_job_id, project_id, request_id, format, target_language_code,
    s3_bucket, s3_key, s3_region, credential_secret_prefix, suggested_filename,
    cc_options, auth_token,
  } = job.data;
  const startedAt = Date.now();

  console.log(`[export-project] start kind=${kind} format=${format} project=${project_id} export_job=${export_job_id}`);

  const base44 = createClient(auth_token);
  const s3 = buildS3(s3_region, credential_secret_prefix);

  // Heartbeat hook — exports of 5000+ line projects take ~30-60s, well under
  // the BullMQ default lock TTL (30s), but we extend it defensively in case
  // a future change makes the pagination slower.
  const heartbeat = setInterval(() => { job.updateProgress(Date.now() - startedAt).catch(() => {}); }, 10000);

  let content: string;
  const rowCounts: Record<string, number> = {};

  try {
    // ─── Mark ExportJob 'running' so the UI shows live progress ───
    try {
      await base44.asServiceRole.entities.ExportJob.update(export_job_id, {
        status: 'running',
      });
    } catch (_e) { /* non-fatal — the row still exists */ }

    // ─── Load Project (every kind needs it) ───
    const projects = await base44.asServiceRole.entities.Project.filter({ id: project_id }) as Array<Record<string, unknown>>;
    const project = projects[0];
    if (!project) throw new Error(`Project not found: ${project_id}`);

    // ─── Dispatch by kind ───
    if (kind === 'dub') {
      const segments = await paginate<Record<string, unknown>>(
        base44, 'TranscriptSegment', { project_id }, 'sequence_index'
      );
      rowCounts.transcript_segments = segments.length;

      let translations: Record<string, unknown>[] = [];
      if (target_language_code) {
        translations = await paginate<Record<string, unknown>>(
          base44, 'TranslationSegment', { project_id, target_language_code }, null
        );
        rowCounts.translation_segments = translations.length;
      }

      content = buildDubOutput(format, {
        segments: segments as never,
        translations: translations as never,
        target_language_code: target_language_code || undefined,
      });
    } else if (kind === 'superscript') {
      const [records, annotations, links, glossary] = await Promise.all([
        paginate<Record<string, unknown>>(base44, 'SuperscriptRecord', { project_id }, 'sequence_index'),
        paginate<Record<string, unknown>>(base44, 'SuperscriptAnnotation', { project_id }, null),
        paginate<Record<string, unknown>>(base44, 'SuperscriptLink', { source_project_id: project_id }, null).catch(() => []),
        paginate<Record<string, unknown>>(base44, 'SuperscriptGlossaryTerm', { project_id }, 'term').catch(() => []),
      ]);
      rowCounts.superscript_records = records.length;
      content = buildSuperscriptOutput(format, {
        project,
        records: records as never,
        annotations: annotations as never,
        links,
        glossary,
      });
    } else if (kind === 'adaptation') {
      const segments = await paginate<Record<string, unknown>>(
        base44, 'AdaptationSegment', { project_id }, 'sequence_index'
      );
      rowCounts.adaptation_segments = segments.length;
      content = buildAdaptationOutput(format, {
        project: project as never,
        segments: segments as never,
      });
    } else if (kind === 'cc') {
      if (!project.cc_spec_id) throw new Error('CC project has no pinned spec');
      const specs = await base44.asServiceRole.entities.ClosedCaptionSpec.filter({ id: project.cc_spec_id }) as Array<Record<string, unknown>>;
      const spec = specs[0];
      if (!spec) throw new Error('Pinned CC spec not found');

      // Spec format gate — refuse to export to a format the spec doesn't permit.
      const allowed = (spec.export_rules as { allowed_formats?: string[] } | undefined)?.allowed_formats || ['srt', 'vtt', 'scc', 'ttml'];
      if (!allowed.includes(format)) {
        throw new Error(`Spec '${spec.name}' does not permit ${format.toUpperCase()} exports. Allowed: ${allowed.join(', ')}`);
      }

      const cues = await paginate<Record<string, unknown>>(
        base44, 'CaptionCue', { project_id }, 'sequence_index'
      );
      if (cues.length === 0) throw new Error('No cues to export');
      rowCounts.caption_cues = cues.length;

      content = buildCcOutput(format, { cues: cues as never, spec: spec as never });
    } else {
      throw new Error(`Unknown export kind: ${kind}`);
    }

    // ─── Upload to S3 ───
    const bytes = new TextEncoder().encode(content);
    const mimeType = mimeForFormat(format);
    await s3.send(new PutObjectCommand({
      Bucket: s3_bucket,
      Key: s3_key,
      Body: bytes,
      ContentType: mimeType,
      ContentDisposition: `attachment; filename="${suggested_filename}"`,
    }));

    const byteHash = fnv1a(content);
    const durationMs = Date.now() - startedAt;

    console.log(`[export-project] uploaded ${bytes.length} bytes to ${s3_bucket}/${s3_key} (${durationMs}ms)`);

    // ─── Call finalizer ───
    const finalizerUrl = env.BASE44_FUNCTION_URL?.replace(/\/$/, '') || '';
    if (finalizerUrl) {
      try {
        const res = await fetch(`${finalizerUrl}/exportProjectWorkerStep`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Worker-JWT': auth_token,
            'X-App-Id': env.BASE44_APP_ID,
          },
          body: JSON.stringify({
            success: true,
            export_job_id,
            project_id,
            kind,
            format,
            target_language_code: target_language_code || null,
            request_id,
            s3_bucket,
            s3_key,
            file_size_bytes: bytes.length,
            mime_type: mimeType,
            suggested_filename,
            row_counts: rowCounts,
            byte_hash: byteHash,
            duration_ms: durationMs,
            cc_options: cc_options || null,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.warn(`[export-project] finalizer returned ${res.status}: ${body.slice(0, 200)}`);
        }
      } catch (e) {
        console.warn(`[export-project] finalizer call failed:`, (e as Error).message);
      }
    }
  } catch (err) {
    clearInterval(heartbeat);
    // Best-effort finalizer call with failure flag — so the ExportJob row
    // flips to 'failed' rather than rotting in 'running'. The auth_token is
    // still valid since we're well within the 30-min TTL.
    const finalizerUrl = env.BASE44_FUNCTION_URL?.replace(/\/$/, '') || '';
    if (finalizerUrl) {
      try {
        await fetch(`${finalizerUrl}/exportProjectWorkerStep`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Worker-JWT': auth_token,
            'X-App-Id': env.BASE44_APP_ID,
          },
          body: JSON.stringify({
            success: false,
            export_job_id,
            project_id,
            request_id,
            error_message: (err as Error).message,
            duration_ms: Date.now() - startedAt,
          }),
        });
      } catch (_e) { /* nothing to do */ }
    }
    throw err; // bubble up to BullMQ for retry/DLQ
  } finally {
    clearInterval(heartbeat);
  }
}
