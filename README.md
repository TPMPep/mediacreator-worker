# MediaCreator BullMQ Worker

Background job worker for MediaCreator. Lives as a subfolder in the main repo
so queue contracts and the Base44 functions that produce/consume them stay in
lockstep (see `shared/queue-contracts.ts`).

## What it does

Pulls jobs from Redis-backed BullMQ queues and calls back into Base44 backend
functions at a controlled rate. Replaces today's bursty in-app fan-outs
(batch voice generation, batch translation, batch enrichment, large SRT
imports) with a real queue that gives us:

- Retries with exponential backoff
- Per-queue concurrency control (no more 429s from ElevenLabs)
- Priorities (paying customer's job jumps the line)
- Dead-letter queue (jobs that fail repeatedly land somewhere reviewable)
- Rate limiting (never exceed Base44 SDK limits)

## Architecture

```
Base44 fn  ──push──>  Upstash Redis (BullMQ queue)  <──pull──  Railway worker
                                                                    │
                                                                    └──invokes──> Base44 fn
```

The worker is the **only** thing that pulls from queues. Base44 functions
produce jobs (via a thin HTTP endpoint on the worker, or direct Redis push).

## Queues

Defined in `shared/queue-contracts.ts` — single source of truth, imported by
both the worker AND any Base44 function that pushes jobs.

| Queue              | Purpose                                       | Concurrency |
| ------------------ | --------------------------------------------- | ----------- |
| `voice-gen`        | Batch voice generation (per-segment)          | 5 (= EL slot ceiling) |
| `batch-translate`  | Batch translation runs                        | 10          |
| `batch-enrich`     | Superscript enrichment chunks                 | 4           |
| `srt-import`       | Large SRT imports (>200 lines)                | 2           |

## Local dev

```bash
cd bullmq-worker
npm install
cp .env.example .env   # fill in UPSTASH_REDIS_URL + BASE44_* values
npm run dev            # runs with tsx watch
```

## Deploy to Railway

1. **Create new Railway service**: railway.app → New Service → Deploy from
   GitHub repo → pick this repo → set **Root Directory** to `bullmq-worker`.
2. **Set environment variables** in Railway service settings:
   - `UPSTASH_REDIS_URL` — your existing Upstash Redis connection string
   - `BASE44_APP_ID` — same value as the Base44 app
   - `BASE44_API_BASE` — `https://app.base44.com/api/apps/{appId}` (or the
     platform URL you use)
   - `BASE44_SERVICE_TOKEN` — service-role token for invoking Base44 functions
     (generate from Base44 dashboard → Settings → API Tokens)
   - `SENTRY_BACKEND_DSN` — optional, same DSN as Base44 backend functions
   - `WORKER_CONCURRENCY_VOICE_GEN` — defaults to 5
   - `WORKER_CONCURRENCY_TRANSLATE` — defaults to 10
   - `WORKER_CONCURRENCY_ENRICH` — defaults to 4
   - `WORKER_CONCURRENCY_SRT_IMPORT` — defaults to 2
3. **Deploy**. Railway runs `npm install && npm run build && npm start`.
4. **Verify**: Railway logs should show `worker started, listening on N
   queues`. Push a test job from a Base44 function and watch it process.

Cost: ~$5–10/mo for one Railway worker service.

## Adding a new queue

1. Add to `shared/queue-contracts.ts` — define name + payload type.
2. Add a processor file in `src/processors/`.
3. Register the processor in `src/index.ts`.
4. From the Base44 side: import the same contract and push jobs via the
   worker's `/enqueue` HTTP endpoint (or directly via ioredis if you prefer).

## Compliance notes

- Worker runs in a Railway region matching your data residency requirements.
  Configure region in Railway service settings.
- Sentry transport is optional and obeys the same DSN env var as the Base44
  backend, so tagging stays consistent across the stack.
- Job payloads should NEVER contain raw media — only IDs + S3 keys. The
  worker invokes Base44 functions that handle media access via signed URLs.
- All worker actions emit a structured log to Base44's `StructuredLog`
  entity via the worker's `logEvent` helper, preserving the same audit trail
  pattern used by Base44 functions.