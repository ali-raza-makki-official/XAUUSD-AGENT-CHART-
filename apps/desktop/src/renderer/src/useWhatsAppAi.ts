import { useEffect, useRef } from 'react';
import { AiPermissionsSchema, repairHistory, type AiPermissions, type ChatMessage } from '@aurum/core';
import type { WaAiRequest, WaExecRequest, WaProposedCall } from '../../whatsappShared';
import { contextLine, execConfirmed, perms, runTurn, type ChatDeps } from './aiTurn';

/** Tools that change the chart. From WhatsApp they are held back and only run after the user types CONFIRM <code>. */
const CHART_CHANGING = new Set([
  'create_drawing', 'update_drawing', 'delete_drawing', 'create_alert', 'update_alert', 'delete_alert',
  'add_indicator', 'update_indicator', 'remove_indicator', 'set_layout', 'set_timeframe', 'undo_action',
]);
const MAX_HISTORY = 24;
const SUFFIX = '\n\n[channel: WhatsApp. Answer in short plain text, no markdown tables. Anything that changes the chart will be held for the user to confirm with a code.]';

type Analysis = {
  noSetup?: boolean; marketStructure?: { state: string; summary: string }; levels?: { price: number; kind: string; reason: string }[];
  scenarios?: { condition: string; outcome: string }[]; invalidation?: string; missingInformation?: string[]; dataReference?: { timeframes: string[]; asOf: string; feed: string };
};

export function analysisToText(a: Analysis): string {
  const lines: string[] = [a.noSetup ? 'Analysis: no clear setup.' : 'Analysis:'];
  if (a.marketStructure) lines.push(`Structure: ${a.marketStructure.state}. ${a.marketStructure.summary}`);
  if (a.levels?.length) lines.push('Levels:', ...a.levels.map((l) => `- ${l.price} ${l.kind}: ${l.reason}`));
  if (a.scenarios?.length) lines.push('Scenarios:', ...a.scenarios.map((s) => `- If ${s.condition}: ${s.outcome}`));
  if (a.invalidation) lines.push(`Invalid if: ${a.invalidation}`);
  if (a.missingInformation?.length) lines.push(`Missing: ${a.missingInformation.join('; ')}`);
  if (a.dataReference) lines.push(`Data: ${a.dataReference.timeframes.join('/')} as of ${a.dataReference.asOf} (${a.dataReference.feed})`);
  return lines.join('\n');
}

const asText = (m: ChatMessage) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();

/**
 * Headless one-shot AI turns for WhatsApp. Runs in the renderer because the drawing store and the AI chat live here.
 * Own message history per conversation, no UI side effects (nothing is written into the chat panel).
 */
export function useWhatsAppAi(deps: ChatDeps): void {
  const d = useRef(deps);
  d.current = deps;
  const histories = useRef(new Map<string, ChatMessage[]>());
  const api = deps.api;

  useEffect(() => {
    if (!api) return;
    const st = () => d.current;
    const respond = (r: Parameters<typeof api.waAiRespond>[0]) => { void api.waAiRespond(r).catch(() => undefined); };

    const exec = async (req: WaExecRequest) => {
      try {
        const r = await execConfirmed(st, req.calls);
        respond({ id: req.id, ok: r.ok, text: r.text, ...(r.ok ? {} : { error: r.text }) });
      } catch (e) {
        respond({ id: req.id, ok: false, text: '', error: e instanceof Error ? e.message : String(e) });
      }
    };

    const turn = async (req: WaAiRequest) => {
      try {
        if (!st().config?.ai.provider) throw new Error('No AI provider is chosen in Aurum Settings > AI.');
        // WhatsApp read-only by default; chart control only when its level allows AND the app's own AI permissions allow it. Never orders.
        const base: AiPermissions = perms(st());
        const p = AiPermissionsSchema.parse(
          req.level === 'chart'
            ? { ...base, orders: 'suggest', sltpAndPartialClose: false, bulkClose: false }
            : { ...base, drawingsEdit: false, indicatorsEdit: false, chartControl: false, alertsAndSetups: false, orders: 'suggest', sltpAndPartialClose: false, bulkClose: false },
        );
        const prev = histories.current.get(req.conversationKey) ?? [];
        const history: ChatMessage[] = [...prev, { role: 'user', blocks: [{ type: 'text', text: `${contextLine(st())}\n\n${req.text}${SUFFIX}` }] }];
        const held: WaProposedCall[] = [];
        let card: Analysis | null = null;
        const r = await runTurn(st, history, p, {
          intercept: (name, input) => {
            if (name === 'submit_analysis') card = input as Analysis;
            if (!CHART_CHANGING.has(name) || req.level !== 'chart') return null;
            held.push({ name, input });
            return { ok: true, content: JSON.stringify({ ok: true, data: { held: true, note: 'NOT applied yet. The user must confirm with a code on WhatsApp; tell them what you proposed.' } }) };
          },
        });
        const all = repairHistory([...history, ...r.added]);
        histories.current.set(req.conversationKey, all.slice(-MAX_HISTORY));
        if (r.ended === 'error') throw new Error(r.error ?? 'The AI request failed.');
        const lastAssistant = [...r.added].reverse().find((m) => m.role === 'assistant' && asText(m));
        const parts = [card ? analysisToText(card) : '', lastAssistant ? asText(lastAssistant) : ''].filter(Boolean);
        const text = parts.join('\n\n') || (r.ended === 'max_steps' ? 'The AI used all its steps without finishing. Ask again, more narrowly.' : 'No answer.');
        respond({
          id: req.id, ok: true, text,
          ...(held.length ? { proposed: { calls: held, preview: `Proposed chart changes:\n${held.map((h) => `- ${h.name} ${JSON.stringify(h.input).slice(0, 200)}`).join('\n')}` } } : {}),
        });
      } catch (e) {
        respond({ id: req.id, ok: false, text: '', error: e instanceof Error ? e.message : String(e) });
      }
    };

    const off = api.onWaAiRequest((req) => { void ('exec' in req ? exec(req) : turn(req)); });
    void api.waAiReady(true).catch(() => undefined);
    return () => { off(); void api.waAiReady(false).catch(() => undefined); };
  }, [api]);
}
