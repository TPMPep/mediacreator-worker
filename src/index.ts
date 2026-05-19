// =============================================================================
// MEDIACREATOR BULLMQ WORKER — Entry point.
// Boots one Worker per queue, wires shared error/log handlers, exposes a
// minimal /health endpoint for Railway healthchecks.
// =============================================================================

import { Worker, type WorkerOptions } from 'bullmq';
import http from 'node:http';
import { env } from './env.js';
import { getRedis, closeRedis } from './redis.js';
import { initSentry, captureError, flushSentry } from './sentry.js';
import { logEvent } from './base44-client.js';
import { QUEUE_NAMES } from '../shared/queue-contracts.js';

import { processVoiceGen } from './processors/voice-gen.js';
import { processVoiceGenOrchestrator } from './processors/voice-gen-orchestrator.js';
import { processBatchEnrich } from './processors/batch-enrich.js';
import { processEnrichOrchestrator } from './processors/enrich-orchestrator.js';
import { processEnrichChunk } from './processors/enrich-chunk.js';
import { processTranslateOrchestrator } from './processors/translate-orchestrator.js';
import { processTranslateChunk } from './processors/translate-chunk.js';
import { processAdaptOrchestrator } from './processors/adapt-orchestrator.js';
import { processAdaptChunk } from './processors/adapt-chunk.js';
import { processAIRewriteOrchestrator } from './processors/airewrite-orchestrator.js';
import { processAIRewriteChunk } from './processors/airewrite-chunk.js';
import { processSrtImport } from './processors/srt-import.js';
import { processHlsIngest } from './processors/hls-ingest.js';
import { processCCFormatRun } from './processors/cc-format-run.js';
import { processProxyGen } from './processors/proxy-gen.js';
import { processProjectCascade } from './processors/project-cascade.js';
import { processExportProject } from './processors/export-project.js';
import { processBackupSnapshot } from './processors/backup-snapshot.js';
import { processLoadTestFanout } from './processors/load-test-fanout.js';

initSentry();

// =============================================================================
// BUILD FINGERPRINT — Surfaces on /health and the worker_started StructuredLog
// row so we can prove which commit Railway is actually running, without
// grepping Railway logs. Railway injects RAILWAY_GIT_COMMIT_SHA /
// RAILWAY_GIT_BRANCH / RAILWAY_DEPLOYMENT_ID into the build environment
// automatically (no config required). If Railway is not the platform, the
// fields fall back to 'unknown' but BUILD_TAG still identifies the
// source-tree version.
//
// HOW TO USE:
//   1. Bump BUILD_TAG below every time you commit a non-trivial worker change.
//   2. After Railway deploys, hit GET /health and confirm build_tag matches
//      what you just committed. If it doesn't, Railway hasn't redeployed yet.
//   3. The same fingerprint is logged on worker startup via worker_started
//      so the Compliance dashboard can render a "currently deployed worker"
//      badge that updates within seconds of a redeploy.
// =============================================================================
const BUILD_INFO = {
  build_tag: '2026-05-19-worker-fingerprint',
  git_sha: process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
  git_branch: process.env.RAILWAY_GIT_BRANCH || 'unknown',
  deployment_id: process.env.RAILWAY_DEPLOYMENT_ID || 'unknown',
  started_at: new Date().toISOString(),
} as const;
console.log('[worker] BUILD_INFO', JSON.stringify(BUILD_INFO));

const connection = getRedis();
const baseOpts: Pick<WorkerOptions, 'connection'> = { connection };

// ─── Spin up one Worker per queue ────────────────────────────────────
const workers: Worker[] = [
  new Worker(QUEUE_NAMES.VOICE_GEN, processVoiceGen, {
    ...baseOpts, concurrency: env.CONCURRENCY_VOICE_GEN,
  }),
  new Worker(QUEUE_NAMES.VOICE_GEN_ORCHESTRATOR, processVoiceGenOrchestrator, {
    ...baseOpts, concurrency: env.CONCURRENCY_VOICE_GEN_ORCHESTRATOR,
  }),
  new Worker(QUEUE_NAMES.BATCH_ENRICH, processBatchEnrich, {
    ...baseOpts, concurrency: env.CONCURRENCY_ENRICH,
  }),
  new Worker(QUEUE_NAMES.ENRICH_ORCHESTRATOR, processEnrichOrchestrator, {
    ...baseOpts, concurrency: env.CONCURRENCY_ENRICH_ORCHESTRATOR,
  }),
  new Worker(QUEUE_NAMES.ENRICH_CHUNK, processEnrichChunk, {
    ...baseOpts, concurrency: env.CONCURRENCY_ENRICH_CHUNK,
  }),
  new Worker(QUEUE_NAMES.TRANSLATE_ORCHESTRATOR, processTranslateOrchestrator, {
    ...baseOpts, concurrency: env.CONCURRENCY_TRANSLATE_ORCHESTRATOR,
  }),
  new Worker(QUEUE_NAMES.TRANSLATE_CHUNK, processTranslateChunk, {
    ...baseOpts, concurrency: env.CONCURRENCY_TRANSLATE_CHUNK,
  }),
  new Worker(QUEUE_NAMES.ADAPT_ORCHESTRATOR, processAdaptOrchestrator, {
    ...baseOpts, concurrency: env.CONCURRENCY_ADAPT_ORCHESTRATOR,
  }),
  new Worker(QUEUE_NAMES.ADAPT_CHUNK, processAdaptChunk, {
    ...baseOpts, concurrency: env.CONCURRENCY_ADAPT_CHUNK,
  }),
  new Worker(QUEUE_NAMES.AIREWRITE_ORCHESTRATOR, processAIRewriteOrchestrator, {
    ...baseOpts, concurrency: env.CONCURRENCY_AIREWRITE_ORCHESTRATOR,
  }),
  new Worker(QUEUE_NAMES.AIREWRITE_CHUNK, processAIRewriteChunk, {
    ...baseOpts, concurrency: env.CONCURRENCY_AIREWRITE_CHUNK,
  }),
  new Worker(QUEUE_NAMES.SRT_IMPORT, processSrtImport, {
    ...baseOpts, concurrency: env.CONCURRENCY_SRT_IMPORT,
  }),
  new Worker(QUEUE_NAMES.HLS_INGEST, processHlsIngest, {
    ...baseOpts, concurrency: env.CONCURRENCY_HLS_INGEST,
  }),
  new Worker(QUEUE_NAMES.CC_FORMAT_RUN, processCCFormatRun, {
    ...baseOpts, concurrency: env.CONCURRENCY_CC_FORMAT_RUN,
  }),
  new Worker(QUEUE_NAMES.PROXY_GEN, processProxyGen, {
    ...baseOpts, concurrency: env.CONCURRENCY_PROXY_GEN,
  }),
  new Worker(QUEUE_NAMES.PROJECT_CASCADE, processProjectCascade, {
    ...baseOpts, concurrency: env.CONCURRENCY_PROJECT_CASCADE,
  }),
  new Worker(QUEUE_NAMES.EXPORT_PROJECT, processExportProject, {
    ...baseOpts, concurrency: env.CONCURRENCY_EXPORT_PROJECT,
  }),
  new Worker(QUEUE_NAMES.BACKUP_SNAPSHOT, processBackupSnapshot, {
    ...baseOpts, concurrency: env.CONCURRENCY_BACKUP_SNAPSHOT,
  }),
  new Worker(QUEUE_NAMES.LOAD_TEST_FANOUT, processLoadTestFanout, {
    ...baseOpts, concurrency: env.CONCURRENCY_LOAD_TEST_FANOUT,
  }),
];

for (const w of workers) {
  w.on('failed', (job, err) => {
    captureError(err, { queue: w.name, job_id: job?.id, attempts: job?.attemptsMade });
    console.error(`[${w.name}] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
  });
  w.on('completed', (job) => {
    console.log(`[${w.name}] job ${job.id} completed`);
  });
  w.on('error', (err) => {
    captureError(err, { queue: w.name });
    console.error(`[${w.name}] worker error:`, err.message);
  });
}

console.log(`worker started, listening on ${workers.length} queues:`,
  workers.map(w => `${w.name}(c=${w.opts.concurrency})`).join(', '));

void logEvent({
  function_name: 'bullmq:worker',
  event: 'worker_started',
  context: {
    queues: workers.map(w => ({ name: w.name, concurrency: w.opts.concurrency })),
    release: env.SENTRY_RELEASE || 'unknown',
    // Auditor-grade deployment provenance: every worker boot logs which
    // exact commit Railway is running. Lets the Compliance dashboard
    // render a "currently deployed worker" badge and lets load-test
    // reports pin which worker version produced each metric.
    build_info: BUILD_INFO,
  },
});

// ─── Lazy-init queue handles (only used by /enqueue endpoint) ────────
import { Queue } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from '../shared/queue-contracts.js';

const queueRegistry = new Map<string, Queue>();
function getQueue(name: string): Queue {
  let q = queueRegistry.get(name);
  if (!q) {
    q = new Queue(name, { connection });
    queueRegistry.set(name, q);
  }
  return q;
}

// ─── HTTP endpoints for Railway ──────────────────────────────────────
// /health        — Railway healthcheck + deployment fingerprint.
// /enqueue       — Producer-side endpoint. Base44 functions POST here.
// /queue-status  — Admin diagnostic: queue counts + recent job sample.
// /job-status    — Orchestrator harvest endpoint for chunk results.
const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      // Deployment fingerprint — first thing an operator checks when
      // something looks wrong. If build_tag here doesn't match what you
      // last committed, Railway hasn't redeployed yet (check the deploy
      // hook + Railway's deployments tab).
      build_info: BUILD_INFO,
      queues: workers.map(w => ({ name: w.name, concurrency: w.opts.concurrency, running: !w.closing })),
    }));
    return;
  }

  if (req.url === '/queue-status' && req.method === 'POST') {
    if (!env.ENQUEUE_SECRET || req.headers['x-enqueue-secret'] !== env.ENQUEUE_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed: { queue?: string; limit?: number };
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    const queue = parsed.queue;
    const limit = Math.min(Math.max(parsed.limit || 10, 1), 50);
    if (!queue || !Object.values(QUEUE_NAMES).includes(queue as never)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `valid queue required` }));
      return;
    }
    try {
      const q = getQueue(queue);
      const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused');
      const [waiting, active, failed, completed] = await Promise.all([
        q.getJobs(['waiting'], 0, limit - 1, false),
        q.getJobs(['active'], 0, limit - 1, false),
        q.getJobs(['failed'], 0, limit - 1, false),
        q.getJobs(['completed'], 0, limit - 1, false),
      ]);
      const shape = (j: { id?: string; name?: string; timestamp?: number; processedOn?: number; finishedOn?: number; attemptsMade?: number; failedReason?: string; data?: unknown }) => ({
        id: j.id,
        name: j.name,
        timestamp: j.timestamp,
        processedOn: j.processedOn,
        finishedOn: j.finishedOn,
        attempts_made: j.attemptsMade,
        failed_reason: (j.failedReason || '').slice(0, 500),
        project_id: (j.data as { project_id?: string } | undefined)?.project_id || null,
        request_id: (j.data as { request_id?: string } | undefined)?.request_id || null,
      });
      const workerRow = workers.find(w => w.name === queue);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        queue,
        worker_subscribed: !!workerRow,
        worker_running: workerRow ? !workerRow.closing : false,
        worker_concurrency: workerRow?.opts.concurrency ?? null,
        counts,
        recent: {
          waiting: waiting.map(shape),
          active: active.map(shape),
          failed: failed.map(shape),
          completed: completed.map(shape),
        },
      }));
    } catch (err) {
      const e = err as Error;
      captureError(e, { route: '/queue-status', queue });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/job-status' && req.method === 'POST') {
    if (!env.ENQUEUE_SECRET) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'job-status endpoint disabled (no secret configured)' }));
      return;
    }
    if (req.headers['x-enqueue-secret'] !== env.ENQUEUE_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed: { queue?: string; job_ids?: string[] };
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    const { queue, job_ids } = parsed;
    if (!queue || !Array.isArray(job_ids)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'queue + job_ids[] required' }));
      return;
    }
    if (!Object.values(QUEUE_NAMES).includes(queue as never)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `unknown queue: ${queue}` }));
      return;
    }
    const ids = job_ids.slice(0, 100);

    try {
      const q = getQueue(queue);
      const results: Record<string, { state: string; returnvalue?: unknown; failedReason?: string }> = {};
      await Promise.all(ids.map(async (id) => {
        try {
          const job = await q.getJob(id);
          if (!job) return;
          const state = await job.getState();
          results[id] = {
            state,
            returnvalue: state === 'completed' ? job.returnvalue : undefined,
            failedReason: state === 'failed' ? job.failedReason : undefined,
          };
        } catch (e) {
          const err = e as Error;
          console.warn(`[job-status] lookup ${id} failed: ${err.message}`);
        }
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results }));
    } catch (err) {
      const e = err as Error;
      captureError(e, { route: '/job-status', queue });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/enqueue' && req.method === 'POST') {
    if (!env.ENQUEUE_SECRET) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'enqueue endpoint disabled (no secret configured)' }));
      return;
    }
    if (req.headers['x-enqueue-secret'] !== env.ENQUEUE_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed: { queue?: string; payload?: unknown; opts?: Record<string, unknown> };
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    const { queue, payload, opts } = parsed;
    if (!queue || !payload) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'queue + payload required' }));
      return;
    }
    if (!Object.values(QUEUE_NAMES).includes(queue as never)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `unknown queue: ${queue}` }));
      return;
    }

    try {
      const q = getQueue(queue);
      const job = await q.add(queue, payload, { ...DEFAULT_JOB_OPTIONS, ...(opts || {}) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, job_id: job.id, queue }));
    } catch (err) {
      const e = err as Error;
      captureError(e, { route: '/enqueue', queue });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404); res.end();
});
server.listen(env.ENQUEUE_PORT, () => {
  console.log(`health endpoint listening on :${env.ENQUEUE_PORT}/health`);
});

// ─── Graceful shutdown ───────────────────────────────────────────────
async function shutdown(signal: string) {
  console.log(`[shutdown] received ${signal}, closing workers…`);
  await logEvent({
    function_name: 'bullmq:worker',
    event: 'worker_shutdown',
    context: { signal, build_info: BUILD_INFO },
  });
  await Promise.all(workers.map(w => w.close().catch(() => {})));
  await Promise.all([...queueRegistry.values()].map(q => q.close().catch(() => {})));
  server.close();
  await closeRedis();
  await flushSentry();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  captureError(reason, { source: 'unhandledRejection' });
  console.error('[unhandledRejection]', reason);
});
