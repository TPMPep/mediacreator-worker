import { UnrecoverableError } from 'bullmq';

const TERMINAL_KINDS = new Set(['ffmpeg_error', 'oom', 'spawn_failed']);

export function buildRailwayRenderError(label: string, status: number, body: string): Error {
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(body) as Record<string, unknown>; } catch { /* retain raw body */ }

  const kind = typeof payload.kind === 'string' ? payload.kind : 'unknown';
  const detail = typeof payload.detail === 'string' ? payload.detail : '';
  const stderr = typeof payload.stderr_tail === 'string' ? payload.stderr_tail.trim() : '';
  const summary = typeof payload.error === 'string' ? payload.error : body;
  const evidence = [detail || summary, stderr ? `FFmpeg tail:\n${stderr.slice(-2000)}` : '']
    .filter(Boolean).join('\n');
  const message = `${label} failed (${status}, ${kind}): ${evidence}`.slice(0, 4000);

  const retryableHttp = status === 408 || status === 429 || status >= 500;
  const terminal = TERMINAL_KINDS.has(kind) || (!retryableHttp && status >= 400);
  return terminal ? new UnrecoverableError(message) : new Error(message);
}
