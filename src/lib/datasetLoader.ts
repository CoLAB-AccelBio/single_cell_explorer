import { ExpressionMatrix, SingleCellDataset } from "@/types/singleCell";
import { parseSparseExpression, SparseGene } from "@/lib/msgpackSparse";
import { SparseExpressionMatrix } from "@/lib/expressionMatrix";
import { startPhase, getPeakHeapMB, trackHeap } from "@/lib/perf";
import {
  getActiveSource,
  getUploadedDataset,
  BUILT_IN_SOURCE,
} from "@/lib/datasetRegistry";
import { fetchJsonWithFallback, streamFetchBytes } from "@/lib/fetchStream";
import type { WorkerRequest, WorkerResponse } from "@/workers/datasetWorker";

export interface LoadProgress {
  phase: "downloading" | "parsing" | "done" | "error";
  percent: number;
  message: string;
}


export { normalizeDataset } from '@/lib/datasetNormalization';
import { normalizeDataset } from '@/lib/datasetNormalization';
import type { DatasetSource } from '@/lib/datasetRegistry';
import { verifyCellOrder } from '@/lib/datasetIdentity';

// ---------------------------------------------------------------------------
// Caching (per active dataset source)
// ---------------------------------------------------------------------------
interface Pending<T> {
  promise: Promise<T>;
  controller: AbortController;
  listeners: Set<(p: LoadProgress) => void>;
  consumers: number;
}
interface Cache {
  source: DatasetSource;
  generation: number;
  core?: SingleCellDataset;
  expression?: ExpressionMatrix;
  corePending?: Pending<SingleCellDataset>;
  expressionPending?: Pending<ExpressionMatrix>;
}
let generation = 0;
let cache: Cache | null = null;
function activeCache(): Cache {
  const source = getActiveSource();
  if (!cache || cache.source.id !== source.id) {
    clearDatasetCaches();
    cache = { source: { ...source }, generation };
  }
  return cache;
}
export function clearDatasetCaches() {
  generation++;
  cache?.corePending?.controller.abort();
  cache?.expressionPending?.controller.abort();
  cache = null;
}
function consume<T>(pending: Pending<T>, onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<T> {
  pending.consumers++;
  if (onProgress) pending.listeners.add(onProgress);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (onProgress) pending.listeners.delete(onProgress);
      pending.consumers--;
      return true;
    };
    const abort = () => {
      if (!finish()) return;
      if (!pending.consumers) pending.controller.abort();
      reject(new DOMException('Download cancelled', 'AbortError'));
    };
    pending.promise.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  });
}
function startPending<T>(load: (progress: (p: LoadProgress) => void, signal: AbortSignal) => Promise<T>): Pending<T> {
  const controller = new AbortController();
  const listeners = new Set<(p: LoadProgress) => void>();
  const promise = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
    return load(p => listeners.forEach(listener => listener(p)), controller.signal);
  });
  return { promise, controller, listeners, consumers: 0 };
}
export function fetchCoreDataset(onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<SingleCellDataset> {
  const entry = activeCache();
  if (entry.core) return signal?.aborted ? Promise.reject(new DOMException('Download cancelled', 'AbortError')) : Promise.resolve(entry.core);
  if (!entry.corePending || entry.corePending.controller.signal.aborted) {
    const pending = startPending((progress, abort) => loadCoreDataset(entry.source, progress, abort));
    entry.corePending = pending;
    pending.promise.then(core => {
      if (cache === entry && generation === entry.generation && entry.corePending === pending && !pending.controller.signal.aborted) {
        entry.core = core;
        entry.expression = core.expression;
      }
    }, () => {}).finally(() => { if (entry.corePending === pending) entry.corePending = undefined; });
  }
  return consume(entry.corePending, onProgress, signal);
}
export function fetchExpressionMatrix(cellIds: string[], onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<ExpressionMatrix> {
  const entry = activeCache();
  if (!entry.core || entry.core.cells.length !== cellIds.length || entry.core.cells.some((cell, i) => cell.id !== cellIds[i])) {
    return Promise.reject(new Error('Core and expression cell order do not match the selected dataset'));
  }
  if (entry.expression) return signal?.aborted ? Promise.reject(new DOMException('Download cancelled', 'AbortError')) : Promise.resolve(entry.expression);
  if (!entry.expressionPending || entry.expressionPending.controller.signal.aborted) {
    const core = entry.core;
    const pending = startPending((progress, abort) => loadExpressionMatrix(entry.source, core, cellIds, progress, abort));
    entry.expressionPending = pending;
    pending.promise.then(expression => {
      if (cache === entry && generation === entry.generation && entry.expressionPending === pending && !pending.controller.signal.aborted) entry.expression = expression;
    }, () => {}).finally(() => { if (entry.expressionPending === pending) entry.expressionPending = undefined; });
  }
  return consume(entry.expressionPending, onProgress, signal);
}
export function isExpressionMatrixLoaded(): boolean { return !!activeCache().expression; }
export async function fetchRemoteDataset(onProgress?: (p: LoadProgress) => void): Promise<SingleCellDataset> {
  const core = await fetchCoreDataset(onProgress);
  const expression = await fetchExpressionMatrix(core.cells.map(c => c.id), onProgress);
  return { ...core, expression };
}

// ---------------------------------------------------------------------------
// Worker plumbing
// ---------------------------------------------------------------------------
/**
 * Runs one worker request (core or expression) and resolves with the worker's
 * terminal message. The worker is created per request and terminated after,
 * so cancelling a huge download frees its memory immediately.
 */
class WorkerUnavailableError extends Error {}

function runInWorker(
  request: WorkerRequest,
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal
): Promise<Extract<WorkerResponse, { type: "core-done" | "expression-done" }>> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("../workers/datasetWorker.ts", import.meta.url), {
        type: "module",
      });
    } catch (e) {
      reject(new WorkerUnavailableError(String(e)));
      return;
    }

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };

    function onAbort() {
      cleanup();
      reject(new DOMException("Download cancelled", "AbortError"));
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.type === "progress") {
        trackHeap();
        onProgress?.({ phase: msg.phase, percent: msg.percent, message: msg.message });
        return;
      }
      if (msg.type === "error") {
        cleanup();
        reject(new Error(msg.message));
        return;
      }
      cleanup();
      resolve(msg);
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new WorkerUnavailableError(event.message || "Dataset worker failed"));
    };

    worker.postMessage(request);
  });
}

// ---------------------------------------------------------------------------
// Core dataset
// ---------------------------------------------------------------------------
async function loadCoreDataset(
  source: DatasetSource,
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal
): Promise<SingleCellDataset> {
  onProgress?.({ phase: "downloading", percent: 0, message: "Loading core data…" });
  const endPhase = startPhase("core dataset load");

  // Uploaded datasets are already parsed and live in memory.
  if (source.kind === "uploaded") {
    const uploaded = getUploadedDataset(source.id);
    if (!uploaded) {
      throw new Error(
        "The uploaded dataset is no longer in memory (uploads are session-only). Upload it again from the Dataset Swap page."
      );
    }
    endPhase({ cells: uploaded.cells.length, genes: uploaded.genes.length });
    onProgress?.({ phase: "done", percent: 100, message: "Uploaded dataset ready" });
    return uploaded;
  }

  const coreUrl = source.coreUrl ?? BUILT_IN_SOURCE.coreUrl;
  if (!coreUrl) throw new Error("No core dataset URL configured");
  const localCoreUrl = source.localCoreUrl;

  let coreData: unknown;
  try {
    const msg = await runInWorker(
      { type: "core", url: coreUrl, localUrl: localCoreUrl },
      onProgress,
      signal
    );
    if (msg.type !== "core-done") throw new Error("Unexpected worker response");
    coreData = msg.data;
  } catch (e) {
    if (!(e instanceof WorkerUnavailableError)) throw e;
    // Workers unavailable (or blocked): fall back to the main thread.
    console.warn("Dataset worker unavailable, loading core data on main thread:", e);
    coreData = await fetchJsonWithFallback(coreUrl, localCoreUrl, signal);
  }

  const dataset = normalizeDataset(coreData);


  endPhase({ cells: dataset.cells.length, genes: dataset.genes.length });
  onProgress?.({ phase: "done", percent: 100, message: "Core data loaded" });
  return dataset;
}

// ---------------------------------------------------------------------------
// Expression matrix
// ---------------------------------------------------------------------------
async function loadExpressionMatrix(
  source: DatasetSource,
  core: SingleCellDataset,
  cellIds: string[],
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal
): Promise<ExpressionMatrix> {
  if (source.kind === "uploaded") {
    const uploaded = getUploadedDataset(source.id);
    const matrix = uploaded?.expression;
    if (!matrix) throw new Error("The uploaded dataset contains no expression measurements");
    onProgress?.({ phase: "done", percent: 100, message: "Expression matrix ready" });
    return matrix;
  }

  const exprUrl = source.exprUrl;
  if (!exprUrl) {
    throw new Error(
      `No expression matrix URL is configured for "${source.name}". Add one on the Dataset Swap page.`
    );
  }

  onProgress?.({
    phase: "downloading",
    percent: 0,
    message: "Downloading expression matrix…",
  });

  const expectedSha256 = await verifyCellOrder(core, source.kind === "built-in");
  const endPhase = startPhase("expression matrix (worker)");
  let sparse: Map<string, SparseGene>;

  try {
    const msg = await runInWorker(
      { type: "expression", url: exprUrl, localUrl: source.localExprUrl, expectedSha256, cellCount: cellIds.length },
      onProgress,
      signal
    );
    if (msg.type !== "expression-done") throw new Error("Unexpected worker response");
    sparse = new Map<string, SparseGene>();
    for (let i = 0; i < msg.genes.length; i++) {
      sparse.set(msg.genes[i], { indices: msg.indices[i], values: msg.values[i] });
    }
    endPhase({
      genes: sparse.size,
      bytes: msg.bytes,
      decodeMs: Math.round(msg.decodeMs),
      peakHeapMB: Number(getPeakHeapMB().toFixed(1)),
    });
  } catch (e) {
    if (!(e instanceof WorkerUnavailableError)) throw e;
    console.warn("Dataset worker unavailable, decoding expression on main thread:", e);
    sparse = await loadExpressionOnMainThread(
      exprUrl,
      source.localExprUrl,
      onProgress,
      signal,
      expectedSha256,
      cellIds.length
    );
    endPhase({ genes: sparse.size, peakHeapMB: Number(getPeakHeapMB().toFixed(1)) });
  }

  const matrix = new SparseExpressionMatrix(sparse, cellIds);
  onProgress?.({ phase: "done", percent: 100, message: "Expression matrix ready" });
  return matrix;
}

/** Fallback path for browsers without module workers. */
async function loadExpressionOnMainThread(
  exprUrl: string,
  localExprUrl: string | undefined,
  onProgress?: (p: LoadProgress) => void,
  signal?: AbortSignal,
  expectedSha256?: string,
  cellCount?: number
): Promise<Map<string, SparseGene>> {
  const bytes = await streamFetchBytes(
    exprUrl,
    localExprUrl,
    (pct, msg) => {
      trackHeap();
      onProgress?.({ phase: "downloading", percent: pct, message: msg });
    },
    signal
  );

  const { verifyExpressionBytes } = await import("@/lib/datasetIdentity");
  await verifyExpressionBytes(bytes, expectedSha256);
  onProgress?.({ phase: "parsing", percent: 0, message: "Decoding expression matrix…" });
  try {
    return parseSparseExpression(bytes, (fraction) => {
      onProgress?.({
        phase: "parsing",
        percent: Math.round(fraction * 100),
        message: "Decoding expression matrix…",
      });
    }, cellCount);
  } catch (e) {
    throw new Error(
      `Could not decode the expression matrix (${(bytes.byteLength / 1e6).toFixed(0)} MB). ` +
        `Regenerate the split files with scripts/compress_dataset.py. Details: ${e}`
    );
  }
}
