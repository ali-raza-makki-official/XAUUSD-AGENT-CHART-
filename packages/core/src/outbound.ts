/**
 * Minimal outbound-notification contract. The alerts worker has its own `NotificationChannel`;
 * the lead bridges the two (a NotificationChannel adapter calls `OutboundChannel.send`).
 * Nothing here knows about WhatsApp.
 */
export type OutboundPriority = 'critical' | 'normal' | 'low';

export interface OutboundImage {
  bytes: Uint8Array;
  /** image/png or image/jpeg for WhatsApp (5 MB limit). */
  mimeType: string;
  filename?: string;
}

export interface OutboundEvent {
  /** Stable id of the event (for logging and de-duplication). */
  id: string;
  /** Free-form event kind, e.g. 'alert_hit', 'position_closed', 'feed_stale'. */
  kind: string;
  priority: OutboundPriority;
  text: string;
  image?: OutboundImage;
  /** Events about orders/positions are never blindly re-sent when the outcome of a send is unknown. */
  tradeRelated?: boolean;
  /** A newer queued event with the same key replaces an older one that has not been sent yet. */
  dedupeKey?: string;
  createdAt: number;
}

export type OutboundStatus = 'sent' | 'failed' | 'unknown' | 'dropped';
export interface OutboundResult {
  status: OutboundStatus;
  /** Human-readable reason for anything other than 'sent'. Never contains secrets. */
  detail?: string;
}

export interface OutboundChannel {
  readonly id: string;
  send(event: OutboundEvent): Promise<OutboundResult>;
}
