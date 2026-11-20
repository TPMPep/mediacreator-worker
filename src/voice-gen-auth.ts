import { createHmac, randomUUID } from 'node:crypto';
import { env } from './env.js';

// Scoped authorization for ONE generateOneSegment call, minted at the moment the
// job starts (and again on every retry). The voice-gen queue admits one start per
// 5 seconds for the whole platform, so a line can wait far longer than 15 minutes
// behind other lines; a token minted when the line was dispatched expired in the
// queue and the line was refused (run 6b004265741801adf70bb197: 137 of 321 lines).
// Same claims and 15-minute life as before: one person, one job, one line, one function.
export function mintVoiceGenSegmentJWT(userEmail: string, projectId: string, translationId: string) {
  if (!env.ENQUEUE_SECRET) throw new Error('Worker authorization unavailable');
  const now = Math.floor(Date.now() / 1000);
  const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url');
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ sub: userEmail, project_id: projectId, resource_id: translationId,
    fn: 'generateOneSegment', iat: now, exp: now + 900, jti: randomUUID() });
  const signature = createHmac('sha256', env.ENQUEUE_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}
