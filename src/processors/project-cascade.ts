// =============================================================================
// project-cascade.ts — BullMQ worker processor for project cascade delete.
// -----------------------------------------------------------------------------
// AUDITOR FRAMING (SOC 2 CC6.7 / CC7.2 / CC8.1, TPN MS-1.x / MS-4.x):
//   This processor runs OUTSIDE the 3-min Base44 function timeout, enabling
//   reliable cascade deletion of projects with thousands of segments. The
//   worker has its own SDK quota separate from user-facing editor traffic,
//   eliminating the rate-limit saturation incident observed on 2026-05-14.
//
// Pipeline:
//   1. Delete S3 objects under dubflow/{project_id}/* + source/proxy keys
//   2. For each project-scoped entity, paginate + delete rows (batched)
//   3. Delete the Project row itself
//   4. Call projectCascadeWorkerStep to finalize (audit log, cleanup)
//
// Job payload (ProjectCascadePayload from queue-contracts.ts):
//   - project_id, project_name, user_email, request_id
//   - storage: { bucket, region, credential_secret_prefix, media_key, ... }
//   - auth_token (scoped JWT for finalizer callback)
//
// Retry posture: 2 attempts with 30s exponential backoff. Failures land in
// DLQ with 7-day retention for forensic review.
// =============================================================================

import { Job } from 'bullmq';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from '../base44-client';
import { env } from '../env';

// Every entity that holds rows scoped to a single project.
const PROJECT_SCOPED_ENTITIES = [
  'TranscriptSegment',
  'TranslationSegment',
  'Speaker',
  'JobRun',
  'CostLog',
  'VoiceAssignmentHistory',
  'ProjectCollaborator',
  'TranslationRun',
  'AIRewriteRun',
  'AdaptationSegment',
  'AdaptationComment',
  'AdaptationVersion',
  'AdaptationExport',
  'AdaptationRun',
  'AdaptationGlossaryTerm',
  'SuperscriptRecord',
  'SuperscriptAnnotation',
  'SuperscriptComment',
  'SuperscriptLink',
  'SuperscriptGlossaryTerm',
  'SuperscriptCharacter',
  'SuperscriptCanonFact',
  'SuperscriptSceneSynopsis',
  'SuperscriptExport',
  'SuperscriptEnrichmentRun',
  'SuperscriptScriptSpine',
  'SuperscriptSpineNode',
  'KNPHarvestRun',
  'KNPCandidate',
  'CaptionCue',
  'CCFormatRun',
];

interface ProjectCascadePayload {
  schema_version: number;
  project_id: string;
  project_name: string;
  user_email: string;
  request_id: string;
  storage: {
    bucket: string;
    region: string;
    credential_secret_prefix: string;
    media_key?: string;
    me_track_key?: string;
    proxy_video_key?: string;
    proxy_audio_key?: string;
  };
  auth_token: string;
}

function buildS3(storage: ProjectCascadePayload['storage']): S3Client {
  const prefix = storage.credential_secret_prefix || '';
  const accessKeyId = prefix
    ? process.env[`${prefix}_ACCESS_KEY_ID`]
    : process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = prefix
    ? process.env[`${prefix}_SECRET_ACCESS_KEY`]
    : process.env.AWS_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`Missing S3 credentials for prefix "${prefix}"`);
  }

  return new S3Client({
    region: storage.region,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function deleteS3Prefix(s3: S3Client, bucket: string, prefix: string): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;

  while (true) {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    const contents = list.Contents || [];
    if (contents.length > 0) {
      // Delete in batches of 1000 (S3 limit)
      for (let i = 0; i < contents.length; i += 1000) {
        const chunk = contents.slice(i, i + 1000);
        await s3.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: chunk.map(o => ({ Key: o.Key })) },
        }));
        deleted += chunk.length;
      }
    }

    if (!list.IsTruncated) break;
    continuationToken = list.NextContinuationToken;
  }

  return deleted;
}

async function deleteSingleKey(s3: S3Client, bucket: string, key: string | undefined): Promise<boolean> {
  if (!key) return false;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    console.warn(`[project-cascade] Failed to delete S3 key ${bucket}/${key}:`, (e as Error).message);
    return false;
  }
}

// Delete all rows for one entity, paginating + batching.
// Uses bounded concurrency to avoid SDK rate limits.
async function deleteEntityRows(
  base44: ReturnType<typeof createClient>,
  entityName: string,
  projectId: string,
  job: Job,
): Promise<{ deleted: number; failed: number; skipped: boolean }> {
  let deleted = 0;
  let failed = 0;
  const MAX_PAGES = 200; // 200 * 500 = 100k row safety cap

  for (let page = 0; page < MAX_PAGES; page++) {
    let rows: { id: string }[];
    try {
      rows = await base44.asServiceRole.entities[entityName].filter(
        { project_id: projectId },
        null,
        500,
        0,
      );
    } catch (e) {
      const msg = (e as Error)?.message || '';
      if (/not found|unknown entity|does not exist/i.test(msg)) {
        return { deleted, failed, skipped: true };
      }
      throw e;
    }

    if (!rows || rows.length === 0) break;

    // Delete in parallel batches of 20 to balance speed vs rate limit
    const BATCH_SIZE = 20;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(r => base44.asServiceRole.entities[entityName].delete(r.id))
      );

      for (const r of results) {
        if (r.status === 'fulfilled') deleted++;
        else failed++;
      }

      // Update job progress periodically
      if (i % 100 === 0) {
        await job.updateProgress({ entity: entityName, deleted, failed });
      }
    }

    if (rows.length < 500) break;
  }

  return { deleted, failed, skipped: false };
}

export async function processProjectCascade(job: Job<ProjectCascadePayload>): Promise<void> {
  const { project_id, project_name, user_email, request_id, storage, auth_token } = job.data;
  const startedAt = Date.now();

  console.log(`[project-cascade] Starting cascade for project ${project_id} (${project_name})`);

  const summary: Record<string, unknown> = {
    project_id,
    project_name,
    request_id,
    s3_deleted: 0,
    s3_errors: 0,
    entities: {} as Record<string, { deleted: number; failed: number; skipped: boolean }>,
  };

  // Build S3 client for the project's storage profile
  const s3 = buildS3(storage);
  const bucket = storage.bucket;

  // ─── 1. Delete S3 prefix ───
  try {
    summary.s3_deleted = await deleteS3Prefix(s3, bucket, `dubflow/${project_id}/`);
    console.log(`[project-cascade] Deleted ${summary.s3_deleted} S3 objects from prefix`);
  } catch (e) {
    (summary.s3_errors as number)++;
    console.error(`[project-cascade] S3 prefix delete failed:`, (e as Error).message);
  }

  // ─── 2. Delete standalone S3 keys (source, proxy, M&E) ───
  const standaloneKeys = [
    storage.media_key,
    storage.me_track_key,
    storage.proxy_video_key,
    storage.proxy_audio_key,
  ].filter(k => k && !k.startsWith(`dubflow/${project_id}/`));

  for (const key of standaloneKeys) {
    const ok = await deleteSingleKey(s3, bucket, key);
    if (ok) (summary.s3_deleted as number)++;
    else (summary.s3_errors as number)++;
  }

  // ─── 3. Delete all project-scoped entity rows ───
  const base44 = createClient(auth_token);

  for (const entityName of PROJECT_SCOPED_ENTITIES) {
    console.log(`[project-cascade] Deleting ${entityName} rows...`);
    const res = await deleteEntityRows(base44, entityName, project_id, job);
    (summary.entities as Record<string, unknown>)[entityName] = res;

    if (res.deleted > 0 || res.failed > 0) {
      console.log(`[project-cascade] ${entityName}: deleted=${res.deleted}, failed=${res.failed}`);
    }
  }

  // ─── 4. Delete the Project row itself ───
  let projectDeleted = false;
  try {
    await base44.asServiceRole.entities.Project.delete(project_id);
    projectDeleted = true;
    console.log(`[project-cascade] Project row deleted`);
  } catch (e) {
    console.error(`[project-cascade] Failed to delete Project row:`, (e as Error).message);
    summary.project_delete_error = (e as Error).message;
  }

  summary.project_deleted = projectDeleted;
  summary.duration_ms = Date.now() - startedAt;

  // ─── 5. Call finalizer to write audit log ───
  const finalizerUrl = env.BASE44_FUNCTION_URL?.replace(/\/$/, '') || '';
  if (finalizerUrl) {
    try {
      const res = await fetch(`${finalizerUrl}/projectCascadeWorkerStep`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${auth_token}`,
        },
        body: JSON.stringify({
          project_id,
          project_name,
          user_email,
          request_id,
          summary,
          success: projectDeleted && (summary.s3_errors as number) === 0,
        }),
      });

      if (!res.ok) {
        console.warn(`[project-cascade] Finalizer returned ${res.status}`);
      }
    } catch (e) {
      console.warn(`[project-cascade] Finalizer call failed:`, (e as Error).message);
    }
  }

  // Throw if the project row wasn't deleted — that's the critical path
  if (!projectDeleted) {
    throw new Error(`Cascade completed but Project row failed to delete: ${summary.project_delete_error}`);
  }

  console.log(`[project-cascade] Cascade complete in ${summary.duration_ms}ms`);
}
