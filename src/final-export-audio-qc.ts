import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { putS3File, type StorageHandle } from './s3-signer.js';

export async function renderFinalQcExcerpt(input: string, output: string, timeMs: number) {
  const start = Math.max(0, timeMs / 1000 - 1.5).toFixed(3);
  const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', start, '-i', input, '-t', '3', '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'flac', output], { stdio: ['ignore', 'ignore', 'pipe'] });
  let message = '';
  child.stderr.on('data', chunk => { message = (message + chunk.toString()).slice(-1000); });
  const kill = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const exit = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    if (exit !== 0) throw new Error(`QC excerpt could not be rendered: ${message}`);
  } finally { clearTimeout(kill); }
}


// Scan the exact completed file on disk, never an intermediate mix or a browser preview.
// One streaming decode pass: memory is bounded even for four-hour WAV/MP4 exports.
export async function inspectFinalExport(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const output_sha256 = hash.digest('hex');
  const findings: Array<{ code: string; time_ms: number; severity: string; message: string }> = [];
  const decoder = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'info', '-i', path, '-map', '0:a:0', '-vn', '-af', 'ebur128=peak=true', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Attach before draining stdout: a fast decoder can close before iteration ends.
  const closed = new Promise<number | null>((resolve, reject) => { decoder.once('close', resolve); decoder.once('error', reject); });
  let stderr = '', failure: Error | null = null;
  decoder.on('error', error => { failure = error; });
  decoder.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-64000); });
  const kill = setTimeout(() => decoder.kill('SIGKILL'), 45 * 60 * 1000);
  let pending = Buffer.alloc(0), frames = 0, saturated = 0, longestFlat = 0, flatTimeMs = 0;
  const flat = [0, 0], prev = [0, 0], before = [0, 0];
  let impulseCount = 0, samplePeak = 0;
  try {
    for await (const chunk of decoder.stdout) {
      const bytes = Buffer.concat([pending, chunk as Buffer]);
      const usable = bytes.length - (bytes.length % 4);
      for (let i = 0; i < usable; i += 4) {
        for (let channel = 0; channel < 2; channel++) {
          const v = bytes.readInt16LE(i + channel * 2) / 32768;
          const abs = Math.abs(v);
          samplePeak = Math.max(samplePeak, abs);
          if (abs >= 32760 / 32768) { saturated++; flat[channel]++; if (flat[channel] > longestFlat) { longestFlat = flat[channel]; flatTimeMs = Math.round((frames - flat[channel] + 1) / 48); } }
          else flat[channel] = 0;
          // Only an isolated, near-full-scale one-sample impulse surrounded by
          // near-silence is automatically identified. Transients in speech/music
          // are not declared defects by an uncorroborated high-frequency peak.
          if (Math.abs(prev[channel]) > .8 && Math.abs(before[channel]) < .03 && abs < .03) {
            impulseCount++;
            if (findings.length < 20) findings.push({ code: 'isolated_impulse', time_ms: Math.round((frames - 1) / 48), severity: 'review', message: 'Isolated full-scale impulse; audition this point in the rendered file.' });
          }
          before[channel] = prev[channel]; prev[channel] = v;
        }
        frames++;
      }
      pending = bytes.subarray(usable);
    }
    const exit = await closed;
    if (failure || exit !== 0 || frames === 0 || pending.length) throw failure || new Error(`Final-file audio decode failed (exit ${exit}, frames ${frames})`);
  } finally { clearTimeout(kill); if (!decoder.killed && decoder.exitCode === null) decoder.kill('SIGKILL'); }
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const integrated = /\bI:\s*(-?[\d.]+)\s*LUFS/.exec(summary);
  const truePeak = /\bPeak:\s*(-?[\d.]+)\s*dBFS/.exec(summary);
  if (!integrated || !truePeak) throw new Error('Final-file loudness or true-peak measurement missing');
  const lufs = Number(integrated[1]), dbtp = Number(truePeak[1]);
  if (!Number.isFinite(lufs) || !Number.isFinite(dbtp)) throw new Error('Final-file loudness measurement invalid');
  if (longestFlat >= 8) findings.unshift({ code: 'sustained_full_scale', time_ms: flatTimeMs, severity: 'blocked', message: 'Sustained full-scale samples in the rendered audio; delivery refused.' });
  if (dbtp > -1) findings.push({ code: 'true_peak_review', time_ms: 0, severity: 'review', message: `True peak ${dbtp.toFixed(1)} dBTP exceeds the -1 dBTP review ceiling.` });
  const measurements = { decoded_duration_ms: Math.round(frames / 48), sample_peak_dbfs: samplePeak ? +(20 * Math.log10(samplePeak)).toFixed(2) : null, true_peak_dbtp: dbtp, integrated_lufs: lufs, full_scale_sample_count: saturated, longest_full_scale_run: longestFlat, isolated_impulse_count: impulseCount };
  return { output_sha256, policy_version: 1, status: findings.some(f => f.severity === 'blocked') ? 'blocked' : findings.length ? 'review' : 'pass', findings, measurements, analyzed_at: new Date().toISOString() };
}

export async function attachFinalQcPreviews(path: string, storage: StorageHandle, prefix: string, qc: Awaited<ReturnType<typeof inspectFinalExport>>) {
  const dir = await mkdtemp(join(tmpdir(), 'final-qc-previews-'));
  try {
    let count = 0;
    for (const finding of qc.findings) {
      if (finding.code !== 'isolated_impulse' && finding.code !== 'sustained_full_scale') continue;
      const excerpt = join(dir, `point-${count}.flac`);
      await renderFinalQcExcerpt(path, excerpt, finding.time_ms);
      const key = `${prefix}qc-preview/${String(count).padStart(2, '0')}.flac`;
      await putS3File(storage, key, excerpt, { contentType: 'audio/flac', timeoutMs: 60000 });
      (finding as typeof finding & { preview_key?: string }).preview_key = key;
      count++;
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
  return qc;
}
