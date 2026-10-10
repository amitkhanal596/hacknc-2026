import { and, desc, eq } from "drizzle-orm";
import type { Ctx } from "../context";
import { payments, type Payment } from "../db/schema";
import { newId } from "../ids";
import type { LedgerPayment } from "../ledger/settle";

export function insertPayment(ctx: Ctx, p: Pick<Payment, "groupId" | "fromId" | "toId" | "cents" | "rail">): Payment {
  const row: Payment = {
    ...p,
    id: newId("pay"),
    status: "pending",
    solanaTxSig: null,
    simulated: false,
    stripePaymentIntentId: null,
    stripeChargeId: null,
    stripeTransferId: null,
    createdAt: ctx.now(),
    confirmedAt: null,
  };
  ctx.db.insert(payments).values(row).run();
  return row;
}

export function updatePayment(ctx: Ctx, id: string, patch: Partial<Omit<Payment, "id">>): Payment {
  ctx.db.update(payments).set(patch).where(eq(payments.id, id)).run();
  return getPayment(ctx, id)!;
}

export function getPayment(ctx: Ctx, id: string): Payment | undefined {
  return ctx.db.select().from(payments).where(eq(payments.id, id)).get();
}

export function paymentByIntent(ctx: Ctx, intentId: string): Payment | undefined {
  return ctx.db.select().from(payments).where(eq(payments.stripePaymentIntentId, intentId)).get();
}

export function paymentsOf(ctx: Ctx, groupId: string): Payment[] {
  return ctx.db.select().from(payments).where(eq(payments.groupId, groupId)).orderBy(desc(payments.createdAt)).all();
}

export function ledgerPaymentsForGroup(ctx: Ctx, groupId: string): LedgerPayment[] {
  return paymentsOf(ctx, groupId).map(({ fromId, toId, cents, status }) => ({ fromId, toId, cents, status }));
}

export function heldPaymentsTo(ctx: Ctx, toId: string): Payment[] {
  return ctx.db.select().from(payments).where(and(eq(payments.toId, toId), eq(payments.status, "held"))).all();
}
