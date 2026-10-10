export interface InboundImage {
  name: string;
  mimeType: string;
  read(): Promise<Buffer>;
}

/** One inbound 1:1 DM, already flattened (text + any images). */
export interface InboundDM {
  id: string;
  /** Sender handle: E.164 phone (e.g. +19195551234) or an Apple ID email. */
  from: string;
  text: string | null;
  images: InboundImage[];
  at: Date;
}

export type DMHandler = (dm: InboundDM) => Promise<void>;

export interface OutboundImage {
  data: Buffer;
  mimeType: string;
  name: string;
}

/**
 * The bot only ever talks 1:1. Nothing outside src/messaging knows which
 * provider is behind this (Spectrum, the simulator, or the test inbox).
 */
export interface Messenger {
  readonly name: string;
  send(to: string, text: string): Promise<void>;
  sendImage(to: string, image: OutboundImage): Promise<void>;
  /** Starts delivering inbound DMs to the handler. Resolves once listening has started. */
  listen(handler: DMHandler): Promise<void>;
  stop?(): Promise<void>;
}

/** Normalizes US numbers to E.164 so "+1 (919) 555-1234" and "9195551234" are the same person. */
export function normalizeHandle(handle: string): string {
  const h = handle.trim();
  if (h.includes("@")) return h.toLowerCase();
  const digits = h.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return h.startsWith("+") ? `+${digits}` : `+${digits}`;
}
