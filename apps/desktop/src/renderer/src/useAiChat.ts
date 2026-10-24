import { useCallback, useEffect, useRef, useState } from 'react';
import { repairHistory, type ChatMessage } from '@aurum/core';
import { contextLine, perms, runTurn, type ChatDeps } from './aiTurn';

export type { ChatDeps } from './aiTurn';

const MAX_SAVED = 120;

export function useAiChat(deps: ChatDeps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState({ input: 0, output: 0 });
  const d = useRef(deps);
  d.current = deps;
  const msgs = useRef<ChatMessage[]>([]);
  const abort = useRef<AbortController | null>(null);
  const reqId = useRef<string>('');

  const commit = useCallback((next: ChatMessage[]) => { msgs.current = next; setMessages(next); }, []);

  useEffect(() => {
    void deps.api?.loadChat().then((j) => {
      if (!j) return;
      try { commit(repairHistory(JSON.parse(j) as ChatMessage[])); } catch { /* ignore a corrupt saved chat */ }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deps.api]);

  const save = useCallback(() => {
    void d.current.api?.saveChat(JSON.stringify(repairHistory(msgs.current).slice(-MAX_SAVED))).catch(() => undefined);
  }, []);

  const stop = useCallback(() => {
    abort.current?.abort();
    if (reqId.current) void d.current.api?.aiAbort(reqId.current);
  }, []);

  // "Stop AI actions": halts the running turn immediately.
  useEffect(() => { if (deps.paused) stop(); }, [deps.paused, stop]);

  const send = useCallback(async (text: string) => {
    const { api, config } = d.current;
    if (!api || !config || !text.trim() || running) return;
    setError(null);
    const ac = new AbortController();
    abort.current = ac;
    setRunning(true);

    const st = () => d.current;
    commit([...msgs.current, { role: 'user', blocks: [{ type: 'text', text: `${contextLine(st())}\n\n${text.trim()}` }] }]);
    const p = perms(st());
    try {
      const r = await runTurn(st, msgs.current, p, {
        signal: ac.signal,
        onRequest: (id) => { reqId.current = id; },
        onMessage: (m) => commit([...msgs.current, m]),
        onEvent: (e) => e.type === 'usage' && setUsage((u) => ({ input: u.input + e.input, output: u.output + e.output })),
      });
      if (r.ended === 'error') setError(r.error ?? 'The AI request failed.');
      if (r.ended === 'max_steps') setError('The AI used all its steps without finishing. Ask again, or narrow the request.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      commit(repairHistory(msgs.current).length === msgs.current.length ? msgs.current : repairHistory(msgs.current));
      setRunning(false);
      save();
    }
  }, [commit, running, save]);

  const clear = useCallback(() => { stop(); commit([]); setError(null); save(); }, [commit, save, stop]);

  return { messages, running, error, usage, send, stop, clear };
}
