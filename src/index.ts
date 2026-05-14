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
import { processBatchEnrich } from './processors/batch-enrich.js';
import { processEnrichOrchestrator } from './processors/enrich-orchestrator.js';
import { processEnrichChunk } from './processors/enrich-chunk.js';
// v4 translation pipeline (2026-05-09) — producer/orchestrator/chunk model
// with INLINE source text in the chunk plan. The old direct-execution v3
// could not finish 5000+ line films inside the 180s function ceiling; the
// pre-v3 worker pipeline failed under SDK rate limits. v4 fixes both: it
// uses the worker pattern (no function-timeout ceiling) AND collapses
// per-chunk SDK density to 4 calls (vs 6-8 in the failed pre-v3 design).
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

initSentry();

const connection = getRedis();
const baseOpts: Pick<WorkerOptions, 'connection'> = { connection };

// ─── Spin up one Worker per queue ────────────────────────────────────
const workers: Worker[] = [
  new Worker(QUEUE_NAMES.VOICE_GEN, processVoiceGen, {
    ...baseOpts, concurrency: env.CONCURRENCY_VOICE_GEN,
  }),
  new Worker(QUEUE_NAMES.BATCH_ENRICH, processBatchEnrich, {
    ...baseOpts, concurrency: env.CONCURRENCY_ENRICH,
  }),
  // v2 enrichment pipeline.
  new Worker(QUEUE_NAMES.ENRICH_ORCHESTRATOR, processEnrichOrchestrator, {
    ...baseOpts, concurrency: env.CONCURRENCY_ENRICH_ORCHESTRATOR,
  }),
  new Worker(QUEUE_NAMES.ENRICH_CHUNK, processEnrichChunk, {
    ...baseOpts, concurrency: env.CONCURRENCY_ENRICH_CHUNK,
  }),
  // v4 translation pipeline. Concurrency held at 4 deliberately:
  // voice-gen runs at 5 with no incidents; the May 8 incident was at 6+.
  // 4 + inline-text design = SDK density well under platform threshold.
  new Worker(QUEUE_NAMES.TRANSLATE_ORCHESTRATOR, processTranslateOrchestrator, {
    ...baseOpts, concurrency: env.CONCURRENCY_TRANSLATE_ORCHESTRATOR,
  }),
  new Worker(QUEUE_NAMES.TRANSLATE_CHUNK, processTranslateChunk, {
    ...baseOpts, concurrency: env.CONCURRENCY_TRANSLATE_CHUNK,
  }),
  // v2 adaptation pipeline — single AdaptationRun discriminated by `kind`.
  new Worker(QUEUE_NAMES.ADAPT_ORCHESTRATOR, processAdaptOrchestrator, {
    ...baseOpts, concurrency: env.CONCURRENCY_ADAPT_ORCHESTRATOR,
  }),
  new Worker(QUEUE_NAMES.ADAPT_CHUNK, processAdaptChunk, {
    ...baseOpts, concurrency: env.CONCURRENCY_ADAPT_CHUNK,
  }),
  // v2 AI-rewrite pipeline (bulk shorten/expand from the Tools panel).
  new Worker(QUEUE_NAMES.AIREWRITE_ORCHESTRATOR, processAIRewriteOrchestrator, {
    ...baseOpts, concurrency: env.CONCURRENCY_AIREWRITE_ORCHESTRATOR,
  }),
  new Worker(QUEUE_NAMES.AIREWRITE_CHUNK, processAIRewriteChunk, {
    ...baseOpts, concurrency: env.CONCURRENCY_AIREWRITE_CHUNK,
  }),
  new Worker(QUEUE_NAMES.SRT_IMPORT, processSrtImport, {
    ...baseOpts, concurrency: env.CONCURRENCY_SRT_IMPORT,
  }),
  // v2 HLS-to-MP4 ingest pipeline.
  new Worker(QUEUE_NAMES.HLS_INGEST, processHlsIngest, {
    ...baseOpts, concurrency: env.CONCURRENCY_HLS_INGEST,
  }),
  // CC Creation rules-engine re-apply pipeline (single-shot, ISOLATED to CC).
  new Worker(QUEUE_NAMES.CC_FORMAT_RUN, processCCFormatRun, {
    ...baseOpts, concurrency: env.CONCURRENCY_CC_FORMAT_RUN,
  }),
  // v2 proxy-generation pipeline (replaces the legacy fire-and-forget
  // /generate-proxy + webhook callback architecture). Concurrency held at 1
  // because ffmpeg pegs the Railway dyno CPU; two simultaneous transcodes
  // would each take ~2× wall-clock and risk OOM.
  new Worker(QUEUE_NAMES.PROXY_GEN, processProxyGen, {
    ...baseOpts, concurrency: env.CONCURRENCY_PROXY_GEN,
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
// /health  — Railway healthcheck.
// /enqueue — Producer-side endpoint. Base44 functions POST here to push
//            jobs into a queue. Protected by WORKER_ENQUEUE_SECRET if set.
const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      queues: workers.map(w => ({ name: w.name, concurrency: w.opts.concurrency, running: !w.closing })),
    }));
    return;
  }

  if (req.url === '/queue-status' && req.method === 'POST') {
    // ───────────────────────────────────────────────────────────────────
    // /queue-status — admin diagnostic. Returns BullMQ counts + the most
    // recent N jobs (with state + failedReason) for any queue. Used by
    // _diagnoseProxyGeneration and other admin diagnostics to answer:
    //   • Is the worker subscribed to this queue?
    //   • Are jobs piling up in 'waiting' (worker not picking up)?
    //   • Are jobs failing (and with what reason)?
    //   • Is the BullMQ retention working (failed jobs visible for 7d)?
    //
    // Body: { queue: string, limit?: number }
    // Returns: { counts, recent: [{ id, state, failedReason, ... }] }
    //
    // Auth: same shared secret as /enqueue and /job-status.
    // SOC 2 framing: read-only ops endpoint; no tenant data exposed beyond
    // what the producer already has on AIRewriteRun/TranslationRun/etc.
    // ───────────────────────────────────────────────────────────────────
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
      // Pull the most recent jobs across the three most diagnostic states.
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
        // Surface project_id + request_id so the operator can correlate
        // worker-side state with the Base44 entity tree without dumping
        // the entire job payload (which contains JWTs).
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
    // ───────────────────────────────────────────────────────────────────
    // /job-status — orchestrators call this to harvest chunk results.
    //
    // Body: { queue: string, job_ids: string[] }
    // Returns: { results: { [job_id]: { state, returnvalue, failedReason } } }
    //
    // Auth: same shared secret as /enqueue. The body of returnvalue is
    // tenant data, but the job_ids are opaque BullMQ identifiers minted
    // by the orchestrator + persisted on TranslationRun.chunk_jobs — they
    // are not enumerable from outside the run. The shared secret is
    // sufficient given that only Base44 functions know the IDs.
    //
    // SOC 2 framing: this is a worker→base44 callback path; identical
    // trust model as /enqueue. Does NOT replace per-job JWT scoping for
    // function invocation — it only reads BullMQ state, never invokes
    // tenant functions.
    // ───────────────────────────────────────────────────────────────────
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
    // Cap at 100 IDs per call to avoid pathological payloads.
    const ids = job_ids.slice(0, 100);

    try {
      const q = getQueue(queue);
      const results: Record<string, { state: string; returnvalue?: unknown; failedReason?: string }> = {};
      // Lookups are independent — fan out in parallel.
      await Promise.all(ids.map(async (id) => {
        try {
          const job = await q.getJob(id);
          if (!job) {
            // Job evicted from BullMQ (retention expired) — orchestrator
            // treats this as 'terminal: returnvalue_missing' on its end.
            return;
          }
          const state = await job.getState();
          results[id] = {
            state,
            returnvalue: state === 'completed' ? job.returnvalue : undefined,
            failedReason: state === 'failed' ? job.failedReason : undefined,
          };
        } catch (e) {
          // Per-id failure shouldn't poison the whole response.
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
