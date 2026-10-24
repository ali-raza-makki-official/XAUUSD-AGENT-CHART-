import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, CircleCheck, CircleX, LoaderCircle, OctagonX, Play, Plus, SendHorizontal, Settings as Cog, Square, Wrench } from 'lucide-react';
import type { Block, ChatMessage } from '@aurum/core';
import { AnalysisCard, type AnalysisData } from './AnalysisCard';
import { Markdown } from './Markdown';
import { Button, Chip, EmptyState, IconButton } from './ui';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; ok: boolean | null; summary: string }
  | { kind: 'analysis'; data: AnalysisData };

const CONTEXT = /^\[context\][^\n]*\n\n/;

function parse(content: string): { ok: boolean; data?: unknown; error?: string } | null {
  try { return JSON.parse(content); } catch { return null; }
}

function summarize(name: string, input: unknown, result: string | undefined): { ok: boolean | null; summary: string } {
  if (result === undefined) return { ok: null, summary: 'working…' };
  const r = parse(result);
  if (!r?.ok) return { ok: false, summary: r?.error ?? 'failed' };
  const d = r.data as Record<string, unknown> | undefined;
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  switch (name) {
    case 'create_drawing': return { ok: true, summary: `Created ${n(d?.created)} drawing(s)` };
    case 'update_drawing': return { ok: true, summary: `Updated ${n(d?.updated)} drawing(s)` };
    case 'delete_drawing': return { ok: true, summary: `Deleted ${n(d?.deleted)} drawing(s)` };
    case 'get_candles': return { ok: true, summary: `Read ${String(d?.count ?? '')} ${String(d?.timeframe ?? '')} candles` };
    case 'get_chart_state': return { ok: true, summary: 'Read chart state' };
    case 'list_drawings': return { ok: true, summary: `Read ${n(d)} drawing(s)` };
    case 'calculate_risk_reward': return { ok: true, summary: 'Calculated risk/reward' };
    case 'undo_action': return { ok: true, summary: 'Undid AI changes' };
    case 'submit_analysis': return { ok: true, summary: 'Analysis ready' };
    default: return { ok: true, summary: name };
  }
}

export function toItems(messages: ChatMessage[]): Item[] {
  const items: Item[] = [];
  const results = new Map<string, string>();
  for (const m of messages) for (const b of m.blocks) if (b.type === 'tool_result') results.set(b.callId, b.content);
  for (const m of messages) {
    for (const b of m.blocks as Block[]) {
      if (b.type === 'text' && b.text.trim()) items.push({ kind: m.role === 'user' ? 'user' : 'text', text: m.role === 'user' ? b.text.replace(CONTEXT, '') : b.text });
      if (b.type === 'tool_call') {
        const res = results.get(b.id);
        if (b.name === 'submit_analysis' && res && parse(res)?.ok) items.push({ kind: 'analysis', data: b.input as AnalysisData });
        else items.push({ kind: 'tool', name: b.name, ...summarize(b.name, b.input, res) });
      }
    }
  }
  return items;
}

const SUGGESTIONS = [
  'Analyse M15 and H1, mark the key levels and tell me if there is a setup',
  'What is my risk if I buy at the current price with a 70 pip stop?',
  'Find the nearest support and resistance zones and draw them',
];

interface Props {
  chat: { messages: ChatMessage[]; running: boolean; error: string | null; usage: { input: number; output: number }; send: (t: string) => void; stop: () => void; clear: () => void };
  ready: boolean;
  providerLabel: string | null;
  model: string;
  paused: boolean;
  canDraw: boolean;
  onResume: () => void;
  onSettings: () => void;
}

export function ChatPanel({ chat, ready, providerLabel, model, paused, canDraw, onResume, onSettings }: Props) {
  const [text, setText] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const items = useMemo(() => toItems(chat.messages), [chat.messages]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [items.length, chat.running]);

  const submit = () => { const t = text.trim(); if (t && ready && !paused && !chat.running) { chat.send(t); setText(''); } };

  return (
    <div className="chat" aria-label="AI chat">
      <div className="chat-h">
        <span className="chat-model">{ready ? <><Bot size={14} /> {providerLabel} <span className="mono hint">{model || 'no model'}</span></> : <span className="hint">No provider</span>}</span>
        <span className="spacer" />
        <IconButton label="New chat" onClick={chat.clear} disabled={chat.running || chat.messages.length === 0}><Plus size={15} /></IconButton>
        <IconButton label="AI settings" onClick={onSettings}><Cog size={15} /></IconButton>
      </div>
      {paused && (
        <div className="banner banner-danger"><OctagonX size={14} /> AI actions are stopped. Nothing new will run. <Button size="sm" icon={Play} onClick={onResume}>Resume</Button></div>
      )}
      <div className="msgs">
        {!ready ? (
          <EmptyState icon={Bot} title="Connect an AI provider">
            Add an API key for Anthropic, OpenAI, Gemini or DeepSeek. The key is stored encrypted on this PC and never leaves it except to that provider.
            <div style={{ marginTop: 10 }}><Button variant="primary" icon={Cog} onClick={onSettings}>Open AI settings</Button></div>
          </EmptyState>
        ) : items.length === 0 ? (
          <div className="panel-pad">
            <EmptyState icon={Bot} title="Ask about the chart">{canDraw ? 'The AI can read the live chart and draw levels, zones and plans on its own layer. You can undo or lock anything.' : 'Drawing is off, so the AI will describe levels in words. Turn on "Drawings edit" in Settings to let it draw.'}</EmptyState>
            <div className="sugg">{SUGGESTIONS.map((s) => <button key={s} className="sugg-btn" onClick={() => chat.send(s)}>{s}</button>)}</div>
          </div>
        ) : (
          items.map((it, i) =>
            it.kind === 'user' ? <div key={i} className="m-user">{it.text}</div>
            : it.kind === 'text' ? <div key={i} className="m-ai"><Markdown text={it.text} /></div>
            : it.kind === 'analysis' ? <AnalysisCard key={i} a={it.data} />
            : (
              <div key={i} className={`m-tool ${it.ok === false ? 'bad' : ''}`}>
                {it.ok === null ? <LoaderCircle size={13} className="spin" /> : it.ok ? <CircleCheck size={13} /> : <CircleX size={13} />}
                <Wrench size={12} aria-hidden="true" /><span>{it.summary}</span>
              </div>
            ),
          )
        )}
        {chat.running && <div className="m-tool"><LoaderCircle size={13} className="spin" /><span>Thinking…</span></div>}
        {chat.error && <div className="banner banner-warn" role="alert">{chat.error}</div>}
        <div ref={bottom} />
      </div>
      <div className="composer">
        <textarea className="textarea" value={text} disabled={!ready || paused} placeholder={ready ? 'Ask, or tell the AI what to draw…  (Enter to send, Shift+Enter for a new line)' : 'Connect an AI provider to start'} aria-label="Message to AI"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
        {chat.running
          ? <Button variant="danger" icon={Square} onClick={chat.stop}>Stop</Button>
          : <Button variant="primary" icon={SendHorizontal} disabled={!ready || paused || !text.trim()} onClick={submit}>Send</Button>}
      </div>
      {ready && chat.usage.input + chat.usage.output > 0 && <div className="usage mono">{chat.usage.input.toLocaleString()} in · {chat.usage.output.toLocaleString()} out tokens this session <Chip>est. by provider</Chip></div>}
    </div>
  );
}
