import type { WaHistoryEntry, WaPermissionLevel } from '@aurum/core';

/** WhatsApp gateway surface shared by main, preload and renderer. No secrets ever cross this boundary (only "has token"). */
export const WA_IPC = {
  status: 'wa:status',
  setToken: 'wa:setToken',
  clearToken: 'wa:clearToken',
  startPairing: 'wa:startPairing',
  cancelPairing: 'wa:cancelPairing',
  test: 'wa:test',
  briefingTest: 'wa:briefingTest',
  getSettings: 'wa:getSettings',
  setSettings: 'wa:setSettings',
  history: 'wa:history',
  unlink: 'wa:unlink',
  setRunning: 'wa:setRunning',
  /** main -> renderer: run one headless AI turn, or execute confirmed chart calls. */
  aiRequest: 'wa:ai:request',
  /** renderer -> main: result of that. */
  aiResponse: 'wa:ai:response',
  /** renderer -> main: the headless runner is mounted and can take requests. */
  aiReady: 'wa:ai:ready',
  /** main -> renderer: the status changed (push). */
  statusPush: 'wa:status:push',
} as const;

export interface WaQuietHours { enabled: boolean; start: string; end: string; tz: string; allowCritical: boolean }
export interface WaBriefing { enabled: boolean; time: string; tz: string; weekdaysOnly: boolean }
export interface WaUiSettings {
  enabled: boolean;
  permission: WaPermissionLevel;
  confirmChartActions: boolean;
  notifications: boolean;
  statusNotices: boolean;
  briefing: WaBriefing;
  quietHours: WaQuietHours;
}
export type WaUiSettingsPatch = Partial<Omit<WaUiSettings, "quietHours" | "briefing">> & { quietHours?: Partial<WaQuietHours>; briefing?: Partial<WaBriefing> };
export type WaGatewayState = 'stopped' | 'no_token' | 'connecting' | 'polling' | 'backoff' | 'conflict' | 'auth_error';
export interface WaUiStatus {
  secureStorage: boolean;
  hasToken: boolean;
  running: boolean;
  state: WaGatewayState;
  lastSyncAt: number | null;
  lastError: { message: string; at: number; kind: string } | null;
  nextRetryAt: number | null;
  rate: { sendUsed: number; sendLimit: number; queued: number };
  link:
    | { status: 'unlinked' }
    | { status: 'pairing'; code: string; expiresAt: number; attempts: number }
    | { status: 'linked'; linkedAt: number };
  /** /pause was used from WhatsApp: remote AI and chart actions are refused until /resume (with a code). */
  remotePaused: boolean;
  aiWindowReady: boolean;
  alertsChannelRegistered: boolean;
}

/** Headless AI turn, main -> renderer. */
/** Something the user sent on WhatsApp, base64 encoded for the renderer turn. */
export interface WaAttachment { kind: 'image' | 'document'; mime: string; name?: string; data: string }
export interface WaAiRequest { id: string; text: string; conversationKey: string; level: 'ask' | 'chart'; /** The user may let the AI propose trade plans (WhatsApp level Trade). */ plans?: boolean; attachments?: WaAttachment[] }
export interface WaProposedCall { name: string; input: unknown }
export interface WaAiResponse {
  id: string;
  ok: boolean;
  text: string;
  error?: string;
  /** Chart-changing tool calls the AI wanted; held back and only run after a CONFIRM code. */
  proposed?: { calls: WaProposedCall[]; preview: string };
  /** Numbered choices the AI offered (each is a set of chart-changing calls). Option 1 is the first entry. */
  /** Pictures to send back to the user (e.g. a chart screenshot), base64. */
  images?: { mime: string; data: string }[];
  options?: { label: string; calls: WaProposedCall[]; preview: string }[];
}
/** Confirmed chart actions, main -> renderer (same channel, different shape). */
export interface WaExecRequest { id: string; exec: true; calls: WaProposedCall[] }

export interface WhatsAppApi {
  waStatus(): Promise<WaUiStatus>;
  waSetToken(token: string): Promise<void>;
  waClearToken(): Promise<void>;
  waStartPairing(): Promise<void>;
  waCancelPairing(): Promise<void>;
  waTest(): Promise<{ ok: boolean; message: string }>;
  /** Send today's briefing to WhatsApp right now so the content can be checked. */
  waBriefingTest(): Promise<{ ok: boolean; message: string }>;
  waGetSettings(): Promise<WaUiSettings>;
  waSetSettings(patch: WaUiSettingsPatch): Promise<WaUiSettings>;
  waHistory(limit?: number): Promise<WaHistoryEntry[]>;
  waUnlink(): Promise<void>;
  waSetRunning(on: boolean): Promise<void>;
  onWaStatus(cb: (s: WaUiStatus) => void): () => void;
  onWaAiRequest(cb: (r: WaAiRequest | WaExecRequest) => void): () => void;
  waAiRespond(r: WaAiResponse): Promise<void>;
  waAiReady(ready: boolean): Promise<void>;
}
