import { act, renderHook, waitFor, render, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useDatasetLoading } from '@/hooks/useDatasetLoading';
import { PathwayEnrichment } from '@/components/analysis/PathwayEnrichment';
import { ScatterPlot } from '@/components/scatter/ScatterPlot';
import { matrixFromRecord } from '@/lib/expressionMatrix';
import type { SingleCellDataset } from '@/types/singleCell';
vi.mock('@/lib/datasetLoader', () => ({ fetchCoreDataset: vi.fn(), fetchExpressionMatrix: vi.fn() }));
import { fetchCoreDataset, fetchExpressionMatrix } from '@/lib/datasetLoader';
const core: SingleCellDataset = { metadata: { name: 'test', description: '', cellCount: 1, geneCount: 1, clusterCount: 1, cellTypeCount: 1 },
  cells: [{ id: 'c1', x: 0, y: 0, cluster: 8, metadata: { cell_type: 'Original' } }], genes: ['G'], clusters: [{ id: 8, name: 'Original', color: '#ff0000', cellCount: 1 }], differentialExpression: [] };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('loading lifecycle', () => {
  it('expression retry preserves edited annotations and fetches core only once', async () => {
    vi.mocked(fetchCoreDataset).mockResolvedValue(core);
    vi.mocked(fetchExpressionMatrix).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(matrixFromRecord({ G: { c1: 4 } }, ['c1']));
    const { result } = renderHook(() => useDatasetLoading(core));
    await waitFor(() => expect(result.current.errorScope).toBe('expression'));
    act(() => result.current.setDataset(prev => ({ ...prev, clusters: prev.clusters.map(c => ({ ...c, name: 'Edited' })) })));
    act(() => result.current.handleRetryExpression());
    await waitFor(() => expect(result.current.exprReady).toBe(true));
    expect(result.current.dataset.clusters[0].name).toBe('Edited');
    expect(result.current.dataset.expression?.getValues('G')?.[0]).toBe(4);
    expect(fetchCoreDataset).toHaveBeenCalledTimes(1);
  });
  it('discards enrichment requests when their input genes change', async () => {
    vi.useFakeTimers();
    const view = render(<PathwayEnrichment genes={['MYH7']} />);
    fireEvent.click(view.getByRole('button', { name: 'Run Enrichment' }));
    view.rerender(<PathwayEnrichment genes={['ATP1']} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    // No result links from the old request may survive an input change.
    expect(view.queryAllByRole('link').length).toBe(0);
    expect(view.getByRole('button', { name: 'Run Enrichment' })).toBeEnabled();
  });
  it('redraws annotation colors without changing cells or panning', () => {
    const fills: string[] = [];
    const ctx = { fillStyle: '', strokeStyle: '', fillRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: () => fills.push(ctx.fillStyle), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillText: vi.fn(), save: vi.fn(), translate: vi.fn(), rotate: vi.fn(), restore: vi.fn(), setLineDash: vi.fn() };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const props = { cells: core.cells, selectedGene: null, pointSize: 2, showClusters: true, showLabels: false, opacity: 1, clusterNames: { 8: 'Original' } };
    const view = render(<ScatterPlot {...props} annotationData={{ values: ['a'], colorMap: { a: '#ff0000' }, getCellValue: () => 'a' }} />);
    expect(fills.at(-1)).toBe('rgba(255, 0, 0, 1)');
    view.rerender(<ScatterPlot {...props} annotationData={{ values: ['b'], colorMap: { b: '#00ff00' }, getCellValue: () => 'b' }} />);
    expect(fills.at(-1)).toBe('rgba(0, 255, 0, 1)');
  });
});