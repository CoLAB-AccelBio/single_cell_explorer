import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { encode } from '@msgpack/msgpack';
import { normalizeDataset, fetchCoreDataset, fetchExpressionMatrix, clearDatasetCaches } from '@/lib/datasetLoader';
import { addUploadedDataset, addRemoteSource, setActiveSourceId, getActiveSource, listDatasetSources, isDatasetStorageUnavailable } from '@/lib/datasetRegistry';
import { parseSparseExpression } from '@/lib/msgpackSparse';
import { SparseExpressionMatrix, matrixFromRecord } from '@/lib/expressionMatrix';
import { verifyCellOrder, verifyExpressionBytes, sha256 } from '@/lib/datasetIdentity';
import { streamFetchBytes } from '@/lib/fetchStream';
import { summarizeExpression, filterCells, mergeCellGroups } from '@/lib/expressionSummary';
import { parseColorToRGBA } from '@/lib/scatterColors';
import { rasterDimensions, embeddedRasterSvg } from '@/lib/rasterExport';
import { calculatePseudotime } from '@/components/analysis/TrajectoryAnalysis';
import { buildHeatmapData } from '@/components/analysis/PseudotimeHeatmap';
import { webcrypto } from 'node:crypto';

export const fixture = () => ({
  metadata: { name: 'Repair fixture' },
  cells: [
    { id: 'c1', x: -1, y: -1, cluster: 2, metadata: { cell_type: 'A', sample: 'one' } },
    { id: 'c2', x: 1, y: 1, cluster: 8, metadata: { cell_type: 'B', sample: 'two' } },
  ],
  genes: ['G'], clusters: [{ id: 2, name: 'A', color: '#ff0000' }, { id: 8, name: 'B', color: '#00ff00' }],
  expression: { G: { c1: 0.2, c2: 4 } },
  differentialExpression: [{ gene: 'G', cluster: 'Cl_2', logFC: 2, pValue: 0.01, pAdj: 0.02 }],
});
class ControlledWorker {
  static instances: ControlledWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { message: string }) => void;
  request?: { type: string; url: string };
  terminated = false;
  constructor() { ControlledWorker.instances.push(this); }
  postMessage(request: { type: string; url: string }) { this.request = request; }
  terminate() { this.terminated = true; }
  send(data: unknown) { this.onmessage?.({ data }); }
}
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
beforeEach(() => { clearDatasetCaches(); vi.stubGlobal('crypto', webcrypto); ControlledWorker.instances = []; });
afterEach(() => { clearDatasetCaches(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('dataset identities and loading', () => {
  it('loads selected session uploads with exact measurements', async () => {
    const source = addUploadedDataset('test', normalizeDataset(fixture()));
    setActiveSourceId(source.id);
    expect(getActiveSource().id).toBe(source.id);
    const core = await fetchCoreDataset();
    const matrix = await fetchExpressionMatrix(core.cells.map(c => c.id));
    expect(core.cells.map(c => c.id)).toEqual(['c1', 'c2']);
    expect(matrix.getValues('G')?.[1]).toBe(4);
  });
  it('rejects expression reads with a different cell order', async () => {
    const source = addUploadedDataset('test', normalizeDataset(fixture())); setActiveSourceId(source.id);
    await fetchCoreDataset();
    await expect(fetchExpressionMatrix(['c2', 'c1'])).rejects.toThrow('cell order');
  });
  it('old completion cannot overwrite a newer selected source', async () => {
    vi.stubGlobal('Worker', ControlledWorker);
    const a = addRemoteSource({ name: 'A', coreUrl: 'https://a/core' }); setActiveSourceId(a.id);
    const pendingA = fetchCoreDataset().catch(e => e); await tick();
    const b = addRemoteSource({ name: 'B', coreUrl: 'https://b/core' }); setActiveSourceId(b.id);
    const pendingB = fetchCoreDataset(); await tick();
    const dataB = fixture(); dataB.cells[0].id = 'b1'; delete (dataB as { expression?: unknown }).expression;
    ControlledWorker.instances[1].send({ type: 'core-done', data: dataB }); await pendingB;
    ControlledWorker.instances[0].send({ type: 'core-done', data: fixture() }); await pendingA;
    expect((await fetchCoreDataset()).cells[0].id).toBe('b1');
    expect(ControlledWorker.instances[0].terminated).toBe(true);
  });
  it('one consumer cancellation does not cancel another and progress reaches both', async () => {
    vi.stubGlobal('Worker', ControlledWorker);
    const source = addRemoteSource({ name: 'A', coreUrl: 'https://a/core' }); setActiveSourceId(source.id);
    const controller = new AbortController(), p1 = vi.fn(), p2 = vi.fn();
    const first = fetchCoreDataset(p1, controller.signal).catch(e => e);
    const second = fetchCoreDataset(p2); await tick();
    ControlledWorker.instances[0].send({ type: 'progress', phase: 'downloading', percent: 20, message: '20' });
    expect(p1).toHaveBeenCalled(); expect(p2).toHaveBeenCalled();
    controller.abort(); expect(ControlledWorker.instances[0].terminated).toBe(false);
    ControlledWorker.instances[0].send({ type: 'core-done', data: fixture() });
    expect((await first).name).toBe('AbortError'); expect((await second).cells.length).toBe(2);
  });
  it('cancels the initial core worker and can resume', async () => {
    vi.stubGlobal('Worker', ControlledWorker);
    const source = addRemoteSource({ name: 'A', coreUrl: 'https://a/core' }); setActiveSourceId(source.id);
    const controller = new AbortController(); const pending = fetchCoreDataset(undefined, controller.signal).catch(e => e);
    await tick(); controller.abort(); expect((await pending).name).toBe('AbortError');
    expect(ControlledWorker.instances[0].terminated).toBe(true);
    const resumed = fetchCoreDataset(); await tick();
    ControlledWorker.instances[1].send({ type: 'core-done', data: fixture() }); expect((await resumed).cells.length).toBe(2);
  });
  it('worker data errors fail once without downloading again on the main thread', async () => {
    vi.stubGlobal('Worker', ControlledWorker); const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const source = addRemoteSource({ name: 'A', coreUrl: 'https://a/core' }); setActiveSourceId(source.id);
    const pending = fetchCoreDataset().catch(e => e); await tick();
    ControlledWorker.instances[0].send({ type: 'error', message: 'Invalid dataset' });
    expect((await pending).message).toBe('Invalid dataset'); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('worker construction failure uses the browser fallback', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('not supported'); } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => fixture() }); vi.stubGlobal('fetch', fetchMock);
    const source = addRemoteSource({ name: 'A', coreUrl: 'https://a/core' }); setActiveSourceId(source.id);
    expect((await fetchCoreDataset()).cells.length).toBe(2); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('retains sources and selection when storage is full', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    const source = addRemoteSource({ name: 'Session', coreUrl: 'https://test/core' }); setActiveSourceId(source.id);
    expect(listDatasetSources().some(s => s.id === source.id)).toBe(true);
    expect(getActiveSource().id).toBe(source.id); expect(isDatasetStorageUnavailable()).toBe(true);
  });
  it('accepts matching checksums and rejects reordered cells and wrong matrices', async () => {
    const core = normalizeDataset(fixture()); const bytes = encode({ G: [[0, 1]] });
    core.cellIdsSha256 = await sha256(new TextEncoder().encode(JSON.stringify(['c1', 'c2'])));
    core.expressionSha256 = await sha256(bytes);
    expect(await verifyCellOrder(core, false)).toBe(core.expressionSha256);
    await verifyExpressionBytes(bytes, core.expressionSha256);
    await expect(verifyExpressionBytes(encode({ G: [[0, 2]] }), core.expressionSha256)).rejects.toThrow('checksum');
    core.cells.reverse(); await expect(verifyCellOrder(core, false)).rejects.toThrow('fingerprint');
  });
});

describe('input validation', () => {
  it.each([
    ['missing cell fields', () => ({ ...fixture(), cells: [{}] })],
    ['null coordinates', () => ({ ...fixture(), cells: [{ ...fixture().cells[0], x: null }] })],
    ['duplicate IDs', () => ({ ...fixture(), cells: [fixture().cells[0], fixture().cells[0]] })],
    ['unknown groups', () => ({ ...fixture(), cells: [{ ...fixture().cells[0], cluster: 99 }] })],
    ['invalid genes', () => ({ ...fixture(), genes: [1] })],
    ['null expression', () => ({ ...fixture(), expression: { G: { c1: null } } })],
  ])('rejects %s', (_, make) => { expect(() => normalizeDataset(make())).toThrow(); });
  it.each([[[0.9, 1]], [[-1, 1]], [[2, 1]], [[0, null]], [[0, Infinity]], [[0, 1, 2]], [[0]], [[0, 1], [0, 2]]])('rejects malformed sparse data %j', (...pairs) => {
    expect(() => parseSparseExpression(encode({ G: pairs }), undefined, 2)).toThrow();
  });
  it('valid boundary indices expand exactly', () => {
    const data = parseSparseExpression(encode({ G: [[0, 2], [1, 4]] }), undefined, 2);
    expect([...new SparseExpressionMatrix(data, ['c1', 'c2']).getValues('G') ?? []]).toEqual([2, 4]);
  });
  it('rejects out-of-range matrix and unknown expression cells', () => {
    expect(() => new SparseExpressionMatrix(new Map([['G', { indices: new Int32Array([2]), values: new Float32Array([1]) }]]), ['c1'])).toThrow();
    expect(() => matrixFromRecord({ G: { unknown: 1 } }, ['c1'])).toThrow('unknown cell');
  });
});

describe('binary lengths', () => {
  it.each([7, 0, 5, 10])('returns exact bytes with advertised length %s', async length => {
    let i = 0; const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, headers: { get: () => String(length) }, body: { getReader: () => ({ read: async () => i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }, cancel: async () => {} }) } }));
    expect([...await streamFetchBytes('https://test', undefined, () => {})]).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
describe('scientific summaries and edits', () => {
  it('includes zeros in the mean', () => { expect(summarizeExpression([0, 0, 0, 4]).meanExpression).toBe(1); });
  it('uses the same >0.1 detection rule', () => { expect(summarizeExpression([0.2, 0.2]).percentExpressing).toBe(100); expect(summarizeExpression([0.1]).percentExpressing).toBe(0); });
  it('restricts the summary population by sample and group', () => { expect(filterCells(normalizeDataset(fixture()).cells, { selectedSamples: ['one'], selectedClusters: [2] }).map(c => c.id)).toEqual(['c1']); });
  it('merges both groups labels and invalidates all imported DE statistics', () => {
    const merged = mergeCellGroups(normalizeDataset(fixture()), [2], 8, 'Merged');
    expect(merged.cells.map(c => c.cluster)).toEqual([8, 8]); expect(merged.cells.map(c => c.metadata.cell_type)).toEqual(['Merged', 'Merged']);
    expect(merged.clusters.map(c => [c.id, c.cellCount])).toEqual([[8, 2]]); expect(merged.differentialExpression).toEqual([]); expect(merged.differentialExpressionInvalidated).toBe(true);
  });
  it('supports hex, RGB and HSL annotation colors', () => {
    expect(parseColorToRGBA('#f00')).toEqual([255, 0, 0, 255]); expect(parseColorToRGBA('#00ff00')).toEqual([0, 255, 0, 255]);
    expect(parseColorToRGBA('rgb(255, 0, 0)')).toEqual([255, 0, 0, 255]); expect(parseColorToRGBA('hsl(0, 100%, 50%)')).toEqual([255, 0, 0, 255]);
  });
  it('exports explicitly raster content with exact enlarged dimensions', () => {
    expect(rasterDimensions(600, 450, 2)).toEqual({ width: 1200, height: 900 });
    const svg = embeddedRasterSvg(600, 450, 'data:image/png;base64,AA'); expect(svg).toContain('<image'); expect(svg).not.toContain('<circle');
  });
  it('handles singleton and large embedding scores without noise or NaN', () => {
    const cell = normalizeDataset(fixture()).cells[0]; expect(calculatePseudotime([cell], 2).get('c1')).toBe(0);
    const many = Array.from({ length: 200000 }, (_, i) => ({ ...cell, id: String(i), x: i }));
    expect(calculatePseudotime(many, 2).size).toBe(200000);
    expect(calculatePseudotime([cell], 2).get('c1')).toBe(0);
  });
  it('bins two cells into at most two nonempty rank bins', () => {
    const cells = normalizeDataset(fixture()).cells;
    const result = buildHeatmapData(cells, ['G'], { G: new Map([['c1', 0], ['c2', 4]]) }, new Map([['c1', 0], ['c2', 1]]), 50);
    expect(result.rows[0].values).toEqual([0, 1]);
  });
});