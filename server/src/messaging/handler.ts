import { and, eq } from "drizzle-orm";
import * as s from "../db/schema";
import { Ledger } from "../domain/ledger";
import {
  DomainError,
  ensure,
  formatMoney,
  parseDollars,
} from "../domain/money";
import { Extractor } from "../ai/extractor";
export type MessageEvent = {
  provider: "mock" | "photon";
  messageId: string;
  groupId: string;
  actorId: string;
  text: string;
  privateReply?: boolean;
  image?: { mime: string; base64: string };
  fixture?: "receipt" | "payment_screenshot";
};
export class MessageHandler {
  private locks = new Map<string, Promise<object>>();
  constructor(
    public ledger: Ledger,
    public extractor: Extractor,
  ) {}
  async handle(event: MessageEvent): Promise<object> {
    this.ledger.member(event.groupId, event.actorId);
    const key = `${event.provider}:${event.messageId}`;
    const running = this.locks.get(key);
    if (running) return running;
    const task = this.process(event);
    this.locks.set(key, task);
    try {
      return await task;
    } finally {
      this.locks.delete(key);
    }
  }
  private async process(e: MessageEvent) {
    const where = and(
      eq(s.processed.provider, e.provider),
      eq(s.processed.messageId, e.messageId),
    );
    const previous = this.ledger.db
      .select()
      .from(s.processed)
      .where(where)
      .get();
    if (previous?.result) {
      ensure(
        previous.groupId === e.groupId,
        "MESSAGE_CONFLICT",
        "Message belongs to another group.",
      );
      return JSON.parse(previous.result) as object;
    }
    if (!/^@tab\b/i.test(e.text)) return { ignored: true };
    this.ledger.db
      .insert(s.processed)
      .values({
        provider: e.provider,
        messageId: e.messageId,
        groupId: e.groupId,
        state: "processing",
      })
      .onConflictDoNothing()
      .run();
    let result: { reply: string; expenseId?: string; extraction?: unknown };
    try {
      const command = e.text.replace(/^@tab\s*/i, "").trim();
      if (/^ping$/i.test(command)) result = { reply: "Tab is online!" };
      else if (/^(pay|yes)$/i.test(command))
        result = {
          reply:
            "A chat message cannot authorize payment. Open your authenticated payment page and approve the exact intent.",
        };
      else if (/^(link|open|login)$/i.test(command))
        result = {
          reply:
            "In Photon, this sends a private, single-use sign-in link. In the local simulation, use the demo participant selector. Opening Tab never authorizes payment.",
        };
      else if (/^help$/i.test(command))
        result = {
          reply:
            "Try @tab link to open your private Tab. Expenses stay in this conversation. Try: @tab I paid $120 for groceries, split with everyone; @tab balances; @tab expenses; @tab settle; @tab confirm <expense-id>; @tab reject <expense-id>; @tab change <expense-id> dinner $84. Receipt photos require payer review. Use the private dashboard to pay.",
        };
      else if (/^create trip /i.test(command)) {
        ensure(
          this.ledger.member(e.groupId, e.actorId).role === "owner",
          "FORBIDDEN",
          "Only the group owner can rename the trip.",
          403,
        );
        this.ledger.db
          .update(s.groups)
          .set({ name: command.slice(12, 132) })
          .where(eq(s.groups.id, e.groupId))
          .run();
        result = {
          reply:
            "Trip ready. Members can track expenses without a wallet. Use @tab help to get started.",
        };
      } else if (/^balances$/i.test(command)) {
        const b = this.ledger.balances(e.groupId);
        result = {
          reply: `Group summary: ${b.filter((b) => b.cents < 0).length} people have outstanding balances. Total to settle: ${formatMoney(b.filter((b) => b.cents > 0).reduce((a, b) => a + b.cents, 0))}. Personal details are in the authenticated dashboard.`,
        };
      } else if (/^settle$/i.test(command)) {
        const plan = this.ledger.plan(e.groupId, e.actorId);
        result = {
          reply: `${plan.length} settlement requests ready. Open your authenticated dashboard to choose a method. No payment has been made.`,
        };
      } else if (/^expenses$/i.test(command)) {
        const list = this.ledger.db
          .select()
          .from(s.expenses)
          .where(eq(s.expenses.groupId, e.groupId))
          .all();
        result = {
          reply:
            list
              .map(
                (x) =>
                  `${x.id.slice(0, 8)} · ${x.description} · ${formatMoney(x.totalCents)} · ${x.status}`,
              )
              .join("\n") || "No expenses yet.",
        };
      } else if (/^(confirm|reject|change) /i.test(command)) {
        const [verb, shortId] = command.split(/\s+/);
        ensure(
          shortId && shortId.length >= 8,
          "EXPENSE_ID",
          "Specify at least eight characters of the expense ID.",
        );
        const matches = this.ledger.db
          .select()
          .from(s.expenses)
          .where(eq(s.expenses.groupId, e.groupId))
          .all()
          .filter((x) => x.id.startsWith(shortId));
        ensure(
          matches.length === 1,
          "EXPENSE_ID",
          "Expense ID is missing or ambiguous.",
        );
        const expense = matches[0]!;
        if (verb!.toLowerCase() === "change") {
          const match = command.match(
            /^change\s+\S+\s+(.+?)\s+\$(\d+(?:\.\d{1,2})?)$/i,
          );
          ensure(
            match,
            "EDIT_FORMAT",
            "Use @tab change <id> description $amount.",
          );
          this.ledger.revise(
            expense.id,
            e.actorId,
            match[1]!,
            parseDollars(match[2]!),
          );
          result = {
            reply:
              "Proposal revised. Review and explicitly confirm the updated amount.",
            expenseId: expense.id,
          };
        } else {
          this.ledger.review(
            expense.id,
            e.actorId,
            verb!.toLowerCase() as "confirm" | "reject",
          );
          result = {
            reply: `Expense ${verb!.toLowerCase() === "confirm" ? "confirmed" : "rejected"}.`,
            expenseId: expense.id,
          };
        }
      } else {
        const extracted = await this.extractor.parse({
          text: e.text,
          actorId: e.actorId,
          members: this.ledger.groupMembers(e.groupId),
          image: e.image,
          fixture: e.fixture,
        });
        if (
          !["expense_text", "expense_receipt", "invoice_or_bill"].includes(
            extracted.kind,
          )
        )
          result = {
            reply:
              extracted.kind === "payment_screenshot"
                ? "This is payment evidence only. Link it to a payment claim in your private dashboard; the recipient must independently confirm."
                : "I could not identify a clear expense. Enter the amount and participants.",
            extraction: extracted,
          };
        else {
          ensure(
            extracted.totalCents && extracted.participantIds.length,
            "NEEDS_REVIEW",
            "Specify the total and who should split this expense.",
          );
          const proposal = this.ledger.propose(e.actorId, {
            groupId: e.groupId,
            payerId: extracted.payerId,
            description: extracted.description,
            totalCents: extracted.totalCents,
            currency: extracted.currency,
            participants: extracted.participantIds,
            sourceId: `${e.provider}:${e.messageId}`,
          });
          result = {
            reply: `Proposed ${proposal.description} (${formatMoney(proposal.totalCents)}). ${proposal.payerId ? `Payer or owner: @tab confirm ${proposal.id.slice(0, 8)}` : "Who paid? Select the payer in the private review."} ${this.extractor.mode === "simulation" || e.fixture ? "[SIMULATED PARSER]" : "[Gemini proposal]"}`,
            expenseId: proposal.id,
            extraction: extracted,
          };
        }
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      result = { reply: error.message };
    }
    this.ledger.db.transaction(() => {
      this.ledger.db
        .update(s.processed)
        .set({ state: "done", result: JSON.stringify(result) })
        .where(where)
        .run();
      if (!e.privateReply) this.ledger.queue(e.groupId, result.reply);
    });
    return result;
  }
}
