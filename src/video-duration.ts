import { spawn } from 'node:child_process';
export interface VideoMeasurement { duration_ms: number; frame_count: number }
// Stream metadata, not container/audio length; no decode or full-file buffering.
export function parseVideoMeasurement(probe: any): VideoMeasurement {
  const video = probe?.streams?.find((stream: any) => stream.codec_type === 'video');
  const duration = Number(video?.duration) * 1000, frames = Number(video?.nb_frames);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 14401000 || !Number.isSafeInteger(frames) || frames <= 0)
    throw new Error('video_duration_unverified: video stream duration/frame count unavailable');
  return { duration_ms: Math.round(duration), frame_count: frames };
}
export function assertFullVideo(source: VideoMeasurement, output: VideoMeasurement) {
  if (source.frame_count !== output.frame_count || Math.abs(source.duration_ms - output.duration_ms) > 2)
    throw new Error(`video_duration_mismatch: source ${source.duration_ms}ms/${source.frame_count} frames, output ${output.duration_ms}ms/${output.frame_count} frames; incomplete MP4 refused`);
}
export async function prepareVideoExport(railwayUrl: string, videoUrl: string) {
  if (!videoUrl) throw new Error('Source video URL missing');
  const response = await fetch(`${railwayUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(10000) });
  const health = await response.json() as { video_duration_contract?: number };
  if (!response.ok || health.video_duration_contract !== 1)
    throw new Error('video_duration_unverified: deploy the updated audio renderer before exporting MP4');
  return probeVideo(videoUrl);
}
export async function probeVideo(input: string): Promise<VideoMeasurement> {
  const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type,duration,nb_frames', '-of', 'json', input], { stdio: ['ignore', 'pipe', 'ignore'] });
  return await new Promise((resolve, reject) => {
    let stdout = '', settled = false;
    const finish = (error?: Error, result?: VideoMeasurement) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result!); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Video metadata probe timed out')); }, 60000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 64000) { child.kill('SIGKILL'); finish(new Error('Video metadata exceeds diagnostic bound')); } });
    child.once('error', () => finish(new Error('Video metadata probe unavailable')));
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new Error('Video metadata probe failed'));
      try { finish(undefined, parseVideoMeasurement(JSON.parse(stdout))); } catch (error) { finish(error as Error); }
    });
  });
}
