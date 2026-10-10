import { Spectrum, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { normalizeHandle, type DMHandler, type InboundImage, type Messenger } from "./types";

type Content = Message["content"];

/**
 * Photon Spectrum cloud, iMessage provider. Our plan only covers 1:1 chats, so
 * group-chat messages are ignored (with a one-time note back to the group).
 */
export class SpectrumMessenger implements Messenger {
  readonly name = "spectrum";
  private app?: Awaited<ReturnType<typeof Spectrum>>;
  private spaces = new Map<string, Space>();
  private warnedGroups = new Set<string>();
  private stopped = false;

  constructor(private opts: { projectId: string; projectSecret: string }) {}

  private async getApp() {
    if (!this.app) {
      this.app = await Spectrum({
        projectId: this.opts.projectId,
        projectSecret: this.opts.projectSecret,
        providers: [imessage.config()],
      });
    }
    return this.app;
  }

  async send(to: string, text: string): Promise<void> {
    const handle = normalizeHandle(to);
    let space = this.spaces.get(handle);
    if (!space) {
      const app = await this.getApp();
      space = await imessage(app).space.create(handle);
      this.spaces.set(handle, space);
    }
    await space.send(text);
  }

  async listen(handler: DMHandler): Promise<void> {
    const app = await this.getApp();
    void (async () => {
      for await (const [space, message] of app.messages) {
        if (this.stopped) break;
        try {
          await this.handleOne(space, message, handler);
        } catch (err) {
          console.error("[spectrum] failed to handle message", err);
        }
      }
    })();
  }

  private async handleOne(space: Space, message: Message, handler: DMHandler) {
    if (message.direction !== "inbound" || !message.sender) return;
    const imSpace = imessage.is(space) ? (space as Space & { type?: "dm" | "group" }) : undefined;
    if (imSpace?.type === "group") {
      if (!this.warnedGroups.has(space.id)) {
        this.warnedGroups.add(space.id);
        await space.send("Hi! I only work in 1:1 chats. Text me directly to log expenses for your group.");
      }
      return;
    }

    const from = normalizeHandle(message.sender.id);
    this.spaces.set(from, space);
    const { text, images } = flatten(message.content);
    if (!text && images.length === 0) return; // reactions, typing, read receipts, etc.

    await space.responding(() =>
      handler({ id: message.id, from, text: text || null, images, at: message.timestamp }),
    );
  }

  async stop() {
    this.stopped = true;
  }
}

function flatten(content: Content): { text: string; images: InboundImage[] } {
  const texts: string[] = [];
  const images: InboundImage[] = [];
  const visit = (c: Content) => {
    switch (c.type) {
      case "text":
        texts.push(c.text);
        break;
      case "attachment":
        if (c.mimeType.startsWith("image/")) images.push({ name: c.name, mimeType: c.mimeType, read: () => c.read() });
        break;
      case "group":
        for (const item of c.items) visit(item.content);
        break;
      default:
        break;
    }
  };
  visit(content);
  return { text: texts.join("\n").trim(), images };
}
