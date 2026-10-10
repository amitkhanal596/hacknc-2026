import { newId } from "../ids";
import { normalizeHandle, type DMHandler, type InboundImage, type Messenger, type OutboundImage } from "./types";

export interface SentDM {
  to: string;
  text: string;
  image?: OutboundImage;
}

/** In-memory messenger for tests and the simulator. */
export class MemoryMessenger implements Messenger {
  readonly name: string = "memory";
  readonly outbox: SentDM[] = [];
  private handler?: DMHandler;

  constructor(private onSend?: (dm: SentDM) => void) {}

  async send(to: string, text: string): Promise<void> {
    const dm = { to: normalizeHandle(to), text };
    this.outbox.push(dm);
    this.onSend?.(dm);
  }

  /** Images show up in the inbox as "[photo: name]" so tests and the simulator can see them. */
  async sendImage(to: string, image: OutboundImage): Promise<void> {
    const dm = { to: normalizeHandle(to), text: `[photo: ${image.name}]`, image };
    this.outbox.push(dm);
    this.onSend?.(dm);
  }

  async listen(handler: DMHandler): Promise<void> {
    this.handler = handler;
  }

  /** Simulates a person texting the bot. Resolves after the bot finishes handling it. */
  async receive(from: string, text: string | null, images: InboundImage[] = []): Promise<void> {
    if (!this.handler) throw new Error("listen() was not called");
    await this.handler({ id: newId("dm"), from: normalizeHandle(from), text, images, at: new Date() });
  }

  /** Messages sent to one person, optionally clearing them afterwards. */
  inbox(to: string, clear = false): string[] {
    const handle = normalizeHandle(to);
    const out = this.outbox.filter((m) => m.to === handle).map((m) => m.text);
    if (clear) this.clearInbox(to);
    return out;
  }

  clearInbox(to?: string) {
    if (!to) {
      this.outbox.length = 0;
      return;
    }
    const handle = normalizeHandle(to);
    for (let i = this.outbox.length - 1; i >= 0; i--) if (this.outbox[i]!.to === handle) this.outbox.splice(i, 1);
  }
}
