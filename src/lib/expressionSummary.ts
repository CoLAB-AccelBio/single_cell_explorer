import type { Cell, CellFilterState, SingleCellDataset } from '@/types/singleCell';

/** Detection uses >0.1 in the dataset's supplied expression units. */
export const DETECTION_THRESHOLD = 0.1;
export function summarizeExpression(values: number[]) {
  let sum = 0, detected = 0;
  for (const value of values) { sum += value; if (value > DETECTION_THRESHOLD) detected++; }
  return { meanExpression: values.length ? sum / values.length : 0,
    percentExpressing: values.length ? detected / values.length * 100 : 0 };
}
export function filterCells(cells: Cell[], filter?: CellFilterState): Cell[] {
  if (!filter) return cells;
  return cells.filter(cell => (!filter.selectedSamples.length || filter.selectedSamples.includes(String(cell.metadata.sample))) &&
    (!filter.selectedClusters.length || filter.selectedClusters.includes(cell.cluster)));
}
export function mergeCellGroups(dataset: SingleCellDataset, sources: number[], target: number, name: string): SingleCellDataset {
  if (!dataset.clusters.some(c => c.id === target) || sources.includes(target)) throw new Error('Invalid merge target');
  const cells = dataset.cells.map(cell => sources.includes(cell.cluster) || cell.cluster === target
    ? { ...cell, cluster: target, metadata: { ...cell.metadata, cell_type: name } } : cell);
  const clusters = dataset.clusters.filter(c => !sources.includes(c.id)).map(c => c.id === target
    ? { ...c, name, cellCount: cells.filter(cell => cell.cluster === target).length } : c);
  return { ...dataset, cells, clusters, differentialExpression: [], differentialExpressionInvalidated: true,
    metadata: { ...dataset.metadata, clusterCount: clusters.length, cellTypeCount: new Set(cells.map(c => c.metadata.cell_type).filter(Boolean)).size || clusters.length } };
}