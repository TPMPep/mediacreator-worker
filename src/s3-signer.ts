// =============================================================================
// s3-signer.ts — Zero-dependency WebCrypto SigV4 signer for the BullMQ worker.
// -----------------------------------------------------------------------------
// SHARED, single-source-of-truth S3 signer for the worker repo. Replaces the
// forbidden @aws-sdk/@smithy stack (incident 2026-07-07/08 — non-deterministic
// dependency poisoning in serverless runtimes). Byte-faithful port of
// base44/functions/_lib_storage's canonical WebCrypto SigV4 primitives, typed
// for ESM/TypeScript + Node 20 (global `crypto.subtle`, global `fetch`).
//
// DEFENSIVE STS SESSION-TOKEN SUPPORT (2026-07-10):
//   Long-lived AKIA credentials carry NO session token. Temporary ASIA
//   credentials (STS AssumeRole / instance-profile / OIDC) REQUIRE the session
//   token to be presented alongside the signature or S3 rejects the request
//   with 403. This signer threads it through BOTH request shapes:
//     • presigned URL  → X-Amz-Security-Token as a SIGNED query parameter
//     • header-signed   → x-amz-security-token as a SIGNED header
//   When no session token is present the behavior is IDENTICAL to before
//   (no token param, no token header) — a pure additive, back-compatible change.
//
// EXPORTS (only what export-project.ts needs):
//   • presignS3Url({ method, storage, key, expiresIn, extraQuery })  → string
//   • putS3Object(storage, key, body, opts)                          → { ok }
//   • storageFromEnv({ region, bucket, prefix })                     → handle
// =============================================================================

const _te = new TextEncoder();
function _hex(bytes: Uint8Array): string { let s = ''; for (const b of bytes) s += b.toString(16).padStart(2, '0'); return s; }
async function _sha256Hex(str: string): Promise<string> { return _hex(new Uint8Array(await crypto.subtle.digest('SHA-256', _te.encode(str)))); }
async function _hmac(keyBytes: Uint8Array, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes as unknown as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, _te.encode(msg)));
}
const _sigKeyCache = new Map<string, Uint8Array>();
async function _signingKey(secret: string, dateStamp: string, region: string): Promise<Uint8Array> {
  const ck = `${dateStamp}:${region}`;
  const cached = _sigKeyCache.get(ck);
  if (cached) return cached;
  let k = await _hmac(_te.encode('AWS4' + secret), dateStamp);
  k = await _hmac(k, region); k = await _hmac(k, 's3'); k = await _hmac(k, 'aws4_request');
  _sigKeyCache.set(ck, k); return k;
}
function _awsEncode(str: string): string { return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function _awsEncodePath(path: string): string { return path.split('/').map(_awsEncode).join('/'); }

export interface StorageCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
export interface StorageHandle {
  region: string;
  bucket: string;
  endpoint: string | null;
  creds: StorageCreds;
}

// ── Presign a GET (download) or PUT (upload) URL ────────────────────────────
// STS: when storage.creds.sessionToken is present it is added as a SIGNED
// X-Amz-Security-Token query param. When absent, the param is omitted entirely.
export async function presignS3Url(opts: {
  method: 'GET' | 'PUT';
  storage: StorageHandle;
  key: string;
  expiresIn?: number;
  extraQuery?: Record<string, string>;
}): Promise<string> {
  const { method, storage, key, expiresIn = 3600, extraQuery = {} } = opts;
  const { region, creds: { accessKeyId, secretAccessKey, sessionToken }, endpoint, bucket } = storage;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  let host: string, canonicalUri: string;
  if (endpoint) { host = new URL(endpoint).host; canonicalUri = `/${bucket}/${_awsEncodePath(key)}`; }
  else { host = `${bucket}.s3.${region}.amazonaws.com`; canonicalUri = `/${_awsEncodePath(key)}`; }
  const params: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  // STS temporary credentials: the security token is a SIGNED query param.
  if (sessionToken) params.push(['X-Amz-Security-Token', sessionToken]);
  for (const [k, v] of Object.entries(extraQuery)) params.push([k, v]);
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = params.map(([k, v]) => `${_awsEncode(k)}=${_awsEncode(v)}`).join('&');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await _sha256Hex(canonicalRequest)].join('\n');
  const signature = _hex(await _hmac(await _signingKey(secretAccessKey, dateStamp, region), stringToSign));
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ── Write an S3 object body — HEADER-signed PUT + native fetch ──────────────
// Content-Disposition (used by export deliverables) is threaded as a SIGNED
// header. STS: session token added as a SIGNED x-amz-security-token header.
export async function putS3Object(
  storage: StorageHandle,
  key: string,
  body: Uint8Array | string,
  opts: { contentType?: string; contentDisposition?: string; timeoutMs?: number } = {},
): Promise<{ ok: true; status: number }> {
  const { contentType, contentDisposition, timeoutMs = 120000 } = opts;
  const { region, creds: { accessKeyId, secretAccessKey, sessionToken }, endpoint, bucket } = storage;
  const bytes = typeof body === 'string' ? _te.encode(body) : body;
  const payloadHash = _hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  let host: string, canonicalUri: string;
  if (endpoint) { host = new URL(endpoint).host; canonicalUri = `/${bucket}/${_awsEncodePath(key)}`; }
  else { host = `${bucket}.s3.${region}.amazonaws.com`; canonicalUri = `/${_awsEncodePath(key)}`; }
  const headers: Record<string, string> = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  if (contentDisposition) headers['content-disposition'] = contentDisposition;
  // STS temporary credentials: the security token is a SIGNED header.
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;
  const sortedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = sortedHeaderKeys.join(';');
  const canonicalHeaders = sortedHeaderKeys.map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await _sha256Hex(canonicalRequest)].join('\n');
  const signature = _hex(await _hmac(await _signingKey(secretAccessKey, dateStamp, region), stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://${host}${canonicalUri}`, {
      method: 'PUT', headers: { ...headers, authorization }, body: bytes, signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`S3 PUT ${key} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return { ok: true, status: res.status };
  } finally { clearTimeout(t); }
}

// ── Credential resolution helper ────────────────────────────────────────────
// Resolve creds from env, honoring an optional profile prefix AND its
// prefix-scoped session token. Long-lived AKIA creds have no *_SESSION_TOKEN,
// so sessionToken resolves undefined and every downstream signer omits it.
function _resolveEnvCreds(prefix?: string): StorageCreds {
  if (prefix) {
    const accessKeyId = process.env[`${prefix}_ACCESS_KEY_ID`] || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env[`${prefix}_SECRET_ACCESS_KEY`] || process.env.AWS_SECRET_ACCESS_KEY;
    const sessionToken = process.env[`${prefix}_SESSION_TOKEN`] || process.env.AWS_SESSION_TOKEN || undefined;
    if (!accessKeyId || !secretAccessKey) throw new Error('Missing S3 credentials in worker env');
    return { accessKeyId, secretAccessKey, sessionToken };
  }
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN || undefined;
  if (!accessKeyId || !secretAccessKey) throw new Error('Missing S3 credentials in worker env');
  return { accessKeyId, secretAccessKey, sessionToken };
}

// Build a storage handle from env (worker's own creds, optionally a per-job
// credential prefix). `region`/`bucket` come from the job payload.
export function storageFromEnv(opts: { region: string; bucket: string; prefix?: string; endpoint?: string | null }): StorageHandle {
  const { region, bucket, prefix = '', endpoint = null } = opts;
  return { region, bucket, endpoint, creds: _resolveEnvCreds(prefix) };
}
