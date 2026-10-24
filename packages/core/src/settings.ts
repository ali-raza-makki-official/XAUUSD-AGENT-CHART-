import { z } from 'zod';

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

export const OrderMode = z.enum(['suggest', 'confirm', 'automatic']);

/** AI capability matrix. Defaults are the safe side everywhere. */
export const AiPermissionsSchema = z.object({
  chartRead: z.boolean().default(true),
  drawingsEdit: z.boolean().default(false),
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
  timeframe: z.enum(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1']).default('M15'),
  pipSize: z.number().positive().default(0.1),
  risk: RiskSettingsSchema.default(() => DEFAULT_RISK_SETTINGS),
  aiPermissions: AiPermissionsSchema.default(() => DEFAULT_AI_PERMISSIONS),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
export const DEFAULT_APP_CONFIG: AppConfig = AppConfigSchema.parse({});
