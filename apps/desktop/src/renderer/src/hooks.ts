import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountInfo, AppConfig, Candle, FeedStatus, Tick, Timeframe } from '@aurum/core';
import { getApi } from './lib/aurum';

export interface LogLine { at: number; text: string }

/** Real feed state from the main process. Nothing here is generated locally. */
export function useFeed() {
  const api = getApi();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [status, setStatus] = useState<FeedStatus>({ state: 'starting', message: 'Connecting…' });
  const [tick, setTick] = useState<Tick | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const lastState = useRef<string>('');

  const push = useCallback((text: string) => setLog((l) => [{ at: Date.now(), text }, ...l].slice(0, 200)), []);

  useEffect(() => {
    if (!api) return;
    void api.getConfig().then(setConfig);
    void api.snapshot().then((s) => {
      setStatus(s.status);
      setTick(s.tick);
      setAccount(s.account);
    });
    const offs = [
      api.onTick(setTick),
      api.onStatus((s) => {
        setStatus(s);
        const key = `${s.state}|${s.message ?? ''}`;
        if (key !== lastState.current) {
          lastState.current = key;
          push(`${s.state.toUpperCase()} — ${s.message ?? ''}`);
        }
      }),
      api.onAccount((a) => {
        setAccount(a);
        if (a) push(`Account ${a.login} on ${a.server} (${a.demo ? 'DEMO' : 'LIVE'}, ${a.currency})`);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [api, push]);

  const update = useCallback(
    async (patch: Partial<AppConfig>) => {
      if (!api) return;
      setConfig(await api.setConfig(patch));
    },
    [api],
  );

  return { api, config, status, tick, account, log, update };
}

const HISTORY = 1500;

/** Loads real candles from MT5 whenever the timeframe changes or the feed (re)connects. */
export function useCandles(tf: Timeframe, connected: boolean) {
  const api = getApi();
  const [candles, setCandles] = useState<Candle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!api || !connected) return;
    let cancelled = false;
    setLoading(true);
    api
      .candles(tf, HISTORY)
      .then((c) => !cancelled && (setCandles(c), setError(null)))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, tf, connected]);

  return { candles, error, loading };
}
