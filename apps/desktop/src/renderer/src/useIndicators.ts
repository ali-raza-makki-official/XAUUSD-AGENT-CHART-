import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IndicatorStore, makeIndicator,
  type Actor, type Indicator, type IndicatorDispatchResult, type IndicatorOp, type IndicatorStoreEvent, type IndicatorType,
} from '@aurum/core';
import type { AurumApi } from '../../shared';

const newId = () => globalThis.crypto.randomUUID();

/** React wrapper over the one IndicatorStore. Persists every action to SQLite through the main process. */
export function useIndicators(api: AurumApi | undefined, symbol: string) {
  const store = useMemo(() => new IndicatorStore(), []);
  const [list, setList] = useState<Indicator[]>([]);
  const [ready, setReady] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    const finish = () => !cancelled && setReady(true);
    if (!api) { store.load([]); finish(); return; }
    api.loadIndicators(symbol)
      .then((r) => { if (!cancelled) store.load(r.indicators, r.commandIds); })
      .catch((e) => setSaveError(String(e)))
      .finally(finish);
    return () => { cancelled = true; };
  }, [api, symbol, store]);

  useEffect(() => store.subscribe((e: IndicatorStoreEvent) => {
    // New array only when something changed, so the chart panes do not recompute on every tick.
    setList(store.list());
    if (e.type !== 'changes' || !apiRef.current) return;
    const side = e.direction === 'undo' ? 'before' : 'after';
    apiRef.current
      .persistIndicators({
        symbol,
        log: { commandId: e.entry.commandId, actor: e.entry.actor, kind: e.direction, label: e.entry.label },
        changes: e.entry.changes.map((c) => ({ id: c.id, after: c[side] })),
      })
      .then(() => setSaveError(null))
      .catch((err: unknown) => setSaveError(err instanceof Error ? err.message : String(err)));
  }), [store, symbol]);

  const dispatch = useCallback(
    (ops: IndicatorOp[], label: string, actor: Actor = 'manual'): IndicatorDispatchResult => store.dispatch({ commandId: newId(), actor, label, ops }),
    [store],
  );

  /** Same function the AI add_indicator tool ends up in (store.dispatch), with the manual actor. */
  const add = useCallback((type: IndicatorType): Indicator | null => {
    const ind = makeIndicator(type);
    const r = dispatch([{ op: 'create', indicator: ind }], `Add ${ind.type}`);
    return r.ok ? ind : null;
  }, [dispatch]);

  return { store, ready, saveError, indicators: list, dispatch, add };
}
