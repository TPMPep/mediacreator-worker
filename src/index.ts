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
// v2 voice-gen orchestrator (2026-05-18) — handles the fan-out phase that
// previously ran synchronously inside runVoiceGeneration. The per-segment
// voice-gen workers (processVoiceGen above) are unchanged.
import { processVoiceGenOrchestrator } from './processors/voice-gen-orchestrator.js';
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
import { processProjectCascade } from './processors/project-cascade.js';
// User-triggered export pipeline (2026-05-15) — unified processor handles
// all four module kinds (dub / superscript / adaptation / cc) via a kind
// discriminator on the job payload.
import { processExportProject } from './processors/export-project.js';
// Weekly full-DB backup pipeline (2026-05-15). Replaces the synchronous
// backupAllEntitiesToS3 function once DB growth pushes it past the 3-min
// function ceiling.
import { processBackupSnapshot } from './processors/backup-snapshot.js';
// Admin-only load-test fan-out (2026-05-18). Off-platform harness that
// fires N producer calls in tick-bounded batches. Same architecture as the
// other orchestrators. Producer is Base44 fn `runPipelineLoadTest`; each
// tick calls back into `loadTestFanoutWorkerStep`.
import { processLoadTestFanout } from './processors/load-test-fanout.js';
// Worker-side bulk cleanup for load-test fixtures (B8, 2026-05-21).
// Replaces the in-platform cleanupLoadTestArtifacts function which 504'd
// on any fixture with >~2k accumulated rows. Producer is Base44 fn
// `enqueueLoadTestCleanup`; each tick calls back into
// `loadTestCleanupWorkerStep` to drain one entity bucket page at a time.
import { processLoadTestCleanup } from './processors/load-test-cleanup.js';

initSentry();

// =============================================================================
// BUILD FINGERPRINT (2026-05-19) — Surfaces on /health and the
// worker_started StructuredLog row so we can prove which commit Railway is
// actually running, without grepping Railway logs. Railway injects
// RAILWAY_GIT_COMMIT_SHA / RAILWAY_GIT_BRANCH / RAILWAY_DEPLOYMENT_ID into
// the build environment automatically (no config required). If Railway is
// not the platform, the fields fall back to 'unknown' but BUILD_TAG still
// identifies the source-tree version.
// =============================================================================
const BUILD_INFO = {
  build_tag: '2026-05-22-b8-loadtest-cleanup-tick-timeout-120s',
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
  // v2 voice-gen orchestrator (2026-05-18). One ORCHESTRATOR job per
  // voice-gen RUN (not per segment); it dispatches the per-segment
  // voice-gen jobs in bounded ticks. Concurrency=4 mirrors the other
  // orchestrators (translate, adapt, airewrite) — they're lightweight
  // (each tick is ~100-150 enqueues + a JobRun.update) so 4 simultaneous
  // RUNS being orchestrated is comfortable.
  new Worker(QUEUE_NAMES.VOICE_GEN_ORCHESTRATOR, processVoiceGenOrchestrator, {
    ...baseOpts, concurrency: env.CONCURRENCY_VOICE_GEN_ORCHESTRATOR,
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
  // AIREWRITE_CHUNK — Stage-2 scale-up (2026-05-21). Per-worker concurrency
  // raised to 5 via env (was 3). Railway replicas scaled 1→4, giving
  // effective platform-wide chunk concurrency of 20 — eliminates the head-
  // of-line blocking observed at N=10 where children starved each other
  // for worker slots. The `limiter` is the auditor-defensible safety belt
  // against runaway provider load: caps outbound chunk dispatches at
  // 100 jobs / 60s per replica (400/min platform-wide), well under Gemini
  // paid (1000 RPM) and OpenAI Tier-4 (30k RPM) quotas. SOC 2 CC7.4 —
  // subprocessor protection provable from config alone. Revertable in
  // <60s by removing the `limiter` block or lowering the env var.
  new Worker(QUEUE_NAMES.AIREWRITE_CHUNK, processAIRewriteChunk, {
    ...baseOpts,
    concurrency: env.CONCURRENCY_AIREWRITE_CHUNK,
    limiter: { max: 100, duration: 60_000 },
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
  // Project cascade-delete pipeline (2026-05-15). Runs outside the 3-min
  // function ceiling so large projects can be deleted reliably. Concurrency=2
  // keeps SDK rate budget safe while allowing reasonable throughput.
  new Worker(QUEUE_NAMES.PROJECT_CASCADE, processProjectCascade, {
    ...baseOpts, concurrency: env.CONCURRENCY_PROJECT_CASCADE,
  }),
  // User-triggered export pipeline (2026-05-15). Unified processor —
  // job.data.kind selects which entity tree to paginate and which builder
  // to use. I/O bound (not CPU bound) so concurrency=4 is safe.
  new Worker(QUEUE_NAMES.EXPORT_PROJECT, processExportProject, {
    ...baseOpts, concurrency: env.CONCURRENCY_EXPORT_PROJECT,
  }),
  // Weekly full-DB backup pipeline (2026-05-15). One backup runs at a time
  // — concurrency=1 because the job paginates EVERY entity and would
  // saturate the per-app SDK rate limit if two ran concurrently.
  new Worker(QUEUE_NAMES.BACKUP_SNAPSHOT, processBackupSnapshot, {
    ...baseOpts, concurrency: env.CONCURRENCY_BACKUP_SNAPSHOT,
  }),
  // Load-test fan-out (2026-05-18). Concurrency=2 — admins may rarely
  // kick off two load tests back-to-back; one runs while the second
  // queues. Each fan-out tick is lightweight (one Base44 fn call + state
  // bookkeeping), so 2 in flight does NOT meaningfully load the worker.
  new Worker(QUEUE_NAMES.LOAD_TEST_FANOUT, processLoadTestFanout, {
    ...baseOpts, concurrency: env.CONCURRENCY_LOAD_TEST_FANOUT,
  }),
  // Load-test cleanup (B8, 2026-05-21). Concurrency held DELIBERATELY at 1:
  // only one cleanup runs per fixture at a time (admins rarely have multiple
  // fixtures dirty simultaneously), and the bottleneck is the Base44
  // platform's per-app write rate limiter — bumping concurrency higher
  // would amplify 429 backoff penalties without shortening any single run.
  // SOC 2 CC7.4 — bounded subprocessor load provable from config alone.
  new Worker(QUEUE_NAMES.LOAD_TEST_CLEANUP, processLoadTestCleanup, {
    ...baseOpts, concurrency: env.CONCURRENCY_LOAD_TEST_CLEANUP,
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
// /health  — Railway healthcheck.
// /enqueue — Producer-side endpoint. Base44 functions POST here to push
//            jobs into a queue. Protected by WORKER_ENQUEUE_SECRET if set.
const server = http.createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      build_info: BUILD_INFO,
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
