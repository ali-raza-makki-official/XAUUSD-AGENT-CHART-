import { useEffect, useRef } from 'react';
import { AiPermissionsSchema, dropOldMedia, repairHistory, type AiPermissions, type ChatMessage } from '@aurum/core';
import type { WaAttachment, WaAiRequest, WaExecRequest, WaProposedCall } from '../../whatsappShared';
import { contextLine, execConfirmed, perms, runTurn, type ChatDeps } from './aiTurn';

/** Tools that change the chart. From WhatsApp they are held back and only run after the user types CONFIRM <code>. */
const CHART_CHANGING = new Set([
  'create_drawing', 'update_drawing', 'delete_drawing', 'create_alert', 'update_alert', 'delete_alert',
  'add_indicator', 'update_indicator', 'remove_indicator', 'set_layout', 'set_timeframe', 'undo_action',
]);
const MAX_HISTORY = 24;
const MAX_FILE_TEXT = 30_000;
const TEXT_MIME = /^(text\/|application\/(json|xml|csv|x-ndjson))/i;

/** What the user sent on WhatsApp, as model input. Readable files become text; PDFs and images go as files/images. */
export function attachmentBlocks(list: WaAttachment[]): ChatMessage['blocks'] {
  return list.map((a): ChatMessage['blocks'][number] => {
    if (a.kind === 'image') return { type: 'image', mime: a.mime, data: a.data };
    const name = a.name ?? 'file';
    if (a.mime === 'application/pdf') return { type: 'file', mime: a.mime, name, data: a.data };
    if (TEXT_MIME.test(a.mime) || /\.(txt|csv|md|json|log)$/i.test(name)) {
      const text = new TextDecoder().decode(Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0)));
      return { type: 'text', text: `File "${name}":\n${text.slice(0, MAX_FILE_TEXT)}${text.length > MAX_FILE_TEXT ? '\n…[file cut]' : ''}` };
    }
    return { type: 'text', text: `[The user sent a file "${name}" (${a.mime}) that cannot be read here. Say so; do not guess its contents.]` };
  });
}
const suffixFor = (level: 'ask' | 'chart') => level === 'chart'
  ? '\n\n[channel: WhatsApp. Answer in short plain text, no markdown tables. Anything that changes the chart is held until the user replies with an option number. When there are several sensible variants, call offer_options.]'
  : '\n\n[channel: WhatsApp, read-only level. You cannot draw or change anything from here. If asked to, say that Chart control must be allowed in Aurum > Settings > WhatsApp. Short plain text, no markdown tables.]';

const OFFER_OPTIONS_TOOL = {
  name: 'offer_options',
  description: 'Offer the user 2-4 numbered choices on WhatsApp when there are several sensible ways to change the chart (e.g. conservative vs aggressive zone). Nothing is applied until the user replies with a number. Each option is a short label plus the chart-changing tool calls it would run. Do not use it for a single proposal; just call the tool normally.',
  inputSchema: {
    type: 'object',
    properties: {
      options: {
        type: 'array', minItems: 2, maxItems: 4,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Max 40 characters, e.g. "Zone 2650-2655".' },
            calls: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', properties: { name: { type: 'string' }, input: { type: 'object' } }, required: ['name', 'input'] } },
          },
          required: ['label', 'calls'],
        },
      },
    },
    required: ['options'],
  },
};

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
        const sent = attachmentBlocks(req.attachments ?? []);
        const history: ChatMessage[] = dropOldMedia([...prev, { role: 'user', blocks: [{ type: 'text', text: `${contextLine(st())}\n\n${req.text}${suffixFor(req.level)}` }, ...sent] }], 2);
        const pictures: { mime: string; data: string }[] = [];
        const held: WaProposedCall[] = [];
        let card: Analysis | null = null;
        let offered: { label: string; calls: WaProposedCall[] }[] = [];
        const r = await runTurn(st, history, p, {
          channel: 'whatsapp',
          onImages: (im) => pictures.push(...im),
          ...(req.level === 'chart' ? { extraTools: [OFFER_OPTIONS_TOOL] } : {}),
          intercept: (name, input) => {
            if (name === 'offer_options') {
              const raw = (input as { options?: { label?: unknown; calls?: { name?: unknown; input?: unknown }[] }[] }).options;
              const ok = Array.isArray(raw) && raw.length >= 2 && raw.length <= 4 && raw.every((o) => typeof o.label === 'string' && Array.isArray(o.calls) && o.calls.length > 0 && o.calls.length <= 5 && o.calls.every((c) => typeof c.name === 'string' && CHART_CHANGING.has(c.name)));
              if (!ok || req.level !== 'chart') return { ok: false, content: JSON.stringify({ ok: false, error: { code: 'invalid_input', message: 'Give 2-4 options, each with a label and 1-5 chart-changing calls.' } }) };
              offered = raw.map((o) => ({ label: String(o.label).slice(0, 40), calls: o.calls!.map((c) => ({ name: String(c.name), input: c.input })) }));
              return { ok: true, content: JSON.stringify({ ok: true, data: { held: true, note: 'Options NOT applied. The app shows them as numbered choices; write one short line introducing them.' } }) };
            }
            if (name === 'submit_analysis') card = input as Analysis;
            if (!CHART_CHANGING.has(name) || req.level !== 'chart') return null;
            held.push({ name, input });
            return { ok: true, content: JSON.stringify({ ok: true, data: { held: true, note: 'NOT applied yet. The user confirms on WhatsApp by replying 1 (Confirm) or 2 (Cancel); the app adds those options. Just describe briefly what you proposed.' } }) };
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
          ...(pictures.length ? { images: pictures.slice(0, 3) } : {}),
          ...(offered.length ? { options: offered.map((o) => ({ ...o, preview: `${o.label}:\n${o.calls.map((h) => `- ${h.name} ${JSON.stringify(h.input).slice(0, 160)}`).join('\n')}` })) } : {}),
          ...(held.length && !offered.length ? { proposed: { calls: held, preview: `Proposed chart changes:\n${held.map((h) => `- ${h.name} ${JSON.stringify(h.input).slice(0, 200)}`).join('\n')}` } } : {}),
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
