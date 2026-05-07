# Railway `/hls-ingest` endpoint — paste-ready spec

This is the **only piece of the HLS-to-MP4 pipeline** that lives outside Base44 + the BullMQ worker. It runs in your **Railway FFmpeg service** (the same Railway service that already exposes `/trim`, `/extract-audio`, `/generate-proxy`, etc.).

> ⚠️ **NOT the bullmq-worker repo.** This file lives here for reference, but the code goes in your **Railway FFmpeg service repo** alongside your existing endpoints.

---

## 1. Where the file goes in your Railway repo

**File location:** Top level of your Railway FFmpeg service repo, alongside the file that already serves your other endpoints.

If your existing repo has:

```
your-railway-repo/
├── package.json
├── index.js          ← your other routes (/trim, /extract-audio) live here
├── ...
```

Then **either**:

### Option A — Add the route inline (recommended, matches your existing style)
Open `index.js` (or whatever file holds your existing `/trim`, `/extract-audio` routes) and paste the handler from §3 below at the same level as your other `app.post(...)` calls.

### Option B — Modular (if your repo is structured that way)
Save the handler as `routes/hls-ingest.js` and `require()` / `import` it from your main file.

**Pick whichever matches your existing convention.** If `/trim` is inline, do inline. If it's modular, do modular. Don't mix styles.

---

## 2. The exact contract

### Inbound — what the BullMQ worker sends

```http
POST {RAILWAY_AUDIO_EXTRACTOR_URL}/hls-ingest
Authorization: Bearer {RAILWAY_AUDIO_EXTRACTOR_KEY}
Content-Type: application/json
X-Request-Id: <uuid for log correlation>

{
  "project_id":               "<Project id>",
  "hls_ingest_run_id":        "<HlsIngestRun id>",
  "variant_playlist_url":     "https://origin.example.com/.../variant.m3u8",
  "bucket":                   "pep-test",
  "region":                   "us-west-2",
  "output_key":               "dubflow/<projectId>/source_hls_<ts>.mp4",
  "credential_secret_prefix": "",
  "audio_codec":              "mp4a.40.2",
  "remux_only":               true
}
```

**Important fields:**
- `variant_playlist_url` — Base44 has already picked the variant + validated codecs (H.264 + (AAC | AC-3 | E-AC-3)). **Do not re-pick a variant on Railway.** Faithfully remux this exact playlist.
- `bucket` + `region` + `output_key` — where to write the resulting MP4. Use the same AWS creds your other endpoints already use (env vars `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`).
- `credential_secret_prefix` — for multi-region storage profiles. Empty string = use the default `AWS_*` env vars (the case 99% of the time today). If non-empty, use `${prefix}_ACCESS_KEY_ID` / `${prefix}_SECRET_ACCESS_KEY` instead.
- `audio_codec` — **CRITICAL**: this is the audio codec the Base44 codec gate already pinned (e.g. `"mp4a.40.2"`, `"ac-3"`, `"ec-3"`). Your handler uses this to apply the correct ffmpeg flags. **The `-bsf:a aac_adtstoasc` filter is AAC-only and will FAIL on AC-3 / E-AC-3.**
- `remux_only: true` — sanity flag. Future-proofs the contract; today this is always `true`.

### Outbound — what your endpoint returns (synchronous, NOT a callback)

```json
{
  "output_key":         "dubflow/<projectId>/source_hls_<ts>.mp4",
  "size_bytes":         87432104,
  "remux_duration_ms":  31420,
  "hls_ingest_run_id":  "<echo>",
  "project_id":         "<echo>"
}
```

The BullMQ worker holds the HTTP connection open for up to **15 minutes** (`RAILWAY_CALL_TIMEOUT_MS`). If your remux takes longer than that, the worker will time out and BullMQ will retry. For a 90-min H.264+AAC source, `-c copy` typically finishes in 30-90 seconds — well under the budget.

> **Why synchronous, not async-callback?** Earlier doc draft said callback. That was wrong — the actual `hlsIngestWorkerStep` function expects the worker to wait for Railway and pass the response back via `carry.railway_response`. Synchronous is simpler, and the worker's lock-heartbeat keeps the job alive during the long call.

---

## 3. Codec policy — bit-faithful guarantee + codec-conditional flags

Base44's Phase 2 codec gate accepts THREE audio codec families:

| Codec | RFC 6381 string | MP4-native? | ffmpeg flag |
|---|---|---|---|
| AAC (LC, HE-AAC, HE-AACv2) | `mp4a.40.*` | ✅ | **needs** `-bsf:a aac_adtstoasc` |
| Dolby Digital (AC-3) | `ac-3` | ✅ | **must NOT** use `aac_adtstoasc` |
| Dolby Digital Plus (E-AC-3) | `ec-3` | ✅ | **must NOT** use `aac_adtstoasc` |

**Why the codec-conditional flag matters:**

The `-bsf:a aac_adtstoasc` bitstream filter strips ADTS framing on AAC streams when remuxing HLS-TS → MP4. Without it, browsers won't play AAC-in-MP4. **It is AAC-only.** Running it against AC-3 or E-AC-3 audio will fail with `Bitstream filter aac_adtstoasc requires AAC input` and the entire run will error.

The handler below branches on the inbound `audio_codec` field:

- `audio_codec` starts with `mp4a` → include `-bsf:a aac_adtstoasc`
- `audio_codec` is `ac-3` or `ec-3` → omit the filter (audio passes through `-c copy` cleanly)

Bit-faithful guarantee is preserved either way: `-c copy` copies bytes for all three codecs; the bsf is a framing reformat (ADTS → ASC), not a transcode. Audio sample bytes are unchanged in all cases.

---

## 4. The handler — paste-ready Node.js (Express) code

```js
// routes/hls-ingest.js  (or paste inline alongside your other routes)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

// Use the SAME shared-secret check pattern as your other endpoints.
function checkAuth(req, res) {
  const expected = process.env.RAILWAY_AUDIO_EXTRACTOR_KEY;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!expected || got !== expected) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function resolveAwsCreds(prefix) {
  if (prefix) {
    return {
      accessKeyId: process.env[`${prefix}_ACCESS_KEY_ID`],
      secretAccessKey: process.env[`${prefix}_SECRET_ACCESS_KEY`],
    };
  }
  return {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
}

// Build the codec-conditional ffmpeg argument list. The `-bsf:a aac_adtstoasc`
// filter is AAC-only and will FAIL on AC-3 / E-AC-3 audio. Branch on the
// audio codec the Base44 codec gate already pinned on the request.
function buildFfmpegArgs(inputUrl, outputPath, audioCodec) {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel', 'warning',
    '-nostats',
    '-i', inputUrl,
    '-c', 'copy',  // bit-faithful — never re-encode customer source
  ];
  // Apply aac_adtstoasc ONLY for AAC streams.
  // mp4a.40.* covers LC, HE-AAC, HE-AACv2 — all AAC family.
  const codec = String(audioCodec || '').toLowerCase();
  if (codec.startsWith('mp4a')) {
    args.push('-bsf:a', 'aac_adtstoasc');
  }
  // AC-3 / E-AC-3 / unknown → no bsf, pass through as-is.
  args.push('-movflags', '+faststart');
  args.push(outputPath);
  return args;
}

// POST /hls-ingest
app.post('/hls-ingest', async (req, res) => {
  if (!checkAuth(req, res)) return;

  const {
    project_id,
    hls_ingest_run_id,
    variant_playlist_url,
    bucket,
    region,
    output_key,
    credential_secret_prefix = '',
    audio_codec,  // ← REQUIRED for codec-conditional flags
  } = req.body || {};

  if (!project_id || !hls_ingest_run_id || !variant_playlist_url || !bucket || !region || !output_key) {
    return res.status(400).json({ error: 'missing required fields' });
  }

  const reqId = req.headers['x-request-id'] || hls_ingest_run_id;
  const tmpFile = path.join(os.tmpdir(), `hls_${hls_ingest_run_id}_${Date.now()}.mp4`);

  console.log(`[hls-ingest] run=${hls_ingest_run_id} start url=${variant_playlist_url} audio=${audio_codec || 'unknown'}`);

  const t0 = Date.now();
  try {
    // ─── 1. ffmpeg `-c copy` — bit-faithful remux. NEVER re-encode. ───
    const args = buildFfmpegArgs(variant_playlist_url, tmpFile, audio_codec);
    console.log(`[hls-ingest] run=${hls_ingest_run_id} ffmpeg args: ${args.join(' ')}`);

    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const stderrChunks = [];
      proc.stderr.on('data', c => {
        stderrChunks.push(c);
        // Trim memory: keep only the last ~50 KB of stderr.
        if (Buffer.byteLength(Buffer.concat(stderrChunks)) > 50_000) {
          stderrChunks.splice(0, stderrChunks.length - 1);
        }
      });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0) return resolve();
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').slice(-2000);
        reject(new Error(`ffmpeg exited ${code}\n${stderr}`));
      });
    });

    const remuxDurationMs = Date.now() - t0;
    const stat = await fsp.stat(tmpFile);
    console.log(`[hls-ingest] run=${hls_ingest_run_id} ffmpeg_complete duration_ms=${remuxDurationMs} size=${stat.size}`);

    // ─── 2. Stream upload to S3 (matches your existing endpoints' pattern) ───
    const creds = resolveAwsCreds(credential_secret_prefix);
    if (!creds.accessKeyId || !creds.secretAccessKey) {
      throw new Error(`no AWS creds for prefix='${credential_secret_prefix}'`);
    }
    const s3 = new S3Client({ region, credentials: creds });
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: bucket,
        Key: output_key,
        Body: fs.createReadStream(tmpFile),
        ContentType: 'video/mp4',
      },
      partSize: 16 * 1024 * 1024,
      queueSize: 4,
    });
    await upload.done();
    console.log(`[hls-ingest] run=${hls_ingest_run_id} s3_uploaded key=${output_key}`);

    // ─── 3. Synchronous reply — worker is holding the connection ───
    return res.status(200).json({
      output_key,
      size_bytes: stat.size,
      remux_duration_ms: remuxDurationMs,
      hls_ingest_run_id,
      project_id,
    });
  } catch (err) {
    console.error(`[hls-ingest] run=${hls_ingest_run_id} FAILED:`, err.message);
    return res.status(500).json({
      error: 'hls_ingest_failed',
      message: String(err.message || err).slice(0, 1000),
      hls_ingest_run_id,
      project_id,
    });
  } finally {
    // ─── 4. ALWAYS clean up the tmp file. Disk fills up otherwise. ───
    try { await fsp.unlink(tmpFile); } catch { /* already gone */ }
  }
});
```

---

## 5. Dependencies

If your existing Railway service already uploads to S3 (e.g. for `/generate-proxy`), you already have `@aws-sdk/client-s3` and `@aws-sdk/lib-storage`. If not:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
```

Both `child_process`, `fs`, `path`, `os` are Node built-ins — no install needed.

ffmpeg must be on the Railway image. If your `Dockerfile` doesn't already `apt-get install -y ffmpeg`, add it.

---

## 6. End-to-end smoke test

After deploying, try one of these public test streams:

| Stream | Codecs | Use case |
|---|---|---|
| `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8` | H.264 + **AC-3** | Tests Dolby Digital path (omits `aac_adtstoasc`) |
| `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` | H.264 + **AAC** | Tests AAC path (includes `aac_adtstoasc`) |
| `https://bitmovin-a.akamaihd.net/content/MI201109210084_1/m3u8s/f08e80da-bf1d-4e3d-8899-f0f6155f6efa.m3u8` | H.264 + **AAC** | Bitmovin reference |

Watch the BullMQ worker logs on Railway — you should see:
```
[bullmq:hls-ingest] hls_ingest_phase_tick action=recall_function phase=codecs_validated
[bullmq:hls-ingest] hls_ingest_railway_dispatch
[hls-ingest] run=... start url=... audio=ac-3
[hls-ingest] run=... ffmpeg args: -y -hide_banner -loglevel warning -nostats -i ... -c copy -movflags +faststart /tmp/hls_...mp4
[hls-ingest] run=... ffmpeg_complete duration_ms=30000 size=...
[hls-ingest] run=... s3_uploaded key=...
[bullmq:hls-ingest] hls_ingest_complete
```

For the AAC stream the args line should include `-bsf:a aac_adtstoasc`. For AC-3 / E-AC-3 streams it must NOT.

Project status flips: `ingesting_hls` → `uploaded` → `scanning` → ready for transcription.

---

## 7. Audit posture (what you can say in TPN/SOC2)

> *"Our HLS-to-MP4 pipeline performs bit-faithful remux only — we never re-encode customer source content. We allowlist three audio codecs at the manifest gate: AAC (web-standard), AC-3 (Dolby Digital, broadcast standard per ETSI TS 102 366), and E-AC-3 (Dolby Digital Plus, streaming standard used by Netflix / Disney+ / HBO / Apple TV). All three are remuxed via ffmpeg `-c copy` — sample bytes for video and audio streams equal source HLS segment bytes. AAC streams additionally pass through the `aac_adtstoasc` bitstream filter (an ADTS → ASC framing reformat required for browser playback in MP4 — not a transcode). Codec strings outside this allowlist (HEVC, VP9, AV1, Opus, DTS, TrueHD, FLAC) are rejected at the manifest gate before any compute is spent."*

This is auditor-defensible. **Never silently add re-encoding flags** (e.g. `-c:v libx264`, `-c:a aac`) — that breaks the bit-faithful guarantee and the compliance control `hls_remux_pipeline (HLS-INGEST-002)` becomes false.

**Never apply `aac_adtstoasc` unconditionally** — running it against AC-3 / E-AC-3 audio will fail. The codec-conditional branch in `buildFfmpegArgs()` above is the audit-defensible way to handle the difference.