import { createHash } from 'node:crypto';
// Mirrors the backend revision encoding; parity is locked by regression tests.
export function refinementSourceRevision(rows: Array<{ id: string; updated_date?: string }>) {
  if (rows.some(row => !row.id || !row.updated_date)) throw new Error('refinement_source_revision_missing');
  const entries = rows.map(row => [String(row.id), String(row.updated_date)]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  if (new Set(entries.map(entry => entry[0])).size !== entries.length) throw new Error('refinement_source_duplicate_id');
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
