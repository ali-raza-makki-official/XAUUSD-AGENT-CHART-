import { z } from 'zod';

export const CommandOrigin = z.enum(['desktop', 'whatsapp', 'ai', 'rule', 'mobile', 'web']);
export type CommandOrigin = z.infer<typeof CommandOrigin>;

/**
 * Every action (manual, AI, WhatsApp...) travels as one of these through the same pipeline:
 * identity/permission -> validation -> risk -> action -> broker result -> activity log.
 */
export const CommandEnvelopeSchema = z.object({
  /** Idempotency key. Retries and double clicks reuse the same id and never execute twice. */
  id: z.string().min(8),
  type: z.string().min(1),
  origin: CommandOrigin,
  actor: z.string().min(1),
  createdAt: z.number().int(),
  /** Unix ms after which the command must not execute. */
  expiresAt: z.number().int(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

export const isExpired = (cmd: Pick<CommandEnvelope, 'expiresAt'>, now = Date.now()) =>
  now >= cmd.expiresAt;

/** Order lifecycle. "executed" may only be reported to the user from `confirmed`. */
export type OrderState =
  | 'requested'
  | 'validation_failed'
  | 'sent_to_broker'
  | 'confirmed'
  | 'rejected'
  | 'unknown_reconcile';

const TRANSITIONS: Record<OrderState, OrderState[]> = {
  requested: ['validation_failed', 'sent_to_broker'],
  validation_failed: [],
  sent_to_broker: ['confirmed', 'rejected', 'unknown_reconcile'],
  confirmed: [],
  rejected: [],
  // Resolved only after checking broker positions/history, never by blind re-send.
  unknown_reconcile: ['confirmed', 'rejected'],
};

export const canTransition = (from: OrderState, to: OrderState) => TRANSITIONS[from].includes(to);

export interface RegisterResult<T> {
  fresh: boolean;
  record: T;
}

/** Remembers the outcome per command id so a duplicate returns the earlier result. */
export class IdempotencyRegistry<T> {
  private readonly seen = new Map<string, T>();

  register(id: string, create: () => T): RegisterResult<T> {
    const existing = this.seen.get(id);
    if (existing !== undefined) return { fresh: false, record: existing };
    const record = create();
    this.seen.set(id, record);
    return { fresh: true, record };
  }

  get(id: string): T | undefined {
    return this.seen.get(id);
  }
}
