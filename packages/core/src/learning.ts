import { z } from 'zod';

/** What Aurum remembers and learns from. Everything stays on this PC; only the short memory digest goes to your AI provider. */
export const LearningSettingsSchema = z.object({
  /** Keep every price tick (compact, local) so ideas can be replayed and judged later. */
  recordTicks: z.boolean().default(true),
  /** Ticks older than this are deleted. Paper results and notes are kept. */
  retentionDays: z.number().int().min(1).max(730).default(90),
  /** A paper trade still open after this many hours is closed at market. */
  paperMaxHoldHours: z.number().int().min(1).max(720).default(48),
  /** Remember chats and notes across days and give the AI a short digest of them. */
  memory: z.boolean().default(true),
  /** Apply a data-backed change to the DEFAULT stop/target for new plans by itself (never to risk limits). Logged and undoable. */
  autoTune: z.boolean().default(false),
});
export type LearningSettings = z.infer<typeof LearningSettingsSchema>;
export const DEFAULT_LEARNING: LearningSettings = LearningSettingsSchema.parse({});
