import { z } from 'zod';
import { StyleSchema } from './drawing';
import { NotificationSettingsSchema } from './notifications';
import { ChartLayoutSchema, DEFAULT_PANE_TIMEFRAMES, PaneTimeframesSchema } from './chartLayout';
import { ContextSettingsSchema } from './contextConnectors';

/** Conservative starting values. All are user-editable. */
export const RiskSettingsSchema = z.object({
  maxRiskPerTradePct: z.number().positive().default(0.5),
  maxOpenRiskPct: z.number().positive().default(1.5),
  maxDailyLossPct: z.number().positive().default(2),
  /** 'broker' = broker server midnight; otherwise an IANA timezone. */
  dailyResetTimezone: z.string().default('broker'),
  /** Price units (GOLD), not pips. */
  maxSpread: z.number().positive().default(0.6),
  maxSlippage: z.number().positive().default(0.5),
  maxSimultaneousPositions: z.number().int().positive().default(3),
  missingSlPolicy: z.enum(['block', 'warn']).default('block'),
  /** What happens to existing positions once the daily limit is hit. */
  dailyLimitPolicy: z.enum(['manage_only', 'freeze', 'force_flat']).default('manage_only'),
  /** Count floating loss of open trades toward the daily limit. */
  countFloatingInDailyLimit: z.boolean().default(true),
});
export type RiskSettings = z.infer<typeof RiskSettingsSchema>;
export const DEFAULT_RISK_SETTINGS: RiskSettings = RiskSettingsSchema.parse({});

export const ProviderIdSchema = z.enum(['anthropic', 'openai', 'gemini', 'deepseek']);

export const AiSettingsSchema = z.object({
  provider: ProviderIdSchema.nullable().default(null),
  /** Chosen model per provider. Models differ per account, so there is no baked-in default to go stale. */
  models: z.record(z.string(), z.string().max(100)).default({}),
  /** Optional base URL override per provider (OpenAI-compatible gateways, proxies, local servers). */
  baseUrls: z.record(z.string(), z.string().max(300)).default({}),
  /** Send account balance/equity to the AI provider. Off by default; lot sizing still works locally. */
  sendBalance: z.boolean().default(false),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

export const OrderMode = z.enum(['suggest', 'confirm', 'automatic']);

/** AI capability matrix. Defaults are the safe side everywhere. */
export const AiPermissionsSchema = z.object({
  chartRead: z.boolean().default(true),
  drawingsEdit: z.boolean().default(false),
  /** Add, change and remove indicators (a view setting, but it changes what the user sees, so it is opt-in). */
  indicatorsEdit: z.boolean().default(false),
  /** Change chart layout and pane timeframes (set_layout, set_timeframe). View state only; never touches drawings or orders. */
  chartControl: z.boolean().default(false),
  alertsAndSetups: z.boolean().default(false),
  orders: OrderMode.default('suggest'),
  sltpAndPartialClose: z.boolean().default(false),
  bulkClose: z.boolean().default(false),
  /** Connectors and credentials are never reachable by the AI; kept here for completeness. */
  connectorsAndCredentials: z.literal(false).default(false),
});
export type AiPermissions = z.infer<typeof AiPermissionsSchema>;
export const DEFAULT_AI_PERMISSIONS: AiPermissions = AiPermissionsSchema.parse({});

export const AppConfigSchema = z.object({
  /** App-level symbol. Broker symbol is mapped separately (Exness here: GOLD). */
  symbol: z.string().default('XAUUSD'),
  brokerSymbol: z.string().default('GOLD'),
  /** Optional full path to terminal64.exe when several MT5 terminals are installed. Empty = auto-detect. */
  mt5Path: z.string().max(400).default(''),
  /** How Aurum talks to MT5: the Python bridge (default, tested) or the optional AurumBridge.mq5 EA. */
  mt5Mode: z.enum(['python', 'ea']).default('python'),
  timeframe: z.enum(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']).default('M15'),
  pipSize: z.number().positive().default(0.1),
  /** Chart workspace: single, two side by side, or 2x2. `timeframe` above is the single-chart timeframe. */
  layout: ChartLayoutSchema.default('single'),
  /** Timeframe per pane for the multi-chart layouts (H4/H1/M15/M5 by default). */
  paneTimeframes: PaneTimeframesSchema.default(() => [...DEFAULT_PANE_TIMEFRAMES]),
  /** Scroll/zoom all panes together. The crosshair is always synced. */
  syncScroll: z.boolean().default(false),
  /** Per-tool default style overrides (colour, width, line style, fill), keyed by drawing kind. */
  toolStyles: z.record(z.string(), StyleSchema.partial()).default({}),
  /** Order placement. Off by default; only ever started against DEMO accounts by this app. */
  trading: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  magnet: z.boolean().default(true),
  stayInTool: z.boolean().default(false),
  risk: RiskSettingsSchema.default(() => DEFAULT_RISK_SETTINGS),
  aiPermissions: AiPermissionsSchema.default(() => DEFAULT_AI_PERMISSIONS),
  ai: AiSettingsSchema.default(() => AiSettingsSchema.parse({})),
  notifications: NotificationSettingsSchema.default(() => NotificationSettingsSchema.parse({})),
  context: ContextSettingsSchema.default(() => ContextSettingsSchema.parse({})),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
export const DEFAULT_APP_CONFIG: AppConfig = AppConfigSchema.parse({});
