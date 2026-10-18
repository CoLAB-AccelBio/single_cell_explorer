import { useState, useEffect, useRef, useCallback } from 'react';
import type { SingleCellDataset } from '@/types/singleCell';
import { fetchCoreDataset, fetchExpressionMatrix, type LoadProgress } from '@/lib/datasetLoader';

/** Retrying expression must never reset user-edited annotations. */
export function useDatasetLoading(fallback: SingleCellDataset) {
  const [dataset, setDataset] = useState(fallback);
  const [isLoadingRemote, setIsLoadingRemote] = useState(true);
  const [loadProgress, setLoadProgress] = useState<LoadProgress>({ phase: 'downloading', percent: 0, message: 'Initialising…' });
  const [exprProgress, setExprProgress] = useState<LoadProgress | null>(null);
  const [exprReady, setExprReady] = useState(false);
  const [exprCancelled, setExprCancelled] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [errorScope, setErrorScope] = useState<'core' | 'expression' | null>(null);
  const originalDatasetRef = useRef(fallback);
  const coreRef = useRef<SingleCellDataset | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    abortRef.current = controller;
    const load = async () => {
      try {
        let core = coreRef.current;
        if (!core) {
          setIsLoadingRemote(true);
          core = await fetchCoreDataset(p => { if (!disposed) setLoadProgress(p); }, controller.signal);
          if (disposed) return;
          coreRef.current = core;
          setDataset(core);
          originalDatasetRef.current = core;
          setIsLoadingRemote(false);
        }
        setExprProgress({ phase: 'downloading', percent: 0, message: 'Downloading expression matrix…' });
        const expression = await fetchExpressionMatrix(core.cells.map(c => c.id), p => { if (!disposed) setExprProgress(p); }, controller.signal);
        if (disposed) return;
        setDataset(prev => ({ ...prev, expression }));
        originalDatasetRef.current = { ...originalDatasetRef.current, expression };
        setExprReady(true);
        setExprProgress(null);
      } catch (error) {
        if (disposed) return;
        setExprProgress(null);
        setIsLoadingRemote(false);
        setErrorScope(coreRef.current ? 'expression' : 'core');
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) setExprCancelled(true);
        else setRemoteError(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    return () => { disposed = true; controller.abort(); };
  }, [attempt]);
  const handleCancelExpression = useCallback(() => abortRef.current?.abort(), []);
  const handleRetryExpression = useCallback(() => {
    setExprCancelled(false); setRemoteError(null); setErrorScope(null); setAttempt(n => n + 1);
  }, []);
  return { dataset, setDataset, isLoadingRemote, loadProgress, exprProgress, exprReady, exprCancelled, remoteError, errorScope,
    originalDatasetRef, handleCancelExpression, handleRetryExpression };
}