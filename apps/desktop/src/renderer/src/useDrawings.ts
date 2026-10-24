import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DrawingStore, type Actor, type Drawing, type DrawingOp, type DispatchResult, type StoreEvent } from '@aurum/core';
import type { AurumApi } from '../../shared';

const newId = () => globalThis.crypto.randomUUID();

/** React wrapper over the one DrawingStore. Persists every action to SQLite through the main process. */
export function useDrawings(api: AurumApi | undefined, symbol: string) {
  const store = useMemo(() => new DrawingStore(), []);
  const [, bump] = useState(0);
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    const finish = () => !cancelled && setReady(true);
    if (!api) { store.load([]); finish(); return; }
    api.loadDrawings(symbol).then((r) => { if (!cancelled) store.load(r.drawings, r.commandIds); }).catch((e) => setSaveError(String(e))).finally(finish);
    return () => { cancelled = true; };
  }, [api, symbol, store]);

  useEffect(() => store.subscribe((e: StoreEvent) => {
    bump((n) => n + 1);
    if (e.type !== 'changes' || !apiRef.current) return;
    const side = e.direction === 'undo' ? 'before' : 'after';
    apiRef.current
      .persistDrawings({
        symbol,
        log: { commandId: e.entry.commandId, actor: e.entry.actor, kind: e.direction === 'do' ? 'do' : e.direction, label: e.entry.label },
        changes: e.entry.changes.map((c) => ({ id: c.id, after: c[side] })),
      })
      .then(() => setSaveError(null))
      .catch((err: unknown) => setSaveError(err instanceof Error ? err.message : String(err)));
  }), [store, symbol]);

  const dispatch = useCallback(
    (ops: DrawingOp[], label: string, actor: Actor = 'manual'): DispatchResult => store.dispatch({ commandId: newId(), actor, label, ops }),
    [store],
  );

  return {
    store, ready, saveError,
    drawings: store.list() as Drawing[],
    canUndo: store.canUndo, canRedo: store.canRedo,
    dispatch,
    undo: () => store.undo(), redo: () => store.redo(),
  };
}
