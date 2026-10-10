import { createHash } from "node:crypto";
import type { ImageExtraction } from "../ai";
import type { Ctx } from "../context";
import { timings } from "../context";
import { ASK_NAME, flagBadges, HELP, joinInvite, listOf, railLabel, splitSummary, WELCOME_NO_GROUP } from "../copy";
import type { Expense, ExpenseFlag, Group, User } from "../db/schema";
import { groupDebts } from "../ledger/debts";
import { formatCents as $ } from "../ledger/money";
import { splitEqual } from "../ledger/splits";
import { mismatchTolerance, validateExpense, type ReceiptInfo } from "../ledger/validate";
import type { InboundDM } from "../messaging/types";
import { dm } from "../notify";
import { notifyCreditor, paySolana, payoutsOnboardingLink } from "../payments/service";
import { clearPrompt, getPrompt, logDM, recentInbound, setPrompt } from "../store/dms";
import {
  applyShareAction,
  createExpense,
  getExpense,
  latestDisputedExpense,
  pendingSharesFor,
  receiptHistory,
  reviseExpense,
  shareDetails,
  sharesOf,
  userSharesInGroup,
  withdrawExpense,
  type ShareDetail,
} from "../store/expenses";
import { activeGroup, addMember, createGroup, findUserGroup, getGroup, getGroupByCode, groupsOf, isMember, membersOf } from "../store/groups";
import { ensureWallet, getOrCreateUser, getUser, nameOf, updateUser } from "../store/users";
import { looksLikeName, parseCommand, type Command } from "./commands";
import { explain } from "./explain";
import { approvalText, sendApprovalRequests, settleText } from "./messages";

/** Entry point for every inbound 1:1 DM. */
export async function handleDM(ctx: Ctx, msg: InboundDM): Promise<void> {
  let user = getOrCreateUser(ctx, msg.from);
  const text = msg.text?.trim() ?? "";
  const dmId = logDM(ctx, user.id, "in", text || null, msg.images.length ? `image:${msg.images[0]!.mimeType}` : undefined);
  const reply = (t: string) => dm(ctx, user.id, t);

  try {
    const command = msg.images.length === 0 ? parseCommand(text) : undefined;
    if (command) return await runCommand(ctx, user, command, reply);

    // "What should I call you?"
    const namePrompt = getPrompt(ctx, user.id, "name");
    if (namePrompt && msg.images.length === 0) {
      const name = looksLikeName(text);
      if (name) {
        user = updateUser(ctx, user.id, { displayName: name });
        clearPrompt(ctx, user.id, "name");
        await reply(`Nice to meet you, ${name}! Text me receipts or things like "paid $40 for snacks" and I'll keep track.`);
        if (namePrompt.announceGroupId) await announceJoin(ctx, user, namePrompt.announceGroupId);
        return;
      }
    }

    const group = activeGroup(ctx, user);
    if (!group) return await reply(WELCOME_NO_GROUP);

    // A photo from a payer whose expense was disputed: attach it as the receipt.
    const fixPrompt = getPrompt(ctx, user.id, "fix");
    if (fixPrompt && msg.images.length > 0) {
      const expense = getExpense(ctx, fixPrompt.expenseId);
      if (expense?.status === "active") return await attachReceipt(ctx, user, expense, msg, reply);
    }

    // "What was the $20 for?" → "firewood"
    const reasonPrompt = getPrompt(ctx, user.id, "reason");
    if (reasonPrompt && msg.images.length === 0 && text && !/\d/.test(text) && text.split(/\s+/).length <= 5) {
      clearPrompt(ctx, user.id, "reason");
      const g = getGroup(ctx, reasonPrompt.groupId) ?? group;
      return await recordExpense(ctx, user, g, {
        reason: text.replace(/^(it was |for |it's |its )/i, "").trim(),
        totalCents: reasonPrompt.amountCents,
        participants: reasonPrompt.participants,
        sourceText: reasonPrompt.sourceText ? `${reasonPrompt.sourceText} / ${text}` : text,
        dmId,
        reply,
      });
    }

    return await captureExpense(ctx, user, group, msg, dmId, reply);
  } catch (err) {
    console.error("[bot] error handling DM", err);
    await reply("Sorry, something went wrong on my end. Try that again in a moment.");
  }
}

type Reply = (text: string) => Promise<void>;

/** "What was the $20 for?" only waits briefly, so a later unrelated message isn't taken as the answer. */
const REASON_PROMPT_TTL_MS = 15 * 60 * 1000;

// ------------------------------------------------------------------ commands

async function runCommand(ctx: Ctx, user: User, cmd: Command, reply: Reply): Promise<void> {
  const group = activeGroup(ctx, user);
  const needGroup = async () => {
    await reply(WELCOME_NO_GROUP);
    return undefined;
  };

  switch (cmd.type) {
    case "help":
      return reply(groupsOf(ctx, user.id).length ? HELP : WELCOME_NO_GROUP);

    case "new": {
      const g = createGroup(ctx, user, cmd.name, cmd.kind);
      await ensureWallet(ctx, user);
      await reply(`${g.name} created! Paste this in your group chat so people can join:`);
      await reply(joinInvite(g, ctx.config.botHandle));
      if (!user.displayName) {
        setPrompt(ctx, user.id, { kind: "name" }, timings(ctx.config).promptTtlMs);
        await reply(ASK_NAME);
      }
      return;
    }

    case "join": {
      const g = getGroupByCode(ctx, cmd.code);
      if (!g) return reply(`I couldn't find a group with code ${cmd.code}. Double-check it with whoever invited you.`);
      const added = addMember(ctx, g.id, user.id);
      if (cmd.name) user = updateUser(ctx, user.id, { displayName: cmd.name });
      await ensureWallet(ctx, user);
      const others = membersOf(ctx, g.id).filter((m) => m.id !== user.id).map(nameOf);
      if (!added) return reply(`You're already in ${g.name}. I've made it your active group.`);
      await reply(
        `You're in ${g.name}${others.length ? ` with ${listOf(others)}` : ""}! Text me receipts or "paid $X for Y" and I'll keep track. I'll ask before you owe anything.`,
      );
      if (user.displayName) return announceJoin(ctx, user, g.id);
      setPrompt(ctx, user.id, { kind: "name", announceGroupId: g.id }, timings(ctx.config).promptTtlMs);
      return reply(ASK_NAME);
    }

    case "use": {
      const g = findUserGroup(ctx, user.id, cmd.query);
      if (!g) return reply(`You're not in a group called "${cmd.query}". Text GROUPS to see yours.`);
      updateUser(ctx, user.id, { activeGroupId: g.id });
      return reply(`Switched to ${g.name}. New expenses will go there.`);
    }

    case "groups": {
      const mine = groupsOf(ctx, user.id);
      if (!mine.length) return reply(WELCOME_NO_GROUP);
      const lines = mine.map((g) => `${g.id === group?.id ? "▶" : "•"} ${g.name} (code ${g.joinCode})`);
      return reply(`Your groups:\n${lines.join("\n")}\nText USE <name> to switch.`);
    }

    case "name":
      updateUser(ctx, user.id, { displayName: cmd.name });
      clearPrompt(ctx, user.id, "name");
      return reply(`Got it, I'll call you ${cmd.name}.`);

    case "balance":
      if (!group) return void (await needGroup());
      return reply(balanceText(ctx, user, group));

    case "settle":
      if (!group) return void (await needGroup());
      return settle(ctx, user, group, reply);

    case "pay":
      if (!group) return void (await needGroup());
      return pay(ctx, user, group, cmd.who, reply);

    case "why": {
      if (!group) return void (await needGroup());
      const who = cmd.who ? findMember(ctx, group, cmd.who, user.id) : undefined;
      if (cmd.who && !who) return reply(explain(ctx, user, group));
      return reply(explain(ctx, user, group, who?.id));
    }

    case "yes":
      return approve(ctx, user, cmd, reply);

    case "dispute":
      return dispute(ctx, user, cmd, reply);

    case "fix":
    case "withdraw": {
      const prompt = getPrompt(ctx, user.id, "fix");
      const fromPrompt = prompt ? getExpense(ctx, prompt.expenseId) : undefined;
      const expense = fromPrompt?.status === "active" ? fromPrompt : latestDisputedExpense(ctx, user.id);
      if (!expense || expense.payerId !== user.id) return reply("None of your expenses are disputed right now.");
      clearPrompt(ctx, user.id, "fix");
      if (cmd.type === "withdraw") return withdraw(ctx, user, expense, reply);
      return revise(ctx, user, expense, { totalCents: cmd.cents }, reply);
    }

    case "payouts": {
      const link = await payoutsOnboardingLink(ctx, user.id);
      if (!link) return reply("Card and Apple Pay payouts aren't set up on this server yet. You can still get paid in USDC.");
      return reply(`Set up payouts (takes ~2 minutes) so Apple Pay payments land in your bank: ${link}`);
    }
  }
}

async function announceJoin(ctx: Ctx, user: User, groupId: string) {
  const g = getGroup(ctx, groupId);
  if (!g) return;
  for (const m of membersOf(ctx, groupId)) {
    if (m.id !== user.id) await dm(ctx, m.id, `👋 ${nameOf(user)} joined ${g.name}.`);
  }
}

function findMember(ctx: Ctx, group: Group, query: string, excludeId?: string): User | undefined {
  const q = query.toLowerCase().trim();
  const members = membersOf(ctx, group.id).filter((m) => m.id !== excludeId);
  return (
    members.find((m) => m.displayName?.toLowerCase() === q) ??
    members.find((m) => q.split(/\s+/).some((w) => m.displayName?.toLowerCase() === w)) ??
    members.find((m) => m.displayName?.toLowerCase().startsWith(q))
  );
}

function balanceText(ctx: Ctx, user: User, group: Group): string {
  const debts = groupDebts(ctx, group.id);
  const iOwe = debts.filter((d) => d.fromId === user.id).map((d) => `${nameOf(getUser(ctx, d.toId))} ${$(d.cents)}`);
  const owedMe = debts.filter((d) => d.toId === user.id).map((d) => `${nameOf(getUser(ctx, d.fromId))} owes you ${$(d.cents)}`);
  const pending = pendingSharesFor(ctx, user.id).filter((p) => p.group.id === group.id).length;
  const lines = [`${group.name}:`];
  if (iOwe.length) lines.push(`You owe ${listOf(iOwe)}.`);
  if (owedMe.length) lines.push(`${owedMe.join(". ")}.`);
  if (!iOwe.length && !owedMe.length) lines.push("You're all settled up.");
  if (pending) lines.push(`${pending} expense${pending > 1 ? "s" : ""} waiting on your OK (reply YES or DISPUTE).`);
  return lines.join("\n");
}

async function settle(ctx: Ctx, user: User, group: Group, reply: Reply) {
  const debts = groupDebts(ctx, group.id);
  if (debts.length === 0) {
    const pending = membersOf(ctx, group.id).reduce((n, m) => n + pendingSharesFor(ctx, m.id).filter((p) => p.group.id === group.id).length, 0);
    return reply(`Everyone's settled up in ${group.name} 🎉${pending ? ` (${pending} expense share${pending > 1 ? "s are" : " is"} still waiting for approval.)` : ""}`);
  }
  const summary = debts.map((d) => `• ${nameOf(getUser(ctx, d.fromId))} → ${nameOf(getUser(ctx, d.toId))} ${$(d.cents)}`);
  await reply(`Sent settle-up texts for ${group.name}:\n${summary.join("\n")}`);
  for (const debtorId of new Set(debts.map((d) => d.fromId))) {
    const text = settleText(ctx, group, debtorId);
    if (text) await dm(ctx, debtorId, text);
  }
}

async function pay(ctx: Ctx, user: User, group: Group, who: string | undefined, reply: Reply) {
  let mine = groupDebts(ctx, group.id).filter((d) => d.fromId === user.id);
  if (who) {
    const target = findMember(ctx, group, who, user.id);
    if (!target) return reply(`I don't see anyone named "${who}" in ${group.name}.`);
    mine = mine.filter((d) => d.toId === target.id);
  }
  if (mine.length === 0) return reply(`You don't owe anyone in ${group.name} right now.`);

  const sent: string[] = [];
  const failed: string[] = [];
  let total = 0;
  let simulated = false;
  for (const d of mine) {
    const result = await paySolana(ctx, { groupId: group.id, fromId: user.id, toId: d.toId });
    const name = nameOf(getUser(ctx, d.toId));
    if (result.ok) {
      total += result.payment.cents;
      simulated ||= result.payment.simulated;
      sent.push(`${name} ${$(result.payment.cents)}${result.explorerUrl ? ` ${result.explorerUrl}` : ""}`);
      await notifyCreditor(ctx, result.payment, result.explorerUrl);
    } else {
      failed.push(`${name}: ${result.message}`);
    }
  }
  const lines: string[] = [];
  if (sent.length) lines.push(`✅ Sent ${$(total)} ${railLabel({ rail: "solana", simulated })}:\n${sent.map((s) => `• ${s}`).join("\n")}`);
  if (failed.length) lines.push(`Couldn't pay:\n${failed.map((f) => `• ${f}`).join("\n")}`);
  return reply(lines.join("\n\n"));
}

// ------------------------------------------------------------------ approvals & disputes

/** The numbered list the user last saw (if still valid), otherwise their current pending shares. */
function numberedPending(ctx: Ctx, user: User): ShareDetail[] {
  const pending = pendingSharesFor(ctx, user.id);
  const prompt = getPrompt(ctx, user.id, "approve");
  if (!prompt) return pending;
  const stillPending = new Set(pending.map((p) => p.share.id));
  const listed = shareDetails(ctx, prompt.shareIds);
  return listed.every((d) => stillPending.has(d.share.id)) ? listed : pending;
}

async function approve(ctx: Ctx, user: User, cmd: Extract<Command, { type: "yes" }>, reply: Reply) {
  const list = numberedPending(ctx, user);
  if (list.length === 0) return reply("Nothing is waiting on your OK right now.");

  let targets: ShareDetail[];
  if (cmd.all) targets = list;
  else if (cmd.numbers.length) {
    const bad = cmd.numbers.filter((n) => n < 1 || n > list.length);
    if (bad.length) return reply(`I don't have a #${bad[0]}. ${approvalText(list)}`);
    targets = [...new Set(cmd.numbers)].map((n) => list[n - 1]!);
  } else if (list.length === 1) targets = list;
  else return reply(`Which ones? ${approvalText(list)}`);

  const done: string[] = [];
  for (const t of targets) {
    const r = applyShareAction(ctx, t.share.id, { type: "approve", actorId: user.id, via: "reply" });
    if (r.ok) done.push(`${t.expense.description} (your share ${$(t.share.cents)})`);
  }
  await reply(`✅ Approved: ${listOf(done)}.`);

  // Tell payers when everyone has approved their expense.
  for (const t of targets) {
    const shares = sharesOf(ctx, t.expense.id);
    if (shares.every((s) => s.status === "approved")) {
      await dm(ctx, t.payer.id, `✅ Everyone approved ${t.expense.description} ${$(t.expense.totalCents)} in ${t.group.name}.`);
    }
  }
  const remaining = pendingSharesFor(ctx, user.id).length;
  if (remaining > 0) await sendApprovalRequests(ctx, user.id, "Still waiting on you:");
}

async function dispute(ctx: Ctx, user: User, cmd: Extract<Command, { type: "dispute" }>, reply: Reply) {
  const list = numberedPending(ctx, user);
  let target: ShareDetail | undefined;
  if (cmd.number !== undefined) {
    target = list[cmd.number - 1];
    if (!target) return reply(`I don't have a #${cmd.number}. ${list.length ? approvalText(list) : ""}`.trim());
  } else if (list.length === 1) target = list[0];
  else if (list.length > 1) return reply(`Which one? Reply DISPUTE <number> <reason>.\n${approvalText(list)}`);
  else {
    // Nothing pending: allow disputing the most recent share they already approved.
    const group = activeGroup(ctx, user);
    target = group
      ? userSharesInGroup(ctx, user.id, group.id).find((d) => d.share.status === "approved" && d.share.approvedVia !== "payer")
      : undefined;
  }
  if (!target) return reply("There's nothing for you to dispute right now.");
  if (!cmd.reason) return reply(`What's wrong with ${target.expense.description}? Reply DISPUTE${cmd.number ? ` ${cmd.number}` : ""} <reason>.`);
  if (!(await disputeShare(ctx, user, target, cmd.reason))) return reply("I couldn't dispute that one.");
  await reply(`Got it. I told ${nameOf(target.payer)}, and your ${$(target.share.cents)} share of ${target.expense.description} won't count until it's sorted out.`);
}

/** Disputes one specific share (owner only) and asks the payer to fix, withdraw, or add a receipt. */
export async function disputeShare(ctx: Ctx, user: User, target: ShareDetail, reason: string): Promise<boolean> {
  const r = applyShareAction(ctx, target.share.id, { type: "dispute", actorId: user.id, reason });
  if (!r.ok) return false;
  setPrompt(ctx, target.payer.id, { kind: "fix", expenseId: target.expense.id }, timings(ctx.config).promptTtlMs);
  await dm(
    ctx,
    target.payer.id,
    `${nameOf(user)} disputed ${target.expense.description} ${$(target.expense.totalCents)}: "${reason}".\nReply FIX $amount to change the total, WITHDRAW to remove it, or send a receipt photo.`,
  );
  return true;
}

async function withdraw(ctx: Ctx, user: User, expense: Expense, reply: Reply) {
  const participants = sharesOf(ctx, expense.id).filter((s) => s.userId !== user.id && s.status !== "rejected");
  withdrawExpense(ctx, expense.id, user.id);
  await reply(`Removed ${expense.description} ${$(expense.totalCents)}. Nobody owes anything for it.`);
  for (const s of participants) {
    await dm(ctx, s.userId, `${nameOf(user)} removed ${expense.description} ${$(expense.totalCents)}. You don't owe anything for it.`);
  }
}

/** Payer changes the total and/or adds a receipt; everyone else re-approves. */
async function revise(ctx: Ctx, user: User, expense: Expense, change: { totalCents?: number; receipt?: ReceiptInfo }, reply: Reply) {
  const totalCents = change.totalCents ?? expense.totalCents;
  const participantIds = sharesOf(ctx, expense.id).filter((s) => s.status !== "rejected").map((s) => s.userId);
  const receipt = change.receipt ?? (expense.receiptTotalCents || expense.receiptHash
    ? { totalCents: expense.receiptTotalCents ?? undefined, hash: expense.receiptHash ?? undefined }
    : undefined);

  const flags: ExpenseFlag[] = [];
  if (!receipt) flags.push("no_receipt");
  if (receipt?.totalCents !== undefined && Math.abs(totalCents - receipt.totalCents) > mismatchTolerance(receipt.totalCents)) flags.push("amount_mismatch");
  if (change.receipt) {
    const others = receiptHistory(ctx, expense.groupId).filter((h) => h.receiptHash !== expense.receiptHash || !h.receiptHash);
    const v = validateExpense({ reason: expense.description, totalCents, receipt: change.receipt }, others);
    if (v.ok && v.flags.includes("possible_duplicate")) flags.push("possible_duplicate");
  } else if (expense.flags.includes("possible_duplicate")) flags.push("possible_duplicate");

  const shares = reviseExpense(ctx, expense.id, user.id, { totalCents, shares: splitEqual(totalCents, participantIds, expense.payerId), flags, receipt: change.receipt });
  const others = shares.filter((s) => s.userId !== user.id).map((s) => s.userId);
  await reply(
    `Updated ${expense.description}: ${$(totalCents)} (${flagBadges(flags, receipt?.totalCents)}). I asked ${listOf(others.map((id) => nameOf(getUser(ctx, id))))} to approve again.`,
  );
  for (const id of others) await sendApprovalRequests(ctx, id, `${nameOf(user)} updated ${expense.description}.`);
}

// ------------------------------------------------------------------ expense capture

async function readImage(ctx: Ctx, group: Group, msg: InboundDM, caption: string) {
  const image = msg.images[0]!;
  const data = await image.read();
  const hash = createHash("sha256").update(data).digest("hex");
  const members = membersOf(ctx, group.id).map((m) => ({ id: m.id, name: m.displayName }));
  const extraction = await ctx.extractor.extractFromImage({ data, mimeType: image.mimeType, members, caption: caption || undefined });
  return { extraction, hash };
}

function receiptFrom(extraction: ImageExtraction, hash: string): ReceiptInfo {
  return { totalCents: extraction.totalCents, merchant: extraction.merchant, date: extraction.date, hash };
}

async function attachReceipt(ctx: Ctx, user: User, expense: Expense, msg: InboundDM, reply: Reply) {
  const group = getGroup(ctx, expense.groupId)!;
  const { extraction, hash } = await readImage(ctx, group, msg, msg.text ?? "");
  if (extraction.kind !== "receipt" || !extraction.totalCents) {
    return reply("I couldn't read a total on that. Try a clearer photo of the receipt, or reply FIX $amount.");
  }
  clearPrompt(ctx, user.id, "fix");
  return revise(ctx, user, expense, { receipt: receiptFrom(extraction, hash) }, reply);
}

async function captureExpense(ctx: Ctx, user: User, group: Group, msg: InboundDM, dmId: string, reply: Reply) {
  // A new expense means they've moved on from any unanswered "what was it for?".
  clearPrompt(ctx, user.id, "reason");
  const text = msg.text?.trim() ?? "";
  const members = membersOf(ctx, group.id).map((m) => ({ id: m.id, name: m.displayName }));
  let receipt: ReceiptInfo | undefined;
  let describedText = text;

  if (msg.images.length > 0) {
    const { extraction, hash } = await readImage(ctx, group, msg, text);
    if (extraction.kind === "receipt" && extraction.totalCents) {
      receipt = receiptFrom(extraction, hash);
    } else if (extraction.kind === "chat_screenshot" && extraction.claimedText) {
      describedText = [extraction.claimedText, text].filter(Boolean).join(". ");
    } else {
      return reply(`I couldn't read that image. Text me the amount and what it was for, like "paid $80 for gas".`);
    }
  }

  const extraction = describedText
    ? await ctx.extractor.extractFromText({ text: describedText, senderId: user.id, members, recent: recentInbound(ctx, user.id, 20).slice(0, -1) })
    : undefined;

  if (!receipt && !extraction?.isExpense) {
    return reply(`I didn't catch an expense there. Try "paid $80 for gas" or send a receipt photo. Text HELP for everything I can do.`);
  }

  return recordExpense(ctx, user, group, {
    reason: extraction?.hasReason ? extraction.reason : undefined,
    totalCents: extraction?.amountCents,
    participants: extraction?.participants ?? "all",
    receipt,
    sourceText: describedText || null,
    dmId,
    reply,
  });
}

async function recordExpense(
  ctx: Ctx,
  user: User,
  group: Group,
  input: {
    reason?: string;
    totalCents?: number;
    participants: "all" | string[];
    receipt?: ReceiptInfo;
    sourceText: string | null;
    dmId: string;
    reply: Reply;
  },
) {
  const { reply } = input;
  const result = validateExpense({ reason: input.reason, totalCents: input.totalCents, receipt: input.receipt }, receiptHistory(ctx, group.id));

  if (!result.ok && result.problem === "missing_reason") {
    if (input.totalCents) {
      setPrompt(
        ctx,
        user.id,
        { kind: "reason", groupId: group.id, amountCents: input.totalCents, participants: input.participants, sourceText: input.sourceText },
        REASON_PROMPT_TTL_MS,
      );
    }
    return reply(`What was the ${input.totalCents ? $(input.totalCents) : "money"} for? A receipt photo helps.`);
  }
  if (!result.ok) {
    return reply(`How much was ${input.reason ?? "it"}? Try "paid $X for ${input.reason ?? "it"}".`);
  }

  const memberIds = membersOf(ctx, group.id).map((m) => m.id);
  const participantIds = input.participants === "all" ? memberIds : input.participants.filter((id) => isMember(ctx, group.id, id));
  if (participantIds.length === 0 || (participantIds.length === 1 && participantIds[0] === user.id)) {
    return reply(
      memberIds.length === 1
        ? `You're the only one in ${group.name} so far. Paste the invite in your group chat first: JOIN ${group.joinCode}`
        : "That looks like it's just you, so there's nothing to split. Who was it for?",
    );
  }

  const description = capitalize(input.reason ?? input.receipt?.merchant ?? "Expense");
  const { expense, shares } = createExpense(ctx, {
    groupId: group.id,
    payerId: user.id,
    description,
    totalCents: result.totalCents,
    shares: splitEqual(result.totalCents, participantIds, user.id),
    flags: result.flags,
    receipt: input.receipt,
    sourceDmId: input.dmId,
    sourceText: input.sourceText,
  });

  const others = shares.filter((s) => s.userId !== user.id);
  await reply(
    `Logged to ${group.name}: ${expense.description} ${$(expense.totalCents)} · ${splitSummary(expense.totalCents, shares.map((s) => s.cents))} · ` +
      `${flagBadges(expense.flags, expense.receiptTotalCents)}. I've asked ${listOf(others.map((s) => nameOf(getUser(ctx, s.userId))))} to approve.`,
  );
  for (const s of others) await sendApprovalRequests(ctx, s.userId);
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
