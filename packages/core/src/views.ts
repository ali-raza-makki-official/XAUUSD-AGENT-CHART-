import { z } from 'zod';
import { TimeframeSchema } from './feed';

/**
 * "My view vs the AI's view": the trader writes their own read of the market; the AI's latest analysis card is the other side.
 * The comparison is plain arithmetic on what both sides actually wrote. Nothing is inferred beyond that.
 */
export const BiasSchema = z.enum(['bullish', 'bearish', 'ranging', 'unclear']);
export type Bias = z.infer<typeof BiasSchema>;

export const ViewLevelSchema = z.object({ price: z.number().positive(), kind: z.enum(['support', 'resistance', 'supply', 'demand', 'pivot', 'other']) });
export type ViewLevel = z.infer<typeof ViewLevelSchema>;

export const UserViewSchema = z.object({
  bias: BiasSchema,
  timeframe: TimeframeSchema,
  levels: z.array(ViewLevelSchema).max(12),
  invalidation: z.string().max(400).default(''),
  note: z.string().max(1000).default(''),
  savedAt: z.number().int(),
});
export type UserView = z.infer<typeof UserViewSchema>;

export interface AiView { bias: Bias; noSetup: boolean; levels: ViewLevel[]; invalidation: string; asOf: string; timeframes: string[]; savedAt: number }

/** What the AI's analysis card says, reduced to what can be compared. */
export function aiViewFromAnalysis(a: {
  noSetup: boolean; marketStructure: { state: Bias }; levels: { price: number; kind: ViewLevel['kind'] }[]; invalidation: string; dataReference: { asOf: string; timeframes: string[] };
}, savedAt: number): AiView {
  return { bias: a.marketStructure.state, noSetup: a.noSetup, levels: a.levels.map((l) => ({ price: l.price, kind: l.kind })), invalidation: a.invalidation, asOf: a.dataReference.asOf, timeframes: a.dataReference.timeframes, savedAt };
}

export interface ViewComparison {
  bias: 'agree' | 'disagree' | 'different_kind' | 'missing';
  shared: { user: ViewLevel; ai: ViewLevel; distance: number }[];
  userOnly: ViewLevel[];
  aiOnly: ViewLevel[];
  summary: string;
}

/** Levels within `tolerance` price units of each other count as the same level (greedy, nearest first). */
export function compareViews(user: UserView | null, ai: AiView | null, tolerance: number): ViewComparison {
  if (!user || !ai) return { bias: 'missing', shared: [], userOnly: user?.levels ?? [], aiOnly: ai?.levels ?? [], summary: !user && !ai ? 'Neither side has a view yet.' : !user ? 'You have not written your view yet.' : 'The AI has not given an analysis yet. Ask it to analyse the chart.' };
  const pairs: { u: number; a: number; d: number }[] = [];
  user.levels.forEach((u, ui) => ai.levels.forEach((a, ai2) => { const d = Math.abs(u.price - a.price); if (d <= tolerance) pairs.push({ u: ui, a: ai2, d }); }));
  pairs.sort((x, y) => x.d - y.d);
  const usedU = new Set<number>(), usedA = new Set<number>(), shared: ViewComparison['shared'] = [];
  for (const p of pairs) { if (usedU.has(p.u) || usedA.has(p.a)) continue; usedU.add(p.u); usedA.add(p.a); shared.push({ user: user.levels[p.u]!, ai: ai.levels[p.a]!, distance: Math.round(p.d * 100) / 100 }); }
  const userOnly = user.levels.filter((_, i) => !usedU.has(i)), aiOnly = ai.levels.filter((_, i) => !usedA.has(i));
  const directional = (b: Bias) => b === 'bullish' || b === 'bearish';
  const bias: ViewComparison['bias'] = user.bias === ai.bias ? 'agree'
    : directional(user.bias) && directional(ai.bias) ? 'disagree' : 'different_kind';
  const bits = [
    bias === 'agree' ? `Both read the market as ${user.bias}.` : bias === 'disagree' ? `Opposite reads: you say ${user.bias}, the AI says ${ai.bias}. Look at who is using which timeframe before trading either.` : `You say ${user.bias}, the AI says ${ai.bias}${ai.noSetup ? ' and sees no clean setup' : ''}.`,
    shared.length ? `${shared.length} level(s) match within ${tolerance}.` : 'No level matches.',
    userOnly.length ? `${userOnly.length} of your level(s) the AI did not mention.` : '',
    aiOnly.length ? `${aiOnly.length} AI level(s) you did not mark.` : '',
  ].filter(Boolean);
  return { bias, shared, userOnly, aiOnly, summary: bits.join(' ') };
}
