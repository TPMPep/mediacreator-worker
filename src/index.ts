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
import { processBatchTranslate } from './processors/batch-translate.js';
import { processBatchEnrich } from './processors/batch-enrich.js';
import { processEnrichOrchestrator } from './processors/enrich-orchestrator.js';
import { processEnrichChunk } from './processors/enrich-chunk.js';
import { processTranslateOrchestrator } from './processors/translate-orchestrator.js';
import { processTranslateChunk } from './processors/translate-chunk.js';
import { processAdaptOrchestrator } from './processors/adapt-orchestrator.js';
import { processAdaptChunk } from './processors/adapt-chunk.js';
import { processSrtImport } from './processors/srt-import.js';
import { processHlsIngest } from './processors/hls-ingest.js';

initSentry();

const connection = getRedis();
const baseOpts: Pick<WorkerOptions, 'connection'> = { connection };

// ─── Spin up one Worker per queue ────────────────────────────────────
const workers: Worker[] = [
  new Worker(QUEUE_NAMES.VOICE_GEN, processVoiceGen, {
    ...baseOpts, concurrency: env.CONCURRENCY_VOICE_GEN,
  }),
  new Worker(QUEUE_NAMES.BATCH_TRANSLATE, processBatchTranslate, {
    ...baseOpts, concurrency: env.CONCURRENCY_TRANSLATE,
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
  new Worker(QUEUE_NAMES.SRT_IMPORT, processSrtImport, {
    ...baseOpts, concurrency: env.CONCURRENCY_SRT_IMPORT,
  }),
  // v2 HLS-to-MP4 ingest pipeline. Single-shot per job; processor walks the
  // phase machine on the Base44 side via hlsIngestWorkerStep.
  new Worker(QUEUE_NAMES.HLS_INGEST, processHlsIngest, {
    ...baseOpts, concurrency: env.CONCURRENCY_HLS_INGEST,
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
const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      queues: workers.map(w => ({ name: w.name, concurrency: w.opts.concurrency, running: !w.closing })),
    }));
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
    context: { signal },
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
