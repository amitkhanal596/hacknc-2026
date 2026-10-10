export interface Member {
  id: string;
  name: string | null;
}

export interface TextInput {
  text: string;
  senderId: string;
  members: Member[];
  /** The sender's recent DMs with the bot, oldest first, for context. */
  recent: string[];
}

export interface TextExtraction {
  isExpense: boolean;
  /** False for things like "pay me $20" that don't say what the money was for. */
  hasReason: boolean;
  reason?: string;
  amountCents?: number;
  /** "all" means every group member. A list always includes whoever the text says. */
  participants: "all" | string[];
}

export interface ImageInput {
  data: Buffer;
  mimeType: string;
  members: Member[];
  caption?: string;
}

export interface ImageExtraction {
  kind: "receipt" | "chat_screenshot" | "other";
  merchant?: string;
  date?: string; // YYYY-MM-DD
  totalCents?: number;
  subtotalCents?: number;
  taxCents?: number;
  tipCents?: number;
  items?: { name: string; cents: number }[];
  /** For chat screenshots: the message text that describes the expense. */
  claimedText?: string;
  confidence: number; // 0..1
  /** True when no AI was available to look at the image (not the same as "not a receipt"). */
  unavailable?: boolean;
}

export interface Extractor {
  readonly name: string;
  extractFromText(input: TextInput): Promise<TextExtraction>;
  extractFromImage(input: ImageInput): Promise<ImageExtraction>;
}

/** Mime type used by the simulator and tests for fake receipts. The body is JSON (an ImageExtraction). */
export const FAKE_RECEIPT_MIME = "application/x-tab-fake-receipt";
