import type { SingleCellDataset } from '@/types/singleCell';
const BUILTIN_CELLS = 'acddd2a7a862daf306ebaab542dad22b13e2b450b4ee31ddfd36eef3f538b1a1';
const BUILTIN_EXPRESSION = '3ab8a17a4888c59db4ac4e9bc038b2a52fc195f6d1daed4334a156b60d2585de';
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function verifyCellOrder(core: SingleCellDataset, builtIn: boolean): Promise<string> {
  const actual = await sha256(new TextEncoder().encode(JSON.stringify(core.cells.map(c => c.id))));
  if (core.expressionSha256 && core.cellIdsSha256) {
    if (actual !== core.cellIdsSha256) throw new Error('Dataset cell-order fingerprint does not match its core');
    return core.expressionSha256;
  }
  if (builtIn && actual === BUILTIN_CELLS) return BUILTIN_EXPRESSION;
  throw new Error('Cannot verify this core/expression pair. Regenerate both split files with scripts/compress_dataset.py.');
}
export async function verifyExpressionBytes(bytes: Uint8Array, expected?: string) {
  if (!expected || await sha256(bytes) !== expected) throw new Error('Expression checksum does not match the core dataset. Use matching split files.');
}