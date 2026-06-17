// =============================================================================
// MEDIACREATOR BULLMQ WORKER — Entry point.
// Boots one Worker per queue, wires shared error/log handlers, exposes a
// minimal /health endpoint for Railway healthchecks.
// =============================================================================

import { Worker, type WorkerOptions } from 'bullmq';
import http from 'node:http';
import { env, assertS3CredsOrWarn } from './env.js';
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
// Worker-side deterministic TranslationSegment reseed for load-test
// fixtures (2026-05-22). Replaces the in-platform _loadTestSeedTranslations
// which 502'd on any fixture with prior translations. Producer is Base44
// fn `enqueueLoadTestReseed`; each tick calls back into
// `loadTestReseedWorkerStep` to advance one language's wipe+seed at a time.
import { processLoadTestReseed } from './processors/load-test-reseed.js';
// CC Creation cue supersede + engine dispatch (2026-05-28). Moves the
// heavy bulk-supersede + Railway dispatch out of ccRunTranscription's
// 30s function ceiling. Producer is Base44 fn `ccRunTranscription`;
// each tick calls back into `ccCueSupersedeWorkerStep` to flip up to
// ~500 cues per tick; on completion the worker calls `ccDispatchToEngine`
// to POST to Railway.
import { processCCCueSupersede } from './processors/cc-cue-supersede.js';
// AI-Dubbing transcript REPLACE pipeline (2026-06-09). Moves the heavy
// destructive replace (delete old + bulk-create new) out of importTranscript's
// gateway-timeout window using a stage-then-flip resumable worker step.
// Producer is Base44 fn `importTranscript` (mode='replace'); each tick calls
// back into `transcriptImportWorkerStep`. Scoped to AI Dubbing replace only —
// create/import into an empty project stays synchronous.
import { processTranscriptImport } from './processors/transcript-import.js';
// GLTV API cascade orchestrator (Phase 2, 2026-06-12). FULLY ISOLATED product
// surface — its own queue + concurrency lane; never shares state with any human
// Media Creator pipeline. Factory-built because the processor re-enqueues its
// own next tick and needs a handle to the lazily-initialised queue registry.
import { makeGltvCascadeProcessor } from './processors/gltv-cascade.js';
// Simple Translation (SRT) async translate (2026-06-16). FULLY ISOLATED to the
// Translation module — its own queue + concurrency lane; never shares state with
// the AI-Dubbing translate pipeline. Moves the heavy bulk SRT translate out of
// translateSrtProject's gateway-timeout window using a tick-resumable worker
// step. Producer is Base44 fn `translateSrtProject` (mode='translate'); each
// tick calls back into `srtTranslateWorkerStep` to translate ~120 cues; the
// processor loops until the run finalizes.
import { processSrtTranslate } from './processors/srt-translate.js';

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
  build_tag: '2026-06-17-gltv-cascade-jwt-renewal-and-chunk-lock-ghost',
  git_sha: process.env.RAILWAY_GIT_COMMIT_SHA || 'unknown',
  git_branch: process.env.RAILWAY_GIT_BRANCH || 'unknown',
  deployment_id: process.env.RAILWAY_DEPLOYMENT_ID || 'unknown',
  started_at: new Date().toISOString(),
} as const;
console.log('[worker] BUILD_INFO', JSON.stringify(BUILD_INFO));

// Boot-time S3 credential check — warns loudly (does NOT crash) if the
// default-profile AWS creds are missing, so EXPORT_PROJECT / BACKUP_SNAPSHOT
// misconfiguration is visible at deploy instead of per-deliverable. Surfaced
// on the worker_started StructuredLog row below for auditor visibility.
const s3Creds = assertS3CredsOrWarn();

const connection = getRedis();
const baseOpts: Pick<WorkerOptions, 'connection'> = { connection };

// ─── Queue handle registry (hoisted) ─────────────────────────────────
// Declared BEFORE the workers array so the GLTV cascade processor — which
// re-enqueues its own next tick — can be given a getQueue handle at
// construction time. Also used by the /enqueue, /queue-status, /job-status,
// and /remove-job HTTP endpoints below. Lazy-inits one Queue per name.
import { Queue } from 'bullmq';
const queueRegistry = new Map<string, Queue>();
function getQueue(name: string): Queue {
  let q = queueRegistry.get(name);
  if (!q) {
    q = new Queue(name, { connection });
    queueRegistry.set(name, q);
  }
  return q;
}

// ─── Spin up one Worker per queue ────────────────────────────────────
const workers: Worker[] = [
  // VOICE_GEN — per-segment ElevenLabs TTS. The `limiter` is the keystone fix
  // for the 2026-06-02 provider_429 storm: the ElevenLabs concurrency semaphore
  // in generateOneSegment caps how many calls are IN FLIGHT at once (6), but
  // NOTHING capped the RATE at which the worker STARTED jobs. At
  // concurrency=2/replica × 4 replicas the orchestrator's 150-job-per-tick
  // dispatch let all 8 slots try to start near-simultaneously, hammering
  // ElevenLabs in a synchronized wave that the provider burst-rate-limited →
  // 429s → exhausted retries → failed + incomplete segments (the exact reported
  // symptom). The limiter spreads job STARTS to 6/sec platform-wide, so calls
  // arrive at ElevenLabs as a steady stream instead of a thundering herd. Same
  // proven pattern as AIREWRITE_CHUNK (line below). Pairs with the in-function
  // semaphore (in-flight cap) — start-rate AND concurrency are both now bounded.
  // SOC 2 CC7.4 — subprocessor burst protection provable from config alone;
  // revertable in <60s by removing the `limiter` block.
  new Worker(QUEUE_NAMES.VOICE_GEN, processVoiceGen, {
    ...baseOpts,
    concurrency: env.CONCURRENCY_VOICE_GEN,
    limiter: { max: 6, duration: 1000 },
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
  // STALLED-JOB RECLAIM (2026-06-02 — wedged-chunk root-cause fix): a chunk
  // job stuck in BullMQ state `active` after its worker pod was killed
  // mid-execution (Railway pod recycle / OOM) is NEVER auto-requeued by
  // default — BullMQ's stalled-job checker only runs with explicit settings.
  // Without it, the orchestrator harvest loop sees `active` forever and the
  // run stalls permanently under a live orchestrator (the exact 70%-forever
  // symptom). `stalledInterval`+`maxStalledCount` make BullMQ reclaim the
  // orphaned job and re-run it (rewriteChunk is idempotent — the orchestrator
  // is the sole writer, so a re-run never double-writes). This is the PRIMARY,
  // native self-heal; the orchestrator's staleness-reclaim is belt-and-
  // suspenders. SOC 2 CC7.2 — a dead pod can no longer strand a run forever.
  new Worker(QUEUE_NAMES.AIREWRITE_CHUNK, processAIRewriteChunk, {
    ...baseOpts,
    concurrency: env.CONCURRENCY_AIREWRITE_CHUNK,
    limiter: { max: 100, duration: 60_000 },
    stalledInterval: 30_000,
    maxStalledCount: 2,
  }),
  new Worker(QUEUE_NAMES.SRT_IMPORT, processSrtImport, {
    ...baseOpts, concurrency: env.CONCURRENCY_SRT_IMPORT,
  }),
  // v2 HLS-to-MP4 ingest pipeline.
  new Worker(QUEUE_NAMES.HLS_INGEST, processHlsIngest, {
    ...baseOpts, concurrency: env.CONCURRENCY_HLS_INGEST,
  }),
  // CC Creation rules-engine re-apply pipeline (single-shot, ISOLATED to CC).
  // STALLED-JOB RECLAIM (2026-06-16): SAFE to native-reclaim because
  // ccFormatRunWorkerStep short-circuits on a terminal CCFormatRun (idempotent)
  // and the processor now runs its call inside runWithLockHeartbeat (a lost lock
  // aborts the prior invocation, so a reclaim never runs parallel to a zombie).
  // A dead pod self-heals on BullMQ's sub-minute clock instead of waiting for
  // watchdogCCFormatRuns. Mirrors CC_CUE_SUPERSEDE. SOC 2 CC7.2.
  new Worker(QUEUE_NAMES.CC_FORMAT_RUN, processCCFormatRun, {
    ...baseOpts,
    concurrency: env.CONCURRENCY_CC_FORMAT_RUN,
    stalledInterval: 30_000,
    maxStalledCount: 2,
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
  // Load-test reseed (2026-05-22). Same posture as cleanup — concurrency=1,
  // bottleneck is the Base44 write rate limiter not parallelism.
  new Worker(QUEUE_NAMES.LOAD_TEST_RESEED, processLoadTestReseed, {
    ...baseOpts, concurrency: env.CONCURRENCY_LOAD_TEST_RESEED,
  }),
  // CC cue supersede + engine dispatch (2026-05-28). Concurrency=4 — each
  // job is mostly idle between ticks (paginated bulkUpdate calls), so 4
  // simultaneous re-transcribes is comfortable for 100+ concurrent users.
  // Bottleneck is the per-tick Base44 write budget, not parallelism.
  new Worker(QUEUE_NAMES.CC_CUE_SUPERSEDE, processCCCueSupersede, {
    ...baseOpts, concurrency: env.CONCURRENCY_CC_CUE_SUPERSEDE,
  }),
  // AI-Dubbing transcript REPLACE (2026-06-09). Each in-flight job is one
  // tick-resumable stage-then-flip pass against ONE TranscriptImportRun. The
  // staging phase is bulkCreate-bound (150 rows/tick) and the cutover/finalize
  // phases are bounded bulkUpdate passes — so the worker slot is mostly idle
  // between ticks. Concurrency=4 matches CC_CUE_SUPERSEDE and gives 100-
  // concurrent-user replace headroom. Bottleneck is the per-tick Base44 write
  // budget, not parallelism — bumping higher would amplify 429 pressure
  // without shortening any single run. SOC 2 CC7.2 — resumable: a pod death
  // mid-stage re-creates ZERO already-staged rows (checkpoint tracks it).
  // STALLED-JOB RECLAIM (2026-06-16): SAFE to native-reclaim because
  // transcriptImportWorkerStep is idempotent + resumable (short-circuits on a
  // terminal TranscriptImportRun, resumes staging from checkpoint.stage_cursor)
  // and the processor now runs every call inside runWithLockHeartbeat (a lost
  // lock aborts the prior invocation, so a reclaim never runs parallel to a
  // zombie). A dead pod self-heals on BullMQ's sub-minute clock instead of
  // waiting for watchdogTranscriptImportRuns. Mirrors CC_CUE_SUPERSEDE. SOC 2 CC7.2.
  new Worker(QUEUE_NAMES.TRANSCRIPT_IMPORT, processTranscriptImport, {
    ...baseOpts,
    concurrency: env.CONCURRENCY_TRANSCRIPT_IMPORT,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  }),
  // GLTV API cascade (Phase 2, 2026-06-12). ISOLATED lane — default 5
  // concurrent cascades (GLTV_CASCADE_CONCURRENCY) so an API burst can never
  // starve human editors. Each in-flight job is one tick-resumable phase
  // transition against ONE DubbingApiJob; the processor re-enqueues its own
  // next tick (10s delay), so the slot is idle between ticks. Built via a
  // factory so it can re-enqueue through the hoisted getQueue handle.
  // STALLED-JOB RECLAIM (2026-06-16): a cascade tick whose pod is killed mid-
  // flight (Railway recycle / OOM) leaves a BullMQ job wedged `active` with no
  // owner. Without these settings BullMQ never reclaims it and the cascade
  // stalls until watchdogGltvCascade fires. Now SAFE to native-reclaim because
  // (a) the tick is idempotent + resumable (brain is the sole status writer) and
  // (b) runWithLockHeartbeat aborts the prior invocation the instant its lock is
  // lost, so a reclaim never runs parallel to a zombie. SOC 2 CC7.2 — a dead pod
  // can no longer strand a cascade. Mirrors AIREWRITE_CHUNK's reclaim posture.
  new Worker(QUEUE_NAMES.GLTV_CASCADE, makeGltvCascadeProcessor(getQueue), {
    ...baseOpts,
    concurrency: env.CONCURRENCY_GLTV_CASCADE,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  }),
  // Simple Translation (SRT) async translate (2026-06-16). ISOLATED lane —
  // default 4 concurrent runs so a translation burst never starves any other
  // pipeline. Each in-flight job loops srtTranslateWorkerStep ticks against ONE
  // SimpleTranslationRun; between provider batches the slot is mostly idle.
  // Bottleneck is the per-tick Base44 write budget, not parallelism.
  // STALLED-JOB RECLAIM: SAFE to native-reclaim — srtTranslateWorkerStep is
  // idempotent + resumable (short-circuits on a terminal run, resumes from
  // checkpoint.cursor as a forward pass over all cues) and every call runs
  // inside runWithLockHeartbeat (a lost lock aborts the prior invocation, so a
  // reclaim never runs parallel to a zombie). A dead pod self-heals on BullMQ's
  // sub-minute clock instead of waiting for watchdogSimpleTranslationRuns.
  // Mirrors CC_CUE_SUPERSEDE. SOC 2 CC7.2.
  new Worker(QUEUE_NAMES.SRT_TRANSLATE, processSrtTranslate, {
    ...baseOpts,
    concurrency: env.CONCURRENCY_SRT_TRANSLATE,
    stalledInterval: 30_000,
    maxStalledCount: 2,
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
    s3_creds_present: s3Creds.ok,
    s3_creds_missing: s3Creds.missing,
  },
});

import { DEFAULT_JOB_OPTIONS } from '../shared/queue-contracts.js';

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
      s3_creds_present: s3Creds.ok,
      s3_creds_missing: s3Creds.missing,
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
      const results: Record<string, {
        state: string;
        returnvalue?: unknown;
        failedReason?: string;
        processed_on?: number | null;
        timestamp?: number | null;
        attempts_made?: number | null;
        lock_present?: boolean | null;
      }> = {};
      // Live-lock probe (2026-06-17 — chunk lock-ghost fix). BullMQ holds a
      // per-job lock at the Redis key `bull:<queue>:<jobId>:lock` for as long
      // as the worker that picked the job up is alive and heart-beating its
      // lock. When a worker pod is HARD-KILLED mid-execution (Railway recycle /
      // OOM), the lock key's TTL expires within ~30s and the key DISAPPEARS —
      // but the job can remain in BullMQ state `active` (with processed_on SET,
      // attempts_made still low) until BullMQ's stalled-checker reclaims it.
      // That window is exactly the chunk-ghost strand: processed_on says
      // "a worker ran this" so the orchestrator's processed_on discriminator
      // treats it as live-but-slow and waits the 15-min backstop. Reading the
      // lock key tells us the truth: active + NO lock = the owning worker is
      // dead, reclaim it on the SHORT ghost ceiling, not the 15-min one.
      // SOC 2 CC7.2 — reclaim acts on real lock presence, never an inferred timer.
      const redis = getRedis();
      const lockKey = (jobId: string) => `bull:${queue}:${jobId}:lock`;
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
          // Only probe the lock for ACTIVE jobs — that's the only state where
          // lock presence is meaningful (waiting/delayed never hold a lock;
          // completed/failed already terminalised). One cheap EXISTS per active
          // job. null = not probed (non-active state); true/false = probed.
          let lockPresent: boolean | null = null;
          if (state === 'active') {
            try {
              lockPresent = (await redis.exists(lockKey(id))) === 1;
            } catch (lockErr) {
              // Redis EXISTS failed — leave null so the orchestrator falls back
              // to its existing processed_on/attempts/age logic (never reclaim
              // on a failed probe). Best-effort, never poisons the response.
              console.warn(`[job-status] lock probe ${id} failed: ${(lockErr as Error).message}`);
            }
          }
          results[id] = {
            state,
            returnvalue: state === 'completed' ? job.returnvalue : undefined,
            failedReason: state === 'failed' ? job.failedReason : undefined,
            // PROGRESS DISCRIMINATOR (2026-06-02 — wedged-chunk true-ghost fix):
            // processedOn is set the instant a worker actually PICKS UP the job
            // and starts the processor. timestamp is when the job was added to
            // the queue. The orchestrator's stale-reclaim uses these to tell a
            // genuinely-working `active` job (processedOn set, recent) apart from
            // a true ghost (`active` but processedOn null — a job that entered
            // the active set but whose worker died before the processor ran, so
            // BullMQ's stalled checker can't promote it because no lock exists).
            // Without this signal the orchestrator aged chunks on dispatch
            // wall-clock alone and killed LIVE work as `stale_reclaim_exhausted`.
            // SOC 2 CC7.2 — reclaim acts on real job state, not an inferred timer.
            processed_on: job.processedOn ?? null,
            timestamp: job.timestamp ?? null,
            attempts_made: job.attemptsMade ?? null,
            // Live-lock presence (active jobs only; null otherwise). A
            // processed_on-SET active job with lock_present=false is a TRUE
            // GHOST (owning worker died, lock TTL lapsed) the orchestrator may
            // reclaim on the short ghost ceiling. SOC 2 CC7.2.
            lock_present: lockPresent,
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

  if (req.url === '/remove-job' && req.method === 'POST') {
    // ───────────────────────────────────────────────────────────────────
    // /remove-job — admin recovery. Removes ONE explicit job (by id) from a
    // queue regardless of its state (waiting / completed / failed / delayed).
    //
    // This is the missing primitive behind the project-cascade dedup dead-end:
    // a deterministic jobId (e.g. cascade-<project_id>) sitting in completed/
    // failed retention blocks every re-enqueue with the same id until BullMQ's
    // retention GC fires (1h completed / 7d failed). job.remove() clears it
    // immediately so a fresh enqueue can run.
    //
    // Body: { queue: string, job_id: string }
    // Returns: { ok, queue, job_id, removed: boolean, state_before }
    //
    // Auth: same shared secret as /enqueue + /queue-status. Scope/allowlist
    // enforcement (which job_ids an actor may remove) lives in the Base44
    // caller (_adminRemoveCascadeJob), which is admin-gated and pattern-
    // restricted to cascade-<project_id> ids. This endpoint is intentionally
    // a generic primitive — the policy belongs on the Base44 side where the
    // user identity + RBAC live. SOC 2 CC6.1 — every removal is attributable
    // via the calling function's ActivityLog row.
    // ───────────────────────────────────────────────────────────────────
    if (!env.ENQUEUE_SECRET || req.headers['x-enqueue-secret'] !== env.ENQUEUE_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed: { queue?: string; job_id?: string };
    try { parsed = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }
    const { queue, job_id } = parsed;
    if (!queue || !job_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'queue + job_id required' }));
      return;
    }
    if (!Object.values(QUEUE_NAMES).includes(queue as never)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `unknown queue: ${queue}` }));
      return;
    }
    try {
      const q = getQueue(queue);
      const job = await q.getJob(job_id);
      if (!job) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, queue, job_id, removed: false, state_before: 'not_found' }));
        return;
      }
      const state_before = await job.getState();
      // Never remove a job that is actively executing — that would orphan the
      // entities mid-delete (same rationale as _adminPurgeStuckCascades leaving
      // active jobs alone). Caller must wait for it to terminalise.
      if (state_before === 'active') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, queue, job_id, removed: false, state_before, error: 'job is active — refusing to remove mid-execution' }));
        return;
      }
      await job.remove();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, queue, job_id, removed: true, state_before }));
    } catch (err) {
      const e = err as Error;
      captureError(e, { route: '/remove-job', queue, job_id });
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
