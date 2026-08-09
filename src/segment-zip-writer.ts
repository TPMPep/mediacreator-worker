import { open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); TABLE[n] = c >>> 0; }
function crc32(bytes: Uint8Array) { let c = 0xffffffff; for (const byte of bytes) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function safeName(value: string) { return String(value || 'segment.wav').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 180) || 'segment.wav'; }
function stamp(input?: Date) { const date = input && Number.isFinite(input.getTime()) ? input : new Date('1980-01-01T00:00:00.000Z'); const y = Math.max(1980, date.getUTCFullYear()); return { time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2), date: ((y - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate() }; }

export async function createSegmentZipWriter(exportJobId: string) {
  const path = join(tmpdir(), `mediacreator-segments-${exportJobId}-${randomUUID()}.zip`);
  const file = await open(path, 'w');
  const central: Array<{ name: Uint8Array; crc: number; size: number; offset: number; time: number; date: number }> = [];
  let offset = 0; let closed = false;
  const write = async (bytes: Uint8Array) => {
    let written = 0;
    while (written < bytes.byteLength) {
      const result = await file.write(bytes, written, bytes.byteLength - written, null);
      if (!result.bytesWritten) throw new Error('ZIP disk write stalled');
      written += result.bytesWritten;
    }
    offset += bytes.byteLength;
  };
  return {
    path,
    async add(filename: string, bytes: Uint8Array, modifiedAt?: Date) {
      if (closed) throw new Error('ZIP writer is closed');
      if (central.length >= 65_535 || bytes.byteLength > 0xffffffff) throw new Error('ZIP32 limit exceeded');
      const name = new TextEncoder().encode(safeName(filename));
      if (offset + 30 + name.length + bytes.byteLength > 0xffffffff) throw new Error('ZIP exceeds 4 GB ZIP32 limit');
      const t = stamp(modifiedAt); const localOffset = offset; const crc = crc32(bytes);
      const local = new Uint8Array(30); const v = new DataView(local.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true); v.setUint16(10, t.time, true); v.setUint16(12, t.date, true); v.setUint32(14, crc, true); v.setUint32(18, bytes.byteLength, true); v.setUint32(22, bytes.byteLength, true); v.setUint16(26, name.length, true);
      await write(local); await write(name); await write(bytes); central.push({ name, crc, size: bytes.byteLength, offset: localOffset, ...t });
    },
    async close() {
      if (closed) return { path, size: offset };
      const centralOffset = offset;
      for (const item of central) { const h = new Uint8Array(46); const v = new DataView(h.buffer); v.setUint32(0,0x02014b50,true); v.setUint16(4,20,true); v.setUint16(6,20,true); v.setUint16(8,0x0800,true); v.setUint16(10,0,true); v.setUint16(12,item.time,true); v.setUint16(14,item.date,true); v.setUint32(16,item.crc,true); v.setUint32(20,item.size,true); v.setUint32(24,item.size,true); v.setUint16(28,item.name.length,true); v.setUint32(42,item.offset,true); await write(h); await write(item.name); }
      const centralSize = offset - centralOffset; if (offset > 0xffffffff) throw new Error('ZIP exceeds 4 GB ZIP32 limit');
      const end = new Uint8Array(22); const v = new DataView(end.buffer); v.setUint32(0,0x06054b50,true); v.setUint16(8,central.length,true); v.setUint16(10,central.length,true); v.setUint32(12,centralSize,true); v.setUint32(16,centralOffset,true); await write(end); await file.sync(); await file.close(); closed = true; return { path, size: offset };
    },
    async cleanup() { if (!closed) await file.close().catch(() => {}); closed = true; await rm(path, { force: true }).catch(() => {}); },
  };
}
