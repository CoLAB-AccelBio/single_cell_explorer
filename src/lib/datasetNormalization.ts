import type { SingleCellDataset, Cell, ClusterInfo } from '@/types/singleCell';
import { matrixFromRecord } from '@/lib/expressionMatrix';

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}
function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
}
function id(value: unknown, field: string): number {
  const number = finite(value, field);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${field} must be a non-negative integer`);
  return number;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}
export function normalizeDataset(data: unknown): SingleCellDataset {
  const obj = object(data, 'Dataset');
  const ids = new Set<string>();
  const cells: Cell[] = array(obj.cells, 'cells').map((value, i) => {
    const c = object(value, `cells[${i}]`);
    const cellId = text(c.id, 'Cell ID');
    if (ids.has(cellId)) throw new Error(`Duplicate cell ID: ${cellId}`);
    ids.add(cellId);
    const metadata = c.metadata === undefined ? {} : object(c.metadata, 'Cell metadata');
    for (const value of Object.values(metadata)) {
      if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Metadata values must be strings or finite numbers');
    }
    return { id: cellId, x: finite(c.x, 'Cell x'), y: finite(c.y, 'Cell y'), cluster: id(c.cluster, 'Cell group'), metadata: metadata as Cell['metadata'] };
  });
  if (!cells.length) throw new Error('No cells found in this dataset');
  const counts = new Map<number, number>();
  cells.forEach(c => counts.set(c.cluster, (counts.get(c.cluster) ?? 0) + 1));
  const groupIds = new Set<number>();
  const clusters: ClusterInfo[] = array(obj.clusters, 'clusters').map((value, i) => {
    const c = object(value, `clusters[${i}]`);
    const groupId = id(c.id, 'Group ID');
    if (groupIds.has(groupId)) throw new Error(`Duplicate group ID: ${groupId}`);
    groupIds.add(groupId);
    return { id: groupId, name: text(c.name, 'Group name'), cellCount: counts.get(groupId) ?? 0, color: c.color === undefined ? `hsl(${i * 36 % 360}, 70%, 50%)` : text(c.color, 'Group color') };
  });
  for (const c of cells) if (!groupIds.has(c.cluster)) throw new Error(`Unknown group ${c.cluster} for cell ${c.id}`);
  const genes = array(obj.genes, 'genes').map(g => text(g, 'Gene'));
  if (new Set(genes).size !== genes.length) throw new Error('Duplicate gene names');
  const raw = obj.metadata === undefined ? {} : object(obj.metadata, 'metadata');
  const differentialExpression = array(obj.differentialExpression ?? [], 'differentialExpression').map(value => {
    const de = object(value, 'DE row');
    const gene = text(de.gene, 'DE gene');
    const cluster = typeof de.cluster === 'number' ? String(id(de.cluster, 'DE group')) : text(de.cluster, 'DE group');
    const groupId = Number(cluster.replace(/^Cl_/, ''));
    if (!groupIds.has(groupId)) throw new Error(`Unknown DE group: ${cluster}`);
    const pValue = finite(de.pValue, 'pValue'), pAdj = finite(de.pAdj, 'pAdj');
    if (pValue < 0 || pValue > 1 || pAdj < 0 || pAdj > 1) throw new Error('P-values must be between 0 and 1');
    return { gene, cluster, logFC: finite(de.logFC, 'logFC'), pValue, pAdj };
  });
  const expression = obj.expression === undefined ? undefined : matrixFromRecord(object(obj.expression, 'expression') as Record<string, Record<string, number>>, cells.map(c => c.id));
  if (expression?.genes.some(g => !genes.includes(g))) throw new Error('Expression contains an unknown gene');
  const checksum = (key: string) => {
    if (obj[key] === undefined) return undefined;
    if (typeof obj[key] !== 'string' || !/^[a-f0-9]{64}$/.test(obj[key] as string)) throw new Error(`Invalid ${key}`);
    return obj[key] as string;
  };
  return { cells, clusters, genes, differentialExpression, expression,
    expressionSha256: checksum('expressionSha256'), cellIdsSha256: checksum('cellIdsSha256'),
    metadata: { name: String(raw.name || 'Single-Cell Dataset'), description: String(raw.description || 'Single-cell dataset'), cellCount: cells.length, geneCount: genes.length, clusterCount: clusters.length,
      cellTypeCount: new Set(cells.map(c => c.metadata.cell_type).filter(Boolean)).size || clusters.length,
      organism: raw.organism ? String(raw.organism) : undefined, tissue: raw.tissue ? String(raw.tissue) : undefined, source: raw.source ? String(raw.source) : undefined },
    annotationOptions: [...new Set(cells.flatMap(c => Object.keys(c.metadata).filter(key => typeof c.metadata[key] === 'string')))] };
}