// =============================================================================
// backup-snapshot.ts — BullMQ worker processor for weekly DB-wide backup.
// -----------------------------------------------------------------------------
// AUDITOR FRAMING (SOC 2 CC7.4 / A.12.3 — backup integrity & retention):
//   Replaces backupAllEntitiesToS3 (synchronous) which paginates ~30 entities
//   in-band and will breach Base44's 3-min function ceiling once total row
//   count exceeds ~75k (projected within 6-12 months at current growth rate).
//
//   The worker runs OUTSIDE the function timeout, has its own SDK quota
//   separate from user editor traffic, and 1-concurrency-locked so only one
//   backup runs at a time. Same audit-grade pattern as project-cascade.
//
// Pipeline:
//   1. For each entity name in payload.entity_names, paginate .list() in 2000-row
//      chunks. Per-entity failures are recorded but don't abort the run — we
//      always produce a snapshot, partial or not. (Mirrors the legacy posture.)
//   2. Build the single full-backup.json + manifest.json bytes.
//   3. Upload both to S3 under dubflow/backups/<date_stamp>/.
//   4. List + prune backup folders, keeping the newest KEEP_LAST_N.
//   5. POST backupSnapshotWorkerStep to finalize (StructuredLog + ActivityLog).
//
// Retry posture: 2 attempts with 60s exponential backoff (BACKUP_JOB_OPTIONS).
// Backups are idempotent on date_stamp (same day → same S3 path → same bytes
// give-or-take a few seconds of fresh entity rows), so retry is safe.
// =============================================================================

import { Job } from 'bullmq';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { createClient } from '../base44-client';
import { env } from '../env';
import type { BackupSnapshotJobData } from '../../shared/queue-contracts';

const PREFIX = 'dubflow/backups';
const PAGE_SIZE = 2000;

function buildS3(region: string): S3Client {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('Missing AWS credentials for backup');
  return new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
}

async function paginatedList(
  base44: ReturnType<typeof createClient>,
  entityName: string,
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (true) {
    const page = await base44.asServiceRole.entities[entityName].list(null, PAGE_SIZE, offset) as Array<Record<string, unknown>>;
    if (!page || page.length === 0) break;
    all.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

async function pruneOldBackups(s3: S3Client, bucket: string, keepLastN: number): Promise<{ pruned: number; files_deleted: number }> {
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${PREFIX}/`, Delimiter: '/' }));
  const dateFolders = (listed.CommonPrefixes || [])
    .map(p => p.Prefix)
    .filter((p): p is string => !!p)
    .sort(); // ISO date prefixes sort chronologically
  if (dateFolders.length <= keepLastN) return { pruned: 0, files_deleted: 0 };
  const toDelete = dateFolders.slice(0, dateFolders.length - keepLastN);
  let totalDeleted = 0;
  for (const folder of toDelete) {
    const contents = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: folder }));
    const keys = (contents.Contents || []).map(o => ({ Key: o.Key! }));
    if (keys.length === 0) continue;
    await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
    totalDeleted += keys.length;
  }
  return { pruned: toDelete.length, files_deleted: totalDeleted };
}

export async function processBackupSnapshot(job: Job<BackupSnapshotJobData>): Promise<void> {
  const { date_stamp, s3_bucket, s3_region, entity_names, keep_last_n, request_id, auth_token } = job.data;
  const t0 = Date.now();
  const generatedAt = new Date();

  console.log(`[backup-snapshot] start date_stamp=${date_stamp} entities=${entity_names.length}`);

  const base44 = createClient(auth_token);
  const s3 = buildS3(s3_region);
  const folderKey = `${PREFIX}/${date_stamp}`;
  const fullKey = `${folderKey}/full-backup.json`;
  const manifestKey = `${folderKey}/manifest.json`;

  const entities: Record<string, Array<Record<string, unknown>>> = {};
  const counts: Record<string, number> = {};
  const errors: Record<string, string> = {};

  // Heartbeat — extend BullMQ job lock during the long paginate loop.
  const heartbeat = setInterval(() => { job.updateProgress({ phase: 'paginating', t: Date.now() - t0 }).catch(() => {}); }, 10000);

  try {
    // Paginate each entity in sequence (parallelism would hit SDK rate limits).
    for (let i = 0; i < entity_names.length; i++) {
      const name = entity_names[i];
      try {
        const rows = await paginatedList(base44, name);
        entities[name] = rows;
        counts[name] = rows.length;
      } catch (e) {
        const msg = (e as Error).message;
        // Don't abort the whole backup — record error, keep going.
        console.warn(`[backup-snapshot] ${name} failed: ${msg}`);
        entities[name] = [];
        counts[name] = 0;
        errors[name] = msg;
      }
      // Coarse progress update per entity finished.
      await job.updateProgress({ phase: 'paginating', done: i + 1, total: entity_names.length }).catch(() => {});
    }

    const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);
    const payload = {
      backup_version: 1,
      generated_at: generatedAt.toISOString(),
      app_id: process.env.BASE44_APP_ID || null,
      entity_counts: counts,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
      entities,
    };
    const json = JSON.stringify(payload);
    const sizeBytes = new TextEncoder().encode(json).length;

    await job.updateProgress({ phase: 'uploading' }).catch(() => {});
    await s3.send(new PutObjectCommand({
      Bucket: s3_bucket,
      Key: fullKey,
      Body: json,
      ContentType: 'application/json',
    }));

    const manifest = {
      backup_version: 1,
      generated_at: generatedAt.toISOString(),
      date: date_stamp,
      full_backup_key: fullKey,
      size_bytes: sizeBytes,
      total_records: totalRecords,
      entity_counts: counts,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
      duration_ms: Date.now() - t0,
    };
    await s3.send(new PutObjectCommand({
      Bucket: s3_bucket,
      Key: manifestKey,
      Body: JSON.stringify(manifest),
      ContentType: 'application/json',
    }));

    // Prune older folders (best-effort).
    let pruneResult: { pruned: number; files_deleted: number } | null = null;
    try {
      pruneResult = await pruneOldBackups(s3, s3_bucket, keep_last_n);
    } catch (e) {
      console.warn(`[backup-snapshot] prune failed:`, (e as Error).message);
    }

    const durationMs = Date.now() - t0;
    console.log(`[backup-snapshot] OK — ${totalRecords} records, ${(sizeBytes / 1024 / 1024).toFixed(2)} MB, ${durationMs}ms`);

    // Call finalizer.
    const finalizerUrl = env.BASE44_FUNCTION_URL?.replace(/\/$/, '') || '';
    if (finalizerUrl) {
      try {
        const res = await fetch(`${finalizerUrl}/backupSnapshotWorkerStep`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Worker-JWT': auth_token,
            'X-App-Id': env.BASE44_APP_ID,
          },
          body: JSON.stringify({
            success: true,
            date_stamp,
            request_id,
            s3_bucket,
            full_backup_key: fullKey,
            manifest_key: manifestKey,
            size_bytes: sizeBytes,
            total_records: totalRecords,
            entity_counts: counts,
            errors: Object.keys(errors).length > 0 ? errors : null,
            prune_result: pruneResult,
            duration_ms: durationMs,
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.warn(`[backup-snapshot] finalizer returned ${res.status}: ${body.slice(0, 200)}`);
        }
      } catch (e) {
        console.warn(`[backup-snapshot] finalizer call failed:`, (e as Error).message);
      }
    }
  } catch (err) {
    clearInterval(heartbeat);
    // Best-effort failure notice.
    const finalizerUrl = env.BASE44_FUNCTION_URL?.replace(/\/$/, '') || '';
    if (finalizerUrl) {
      try {
        await fetch(`${finalizerUrl}/backupSnapshotWorkerStep`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Worker-JWT': auth_token,
            'X-App-Id': env.BASE44_APP_ID,
          },
          body: JSON.stringify({
            success: false,
            date_stamp,
            request_id,
            error_message: (err as Error).message,
            duration_ms: Date.now() - t0,
          }),
        });
      } catch (_e) { /* nothing to do */ }
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}
