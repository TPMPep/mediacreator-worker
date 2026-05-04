// =============================================================================
// REDIS — Shared ioredis connection for BullMQ.
// BullMQ requires a connection with maxRetriesPerRequest=null and
// enableReadyCheck=false. Reuse this single client across all queues/workers.
// =============================================================================

import IORedis from 'ioredis';
import { env } from './env.js';

let client: IORedis | null = null;

export function getRedis(): IORedis {
  if (client) return client;
  client = new IORedis(env.UPSTASH_REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Upstash recommends TLS for non-localhost; rediss:// URLs handle it.
    lazyConnect: false,
  });
  client.on('error', (err) => {
    console.error('[redis] connection error:', err.message);
  });
  return client;
}

export async function closeRedis() {
  if (!client) return;
  await client.quit().catch(() => {});
  client = null;
}