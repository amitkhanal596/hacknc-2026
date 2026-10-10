import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import * as s from "../db/schema";
import { Ledger, uid } from "../domain/ledger";
import { DomainError, ensure } from "../domain/money";
import { hash } from "../security/tokens";
import type { MessageHandler } from "./handler";
import type { Assets } from "../api/assets";
type Provider = "photon" | "mock";
export type DirectResult = { reply: string; groupId?: string; login?: boolean };
export class DirectTabs {
  private locks = new Map<string, Promise<DirectResult>>();
  constructor(
    public ledger: Ledger,
    private messages: MessageHandler,
    private assets: Assets,
    private baseUrl: string,
  ) {}
  observedIdentity(providerId: string) {
    const db = this.ledger.db;
    const existing = db
      .select()
      .from(s.identities)
      .where(
        and(
          eq(s.identities.provider, "photon"),
          eq(s.identities.providerUserId, providerId),
        ),
      )
      .get();
    if (existing) return existing.userId;
    return db.transaction(() => {
      const id = uid();
      db.insert(s.users)
        .values({ id, name: `Guest ${id.slice(0, 4)}` })
        .run();
      db.insert(s.identities)
        .values({
          id: uid(),
          userId: id,
          provider: "photon",
          providerUserId: providerId,
          verified: true,
        })
        .run();
      return id;
    });
  }
  list(actor: string, provider: Provider) {
    return this.ledger.db
      .select({ group: s.groups })
      .from(s.groups)
      .innerJoin(s.members, eq(s.members.groupId, s.groups.id))
      .where(and(eq(s.members.userId, actor), eq(s.groups.provider, provider)))
      .all()
      .map((r) => r.group)
      .filter((g) => this.ledger.isDirect(g.id));
  }
  select(actor: string, groupId: string, provider: Provider) {
    const group = this.list(actor, provider).find((g) => g.id === groupId);
    ensure(group, "FORBIDDEN", "Join this tab before selecting it.", 403);
    this.ledger.db
      .insert(s.dmContexts)
      .values({ userId: actor, groupId })
      .onConflictDoUpdate({ target: s.dmContexts.userId, set: { groupId } })
      .run();
    return group;
  }
  active(actor: string, provider: Provider) {
    const context = this.ledger.db
      .select()
      .from(s.dmContexts)
      .where(eq(s.dmContexts.userId, actor))
      .get();
    const group = this.list(actor, provider).find(
      (g) => g.id === context?.groupId,
    );
    ensure(
      group,
      "NO_TAB",
      'Create a tab with "create Tahoe", or text "join <invite-code>". Text "tabs" to see your tabs.',
    );
    return group;
  }
  create(actor: string, name: string, provider: Provider, requestId: string) {
    ensure(
      name.trim().length > 0 && name.length <= 100,
      "NAME",
      "Use a tab name between 1 and 100 characters.",
    );
    const db = this.ledger.db;
    return db.transaction(() => {
      const spaceId = `dm-tab:${actor}:${requestId}`;
      let group = db
        .select()
        .from(s.groups)
        .where(
          and(eq(s.groups.provider, provider), eq(s.groups.spaceId, spaceId)),
        )
        .get();
      if (!group) {
        const id = uid();
        db.insert(s.groups)
          .values({ id, name: name.trim(), provider, spaceId })
          .run();
        db.insert(s.members)
          .values({ groupId: id, userId: actor, role: "owner" })
          .run();
        group = db.select().from(s.groups).where(eq(s.groups.id, id)).get()!;
        this.ledger.log(id, actor, "tab_created", id);
      }
      this.select(actor, group.id, provider);
      return group;
    });
  }
  invite(actor: string, groupId: string) {
    ensure(
      this.ledger.member(groupId, actor).role === "owner",
      "FORBIDDEN",
      "Only the organizer can create invitations.",
      403,
    );
    ensure(
      this.ledger.isDirect(groupId),
      "NOT_DIRECT",
      "Create a direct-message tab first.",
    );
    const code = randomBytes(18).toString("base64url");
    this.ledger.db
      .insert(s.tabInvites)
      .values({
        hash: hash(code),
        groupId,
        expiresAt: Date.now() + 7 * 86400_000,
      })
      .run();
    return {
      code,
      url: `${this.baseUrl}/join#invite=${code}`,
      expiresInDays: 7,
    };
  }
  revoke(actor: string, groupId: string) {
    ensure(
      this.ledger.member(groupId, actor).role === "owner",
      "FORBIDDEN",
      "Only the organizer can revoke invitations.",
      403,
    );
    this.ledger.db
      .update(s.tabInvites)
      .set({ revokedAt: Date.now() })
      .where(
        and(eq(s.tabInvites.groupId, groupId), isNull(s.tabInvites.revokedAt)),
      )
      .run();
  }
  join(actor: string, code: string, provider: Provider) {
    return this.ledger.db.transaction(() => {
      const invite = this.ledger.db
        .select()
        .from(s.tabInvites)
        .where(eq(s.tabInvites.hash, hash(code)))
        .get();
      ensure(
        invite && !invite.revokedAt && invite.expiresAt > Date.now(),
        "INVITE_INVALID",
        "This invitation expired or was revoked. Ask the organizer for a new link.",
        403,
      );
      const group = this.ledger.db
        .select()
        .from(s.groups)
        .where(eq(s.groups.id, invite.groupId))
        .get()!;
      ensure(
        group.provider === provider,
        "INVITE_SCOPE",
        "Use a verified Photon sign-in for live invites; demo identities can only join simulated tabs.",
        403,
      );
      const existing = this.ledger.db
        .select()
        .from(s.members)
        .where(
          and(eq(s.members.groupId, group.id), eq(s.members.userId, actor)),
        )
        .get();
      ensure(
        existing || this.ledger.groupMembers(group.id).length < 100,
        "TAB_FULL",
        "This tab has reached its participant limit.",
      );
      this.ledger.db
        .insert(s.members)
        .values({ groupId: group.id, userId: actor })
        .onConflictDoNothing()
        .run();
      this.select(actor, group.id, provider);
      if (!existing) this.ledger.log(group.id, actor, "member_joined", actor);
      return group;
    });
  }
  async handle(input: {
    actorId: string;
    provider: Provider;
    messageId: string;
    text: string;
    attachment?: () => Promise<Uint8Array>;
  }) {
    const requestKey = `${input.provider}:${input.messageId}`;
    const existing = this.ledger.db
      .select()
      .from(s.dmRequests)
      .where(eq(s.dmRequests.key, requestKey))
      .get();
    if (existing) {
      ensure(
        existing.actorId === input.actorId,
        "MESSAGE_CONFLICT",
        "Message identity mismatch.",
        403,
      );
      return JSON.parse(existing.result) as DirectResult;
    }
    const running = this.locks.get(requestKey);
    if (running) return running;
    const task = this.process(input).then((result) => {
      this.ledger.db
        .insert(s.dmRequests)
        .values({
          key: requestKey,
          actorId: input.actorId,
          result: JSON.stringify(result),
        })
        .run();
      return result;
    });
    this.locks.set(requestKey, task);
    try {
      return await task;
    } finally {
      this.locks.delete(requestKey);
    }
  }
  private async process(input: {
    actorId: string;
    provider: Provider;
    messageId: string;
    text: string;
    attachment?: () => Promise<Uint8Array>;
  }): Promise<DirectResult> {
    const { actorId: actor, provider } = input;
    const text = input.text.replace(/^@tab\s*/i, "").trim();
    const db = this.ledger.db;
    try {
      ensure(
        text.length <= 4000,
        "MESSAGE_SIZE",
        "Please keep messages under 4,000 characters.",
      );
      if (/^ping$/i.test(text)) return { reply: "Tab is online!" };
      if (/^(stop|start)$/i.test(text)) {
        const enabled = /^start$/i.test(text);
        db.transaction(() => {
          db.insert(s.dmPreferences)
            .values({ userId: actor, enabled })
            .onConflictDoUpdate({
              target: s.dmPreferences.userId,
              set: { enabled },
            })
            .run();
          if (!enabled)
            db.update(s.outbox)
              .set({ state: "suppressed" })
              .where(
                and(
                  eq(s.outbox.recipientId, actor),
                  eq(s.outbox.state, "pending"),
                ),
              )
              .run();
        });
        return {
          reply: enabled
            ? "Tab updates resumed. Previous missed updates are not resent."
            : "Tab updates paused for all your tabs. Text START to resume. You can still ask questions and open your dashboard.",
        };
      }
      if (/^name\s+/i.test(text)) {
        const name = text.replace(/^name\s+/i, "");
        ensure(
          name.length <= 60,
          "NAME",
          "Keep your name under 60 characters.",
        );
        db.update(s.users).set({ name }).where(eq(s.users.id, actor)).run();
        return { reply: `You're ${name} in Tab.` };
      }
      if (/^(hi|hello|help|)$/i.test(text) && !input.attachment)
        return {
          reply:
            'Hi, I’m Tab. Text "name Alex", then "create Tahoe" or "join <invite-code>". Each person talks to me privately. After everyone joins, describe a purchase or send a receipt. Text "invite", "tabs", "use <tab-id>", "link", or STOP. No wallet needed; messages never authorize a payment.',
        };
      if (/^tabs$/i.test(text))
        return {
          reply:
            this.list(actor, provider)
              .map((g) => `${g.id.slice(0, 8)} · ${g.name}`)
              .join("\n") ||
            'No tabs yet. Text "create Tahoe" or "join <invite-code>".',
        };
      if (/^create\s+(?:(?:trip|tab)\s+)?(.+)$/i.test(text)) {
        const name = text.match(/^create\s+(?:(?:trip|tab)\s+)?(.+)$/i)![1]!;
        const group = this.create(actor, name, provider, input.messageId);
        return {
          groupId: group.id,
          reply: `${group.name} is ready (${group.id.slice(0, 8)}). Text "invite" for a shareable link. Ask friends to join before confirming a split. Text "link" for your private dashboard.`,
        };
      }
      if (/^join\s+/i.test(text)) {
        const group = this.join(actor, text.replace(/^join\s+/i, ""), provider);
        return {
          groupId: group.id,
          reply: `You joined ${group.name}. You can view its shared expense history and receive private expense updates (STOP to pause). Existing splits stay unchanged. Text "name Your Name", then "link" to open your dashboard.`,
        };
      }
      if (/^use\s+/i.test(text)) {
        const prefix = text.replace(/^use\s+/i, "");
        const matches = this.list(actor, provider).filter(
          (g) => prefix.length >= 8 && g.id.startsWith(prefix),
        );
        ensure(
          matches.length === 1,
          "TAB_ID",
          'Text "tabs", then "use <tab-id>" with at least eight characters.',
        );
        const group = this.select(actor, matches[0]!.id, provider);
        return {
          reply: `Active tab: ${group.name}. New purchases go here.`,
          groupId: group.id,
        };
      }
      // Sign-in also works before joining a tab, so a browser invite can be accepted.
      if (/^(link|open|login)$/i.test(text))
        return {
          reply: "Open your private Tab.",
          login: true,
          groupId: this.list(actor, provider).find(
            (g) =>
              g.id ===
              db
                .select()
                .from(s.dmContexts)
                .where(eq(s.dmContexts.userId, actor))
                .get()?.groupId,
          )?.id,
        };
      const group = this.active(actor, provider);
      if (/^invite$/i.test(text)) {
        const invitation = this.invite(actor, group.id);
        return {
          groupId: group.id,
          reply: `Invite friends to ${group.name}: ${invitation.url}\nOr have them text me: join ${invitation.code}\nAnyone with this invite can join and see the shared expense history. Joining opts into private updates; STOP pauses them. Expires in 7 days. Each live tester must first be registered in Photon's Users tab. Never share your private sign-in link.`,
        };
      }
      if (/^revoke invites$/i.test(text)) {
        this.revoke(actor, group.id);
        return {
          groupId: group.id,
          reply:
            "Outstanding invitations revoked. Existing members keep access.",
        };
      }
      if (input.attachment) {
        ensure(
          !this.ledger.pending(group.id).length,
          "PLAN_ACTIVE",
          "Resolve the current settlement plan before adding another expense.",
        );
        const bytes = await input.attachment();
        const result = await this.assets.upload(
          actor,
          group.id,
          bytes,
          "expense",
          /\beveryone\b/i.test(text)
            ? this.ledger.groupMembers(group.id).map((m) => m.id)
            : [],
        );
        return {
          groupId: group.id,
          reply: result.expenseId
            ? `${group.name}: receipt proposal ${result.expenseId.slice(0, 8)} is ready. Text "link" to review the payer, amount and participants, then confirm. No one is charged automatically.`
            : "This image is evidence or unclear, not a confirmed purchase or payment. Text link to review privately.",
        };
      }
      const response = (await this.messages.handle({
        provider,
        actorId: actor,
        groupId: group.id,
        messageId: `dm:${input.messageId}`,
        text: `@tab ${text}`,
        privateReply: true,
      })) as { reply: string };
      return { reply: `${group.name}: ${response.reply}`, groupId: group.id };
    } catch (error) {
      if (error instanceof DomainError) return { reply: error.message };
      throw error;
    }
  }
}
