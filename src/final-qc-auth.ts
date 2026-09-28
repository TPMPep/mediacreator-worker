import { createHmac, randomUUID } from 'node:crypto';
import { env } from './env.js';

export function mintFinalQCWorkerJWT(actor: string, projectId: string, exportJobId: string) {
  if (!env.ENQUEUE_SECRET) throw new Error('Worker authorization unavailable');
  const now = Math.floor(Date.now() / 1000);
  const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url');
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ sub: actor, project_id: projectId, resource_id: exportJobId,
    fn: 'recoverFinalExportQC', iat: now, exp: now + 300, jti: randomUUID() });
  const signature = createHmac('sha256', env.ENQUEUE_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}
