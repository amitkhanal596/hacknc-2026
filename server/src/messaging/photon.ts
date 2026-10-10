import {
  Spectrum,
  type Content,
  type Message,
  type Space,
  type Attachment,
} from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { and, eq } from "drizzle-orm";
import type { Runtime } from "../api/app";
import * as s from "../db/schema";
import { ensure } from "../domain/money";
import { flushOutbox } from "../jobs/reconcile";
function parts(content: Content): Content[] {
  return content.type === "group"
    ? content.items.flatMap((item: Message) => parts(item.content))
    : [content];
}
async function boundedRead(attachment: Attachment) {
  ensure(
    !attachment.size || attachment.size <= 4 * 1024 * 1024,
    "FILE_SIZE",
    "Image exceeds 4 MB.",
  );
  const reader = (await attachment.stream()).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      ensure(
        value instanceof Uint8Array,
        "FILE_TYPE",
        "Invalid attachment stream.",
      );
      size += value.byteLength;
      ensure(size <= 4 * 1024 * 1024, "FILE_SIZE", "Image exceeds 4 MB.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export async function startPhoton(runtime: Runtime) {
  const spectrum = await Spectrum({
    projectId: runtime.config.PHOTON_PROJECT_ID!,
    projectSecret: runtime.config.PHOTON_PROJECT_SECRET!,
    providers: [imessage.config()],
    telemetry: false,
    options: { logLevel: "error", flattenGroups: false },
  });
  const provider = imessage(spectrum);
  runtime.setPhotonState("listening");
  // DM recipient derives only from an authenticated provider identity previously observed.
  runtime.setLoginDelivery(async (providerId, token) => {
    const dm = await provider.space.create(providerId);
    await dm.send(
      `Open your private Tab (this sign-in link expires in 5 minutes and works once): ${runtime.config.APP_BASE_URL}/#login=${token}&identity=${encodeURIComponent(providerId)}\nThis opens your trip; it never authorizes a payment. Do not forward this private link.`,
    );
  });
  const send = async (
    group: typeof s.groups.$inferSelect,
    text: string,
    recipientId?: string | null,
  ) => {
    // Every new shared tab delivers one private message per opted-in member.
    ensure(
      recipientId,
      "DM_REQUIRED",
      "Legacy group delivery is disabled. Create a direct-message tab.",
    );
    runtime.ledger.member(group.id, recipientId);
    const identity = runtime.store.db
      .select()
      .from(s.identities)
      .where(
        and(
          eq(s.identities.userId, recipientId),
          eq(s.identities.provider, "photon"),
          eq(s.identities.verified, true),
        ),
      )
      .get();
    ensure(
      identity,
      "DM_IDENTITY",
      "Recipient must first message Tab using their registered Photon identity.",
    );
    const dm = await provider.space.create(identity.providerUserId);
    const token = runtime.auth.issue(
      recipientId,
      "login",
      identity.providerUserId,
    );
    const link = `${runtime.config.APP_BASE_URL}/trip/${group.id}#login=${token}&identity=${encodeURIComponent(identity.providerUserId)}`;
    // Mint private links at delivery time; never store them in the notification outbox.
    await dm.send(
      `${text}\nOpen your private tab: ${link}\nSign-in expires in 5 minutes. Do not forward this link. Opening it never authorizes a payment.`,
    );
    console.log("Photon: private update accepted by provider.");
  };
  const handle = async (space: Space, message: Message) => {
    if (
      message.direction !== "inbound" ||
      !message.sender ||
      message.sender.kind === "agent"
    )
      return;
    // Shared-plan MVP is DM-only: never treat a group message as private consent.
    if (imessage(space).type !== "dm") return;
    const content = parts(message.content);
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const attachment = content.find((c) => c.type === "attachment");
    if (!text.trim() && !attachment) return;
    runtime.setPhotonState("connected");
    console.log("Photon: inbound private request received.");
    const actorId = runtime.direct.observedIdentity(message.sender.id);
    const result = await runtime.direct.handle({
      provider: "photon",
      actorId,
      messageId: message.id,
      text,
      attachment:
        attachment?.type === "attachment"
          ? () => boundedRead(attachment)
          : undefined,
    });
    if (result.login) {
      const token = runtime.auth.issue(actorId, "login", message.sender.id);
      await space.send(
        `Your private Tab: ${runtime.config.APP_BASE_URL}${result.groupId ? `/trip/${result.groupId}` : "/"}#login=${token}&identity=${encodeURIComponent(message.sender.id)}\nSingle use, expires in 5 minutes. Do not forward this sign-in link. Opening it never authorizes payment.`,
      );
    } else await space.send(result.reply);
    await flushOutbox(runtime, send);
  };
  const loop = (async () => {
    try {
      for await (const [space, message] of spectrum.messages) {
        try {
          await handle(space, message);
        } catch {
          await space
            .send(
              "Tab could not process this request. Review the expense in the private dashboard. No payment was authorized.",
            )
            .catch(() => {});
        }
      }
    } finally {
      runtime.setPhotonState("disconnected");
      runtime.setLoginDelivery(null);
    }
  })();
  return { stop: () => spectrum.stop(), loop, send };
}
