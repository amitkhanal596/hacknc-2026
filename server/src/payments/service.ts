import { and, eq, notInArray } from "drizzle-orm";
import * as s from "../db/schema";
import { Ledger, uid } from "../domain/ledger";
import { ensure } from "../domain/money";
import { Auth } from "../security/tokens";
import { ManualRail } from "./manual";
import type { PaymentMethod, PaymentRail } from "./types";
export class Payments {
  rails = new Map<PaymentMethod, PaymentRail>();
  constructor(
    public ledger: Ledger,
    public auth: Auth,
    solana: PaymentRail,
  ) {
    for (const method of ["venmo", "apple_cash", "zelle", "cash"] as const)
      this.rails.set(method, new ManualRail(method));
    this.rails.set("solana", solana);
  }
  rail(method: string) {
    const rail = this.rails.get(method as PaymentMethod);
    ensure(rail, "METHOD", "Unsupported payment method.");
    return rail;
  }
  party(id: string, actor: string) {
    const a = this.ledger.attempt(id),
      i = this.ledger.intent(a.intentId);
    this.ledger.member(i.groupId, actor);
    ensure(
      actor === i.fromId || actor === i.toId,
      "FORBIDDEN",
      "Only payment participants can view or act on this payment.",
      403,
    );
    return { a, i };
  }
  async choose(
    intentId: string,
    actor: string,
    method: PaymentMethod,
    key: string,
  ) {
    const i = this.ledger.intent(intentId);
    this.ledger.member(i.groupId, actor);
    ensure(
      i.fromId === actor,
      "FORBIDDEN",
      "Only the payer selects a method.",
      403,
    );
    ensure(
      i.status === "pending" && i.expiresAt > Date.now(),
      "STALE_INTENT",
      "Settlement is expired or resolved.",
      409,
    );
    const rail = this.rail(method);
    ensure(
      rail.capability.available,
      "RAIL_UNAVAILABLE",
      "Solana demo unavailable. Configure devnet before paying, or choose a manual method.",
      503,
    );
    const destination =
      this.ledger.db
        .select()
        .from(s.destinations)
        .where(
          and(
            eq(s.destinations.userId, i.toId),
            eq(s.destinations.method, method),
          ),
        )
        .get() ?? null;
    const instructions = await rail.prepare(i, destination);
    return this.ledger.db.transaction(() => {
      const fresh = this.ledger.intent(intentId);
      ensure(
        fresh.status === "pending" && fresh.expiresAt > Date.now(),
        "STALE_INTENT",
        "Settlement is expired or resolved.",
        409,
      );
      const prior = this.ledger.db
        .select()
        .from(s.attempts)
        .where(eq(s.attempts.idempotencyKey, `${actor}:${key}`))
        .get();
      if (prior) {
        ensure(
          prior.intentId === i.id && prior.method === method,
          "IDEMPOTENCY_CONFLICT",
          "Request key reused for another payment.",
          409,
        );
        return prior;
      }
      const active = this.ledger.db
        .select()
        .from(s.attempts)
        .where(
          and(
            eq(s.attempts.intentId, i.id),
            notInArray(s.attempts.status, ["cancelled", "failed", "expired"]),
          ),
        )
        .get();
      if (active) {
        ensure(
          active.method === method,
          "ATTEMPT_ACTIVE",
          "Cancel the untouched attempt before selecting another method.",
          409,
        );
        return active;
      }
      const id = uid();
      this.ledger.db
        .insert(s.attempts)
        .values({
          id,
          intentId,
          method,
          amountCents: i.amountCents,
          status: rail.capability.canExecuteFromBackend
            ? "awaiting_authorization"
            : "ready_for_external_payment",
          destination: JSON.stringify(instructions),
          idempotencyKey: `${actor}:${key}`,
        })
        .run();
      this.ledger.log(i.groupId, actor, "payment_prepared", id, { method });
      return this.ledger.attempt(id);
    });
  }
  claim(id: string, actor: string, note?: string, assetId?: string) {
    return this.ledger.db.transaction(() => {
      const { a, i } = this.party(id, actor);
      ensure(
        actor === i.fromId &&
          this.rail(a.method).capability.verification ===
            "recipient_confirmation",
        "FORBIDDEN",
        "Only the sender can claim a manual payment.",
        403,
      );
      if (a.status === "sender_claimed") return a;
      ensure(
        a.status === "ready_for_external_payment" &&
          i.status === "pending" &&
          i.expiresAt > Date.now(),
        "INVALID_TRANSITION",
        "Payment cannot be claimed in this state.",
        409,
      );
      if (assetId) {
        const asset = this.ledger.db
          .select()
          .from(s.assets)
          .where(eq(s.assets.id, assetId))
          .get();
        ensure(
          asset?.groupId === i.groupId &&
            asset.uploader === actor &&
            asset.purpose === "evidence",
          "FORBIDDEN",
          "Use payment evidence you uploaded for this group.",
          403,
        );
      }
      this.ledger.db
        .update(s.attempts)
        .set({ status: "sender_claimed", claimedAt: Date.now() })
        .where(eq(s.attempts.id, id))
        .run();
      if (note || assetId)
        this.ledger.db
          .insert(s.evidence)
          .values({ id: uid(), attemptId: id, note, assetId, uploader: actor })
          .run();
      this.ledger.log(i.groupId, actor, "claimed_by_sender", id);
      this.ledger.queue(
        i.groupId,
        "A settlement is awaiting independent recipient confirmation in the private dashboard.",
        this.ledger.isDirect(i.groupId) ? i.toId : undefined,
      );
      return this.ledger.attempt(id);
    });
  }
  confirm(id: string, actor: string) {
    const { a, i } = this.party(id, actor);
    ensure(
      actor === i.toId &&
        actor !== i.fromId &&
        this.rail(a.method).capability.verification ===
          "recipient_confirmation",
      "FORBIDDEN",
      "Only the intended recipient can confirm this manual payment.",
      403,
    );
    return this.ledger.applyCredit(id, actor, "recipient_confirmation");
  }
  dispute(id: string, actor: string) {
    return this.ledger.db.transaction(() => {
      const { a, i } = this.party(id, actor);
      ensure(
        actor === i.toId && a.status === "sender_claimed",
        "INVALID_TRANSITION",
        "Only the recipient can dispute a claimed payment.",
        403,
      );
      this.ledger.db
        .update(s.attempts)
        .set({ status: "disputed" })
        .where(eq(s.attempts.id, id))
        .run();
      this.ledger.log(i.groupId, actor, "payment_disputed", id);
      return this.ledger.attempt(id);
    });
  }
  cancel(id: string, actor: string) {
    return this.ledger.db.transaction(() => {
      const { a, i } = this.party(id, actor);
      ensure(
        actor === i.fromId &&
          ["ready_for_external_payment", "awaiting_authorization"].includes(
            a.status,
          ),
        "INVALID_TRANSITION",
        "Only untouched payments can be cancelled.",
        409,
      );
      this.ledger.db
        .update(s.attempts)
        .set({ status: "cancelled" })
        .where(eq(s.attempts.id, id))
        .run();
      this.ledger.log(i.groupId, actor, "payment_cancelled", id);
      return this.ledger.attempt(id);
    });
  }
  approval(id: string, actor: string) {
    const { a, i } = this.party(id, actor);
    ensure(
      actor === i.fromId &&
        a.status === "awaiting_authorization" &&
        !!this.rail(a.method).executeAuthorized &&
        i.expiresAt > Date.now(),
      "FORBIDDEN",
      "This payment cannot be authorized.",
      403,
    );
    return {
      token: this.auth.issue(
        actor,
        "payment",
        `${id}:${i.amountCents}:${i.toId}`,
      ),
      amountCents: i.amountCents,
      recipientId: i.toId,
    };
  }
  async authorize(
    id: string,
    actor: string,
    token: string,
    amountCents: number,
    recipientId: string,
  ) {
    const a = this.ledger.db.transaction(() => {
      const { a, i } = this.party(id, actor);
      ensure(
        actor === i.fromId &&
          amountCents === i.amountCents &&
          recipientId === i.toId &&
          a.status === "awaiting_authorization" &&
          i.status === "pending" &&
          i.expiresAt > Date.now(),
        "INVALID_AUTHORIZATION",
        "Approval must match the exact pending payment.",
        403,
      );
      ensure(
        this.rail(a.method).executeAuthorized,
        "METHOD",
        "This provider has no executable backend transfer.",
      );
      this.auth.consume(
        token,
        actor,
        "payment",
        `${id}:${amountCents}:${recipientId}`,
      );
      this.ledger.db
        .update(s.attempts)
        .set({ status: "submitting" })
        .where(eq(s.attempts.id, id))
        .run();
      this.ledger.log(i.groupId, actor, "payment_authorized", id);
      return this.ledger.attempt(id);
    });
    return this.rail(a.method).executeAuthorized!(a, {
      userId: actor,
      attemptId: id,
      amountCents,
      recipientId,
    });
  }
}
