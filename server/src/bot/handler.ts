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
import { dm, dmImage, dmLink } from "../notify";
import { notifyCreditor, paySolana, payoutsOnboardingLink, PayoutsUnavailableError, tabLinkUrl } from "../payments/service";
import { clearPrompt, getPrompt, logDM, recentInbound, setPrompt } from "../store/dms";
import {
  applyShareAction,
  createExpense,
  disputedExpensesOf,
  groupChangedSince,
  latestExpenseBy,
  pendingSharesFor,
  receiptHistory,
  reviseExpense,
  shareDetails,
  sharesOf,
  userSharesInGroup,
  withdrawExpense,
  type ShareDetail,
} from "../store/expenses";
import { activeGroup, createGroup, findUserGroup, getGroup, getGroupByCode, groupsOf, isMember, markSettleRequested, membersOf } from "../store/groups";
import { getReceiptImage, receiptFileName, saveReceiptImage } from "../store/receipts";
import { ensureWallet, getOrCreateUser, getUser, nameOf, updateUser } from "../store/users";
import { looksLikeName, parseCommand, parseFixReply, parseWhoFix, sameDescription, suggestedAmount, type Command } from "./commands";
import { explain } from "./explain";
import { buildSummary, summaryText } from "./summary";
import { announceJoin, joinGroup } from "./join";
import { runningTotal, sendExpenseNotice, settleText } from "./messages";

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
        if (namePrompt.announceGroupId) {
          const g = getGroup(ctx, namePrompt.announceGroupId);
          if (g) await announceJoin(ctx, user.id, g);
        }
        return;
      }
    }

    const group = activeGroup(ctx, user);
    if (!group) return await reply(WELCOME_NO_GROUP);

    // The payer of a disputed expense is replying: a receipt photo or a new amount applies to it.
    const disputed = openDispute(ctx, user, group);
    let preRead: Awaited<ReturnType<typeof readImage>> | undefined;
    if (disputed && msg.images.length > 0) {
      preRead = await readImage(ctx, group, msg, text);
      if (preRead.extraction.unavailable) return await reply(AI_UNAVAILABLE);
      if (isReadableReceipt(preRead.extraction)) return await attachReceipt(ctx, user, disputed, preRead, reply);
      // Not a receipt: handle it like any other photo below.
    }
    const fixCents = disputed && msg.images.length === 0 ? parseFixReply(text) : undefined;
    if (disputed && fixCents) {
      clearPrompt(ctx, user.id, "fix");
      return await revise(ctx, user, disputed, { totalCents: fixCents }, reply);
    }

    // "that was just for Ayug": the payer fixing who their last (or flagged) expense was for.
    if (msg.images.length === 0) {
      const members = membersOf(ctx, group.id).map((m) => ({ id: m.id, name: m.displayName }));
      const who = parseWhoFix(text, members, user.id);
      const target = who ? disputed ?? latestExpenseBy(ctx, user.id, group.id) : undefined;
      if (who && target) {
        const ids = who === "all" ? members.map((m) => m.id) : who;
        if (ids.length === 1 && ids[0] === user.id) return await reply("That would make it just you, so there's nothing to split. Who was it for?");
        clearPrompt(ctx, user.id, "fix");
        return await revise(ctx, user, target, { participantIds: ids }, reply);
      }
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

    return await captureExpense(ctx, user, group, msg, dmId, reply, preRead);
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
      await reply(joinInvite(g, ctx.config));
      if (!user.displayName) {
        setPrompt(ctx, user.id, { kind: "name" }, timings(ctx.config).promptTtlMs);
        await reply(ASK_NAME);
      }
      return;
    }

    case "join": {
      const g = getGroupByCode(ctx, cmd.code);
      if (!g) return reply(`I couldn't find a group with code ${cmd.code}. Double-check it with whoever invited you.`);
      await joinGroup(ctx, user, g, cmd.name);
      return;
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

    case "summary": {
      if (!group) return void (await needGroup());
      await reply(summaryText(buildSummary(ctx, user, group)));
      // Sent on its own so iMessage shows it as a rich card (Partiful-style).
      return dmLink(ctx, user.id, tabLinkUrl(ctx, user.id, group.id));
    }

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
      return approve(ctx, user, reply);

    case "dispute":
      return dispute(ctx, user, cmd, reply);

    case "fix":
    case "withdraw":
    case "accept": {
      const expense = openDispute(ctx, user, group);
      if (!expense) return reply("None of your expenses are flagged right now.");
      if (cmd.type === "withdraw") {
        clearPrompt(ctx, user.id, "fix");
        return withdraw(ctx, user, expense, reply);
      }
      const prompt = getPrompt(ctx, user.id, "fix");
      const cents = cmd.type === "fix" ? cmd.cents : prompt?.expenseId === expense.id ? prompt.suggestedCents : undefined;
      if (!cents) return reply(`What should the new total for ${expense.description} be? Reply like "make it $30", or REMOVE to delete it.`);
      clearPrompt(ctx, user.id, "fix");
      return revise(ctx, user, expense, { totalCents: cents }, reply);
    }

    case "payouts": {
      let link: string | undefined;
      try {
        link = await payoutsOnboardingLink(ctx, user.id);
      } catch (err) {
        if (!(err instanceof PayoutsUnavailableError)) throw err;
        return reply("Bank payouts aren't switched on for this Tab server yet (the organizer needs to finish Stripe setup). You can still get paid in USDC.");
      }
      if (!link) return reply("Card and Apple Pay payouts aren't set up on this server yet. You can still get paid in USDC.");
      return reply(`Set up payouts (takes ~2 minutes) so Apple Pay payments land in your bank: ${link}`);
    }
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
  const lines = [`${group.name}:`];
  if (iOwe.length) lines.push(`You owe ${listOf(iOwe)}.`);
  if (owedMe.length) lines.push(`${owedMe.join(". ")}.`);
  if (!iOwe.length && !owedMe.length) lines.push("You're all settled up.");
  const mineDisputed = userSharesInGroup(ctx, user.id, group.id).filter((d) => d.share.status === "disputed");
  for (const d of mineDisputed) lines.push(`⏸ You flagged ${d.expense.description} ${$(d.expense.totalCents)} (waiting on ${nameOf(d.payer)}).`);
  for (const e of disputedExpensesOf(ctx, user.id, group.id)) {
    lines.push(`⏸ Your ${e.description} ${$(e.totalCents)} was flagged. Reply with a new amount (like "make it $${Math.max(1, Math.round(e.totalCents / 200))}"), REMOVE, or send the receipt.`);
  }
  return lines.join("\n");
}

async function settle(ctx: Ctx, user: User, group: Group, reply: Reply) {
  const debts = groupDebts(ctx, group.id);
  if (debts.length === 0) return reply(`Everyone's settled up in ${group.name} 🎉`);
  const summary = debts.map((d) => `• ${nameOf(getUser(ctx, d.fromId))} → ${nameOf(getUser(ctx, d.toId))} ${$(d.cents)}`);
  const last = group.settleRequestedAt;
  if (last && ctx.now() - last < 10 * 60_000 && !groupChangedSince(ctx, group.id, last)) {
    const mins = Math.max(1, Math.round((ctx.now() - last) / 60_000));
    return reply(`I already sent everyone their totals ${mins} min ago:\n${summary.join("\n")}\nI'll keep reminding anyone who hasn't paid.`);
  }
  // From now on Tab nudges anyone who still owes (and not before: no nagging mid-trip).
  markSettleRequested(ctx, group.id);
  await reply(`Settling up ${group.name}. I texted everyone their total:\n${summary.join("\n")}\nI'll remind anyone who hasn't paid.`);
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

/**
 * "YES" / "OK". In the running-tab model nothing needs approving, so this is
 * either a payer taking the amount someone suggested when they flagged an
 * expense, or a leftover approval from the old flow.
 */
async function approve(ctx: Ctx, user: User, reply: Reply) {
  const group = activeGroup(ctx, user);
  const flagged = openDispute(ctx, user, group);
  const prompt = getPrompt(ctx, user.id, "fix");
  if (flagged && prompt?.expenseId === flagged.id && prompt.suggestedCents) {
    clearPrompt(ctx, user.id, "fix");
    return revise(ctx, user, flagged, { totalCents: prompt.suggestedCents }, reply);
  }
  const pending = pendingSharesFor(ctx, user.id);
  if (pending.length === 0) return reply(group ? `👍 ${group.name}: ${runningTotal(ctx, group.id, user.id)}.` : "👍");
  for (const t of pending) applyShareAction(ctx, t.share.id, { type: "approve", actorId: user.id, via: "reply" });
  return reply(`✅ Got it: ${listOf(pending.map((t) => `${t.expense.description} (your share ${$(t.share.cents)})`))}.`);
}

/**
 * "nope, I didn't eat": flag one of your shares so it stops counting until the
 * payer fixes it. Which one: an expense named in the message, else the last one
 * Tab told you about, else your most recent.
 */
async function dispute(ctx: Ctx, user: User, cmd: Extract<Command, { type: "dispute" }>, reply: Reply) {
  const group = activeGroup(ctx, user);
  if (!group) return reply("There's nothing for you to flag right now.");
  const mine = userSharesInGroup(ctx, user.id, group.id).filter((d) => d.share.approvedVia !== "payer" && d.share.status !== "rejected");
  const flaggable = mine.filter((d) => d.share.status !== "disputed");
  const named = cmd.reason ? flaggable.find((d) => sameDescription(d.expense.description, cmd.reason)) : undefined;
  const notice = getPrompt(ctx, user.id, "notice");
  const target = named ?? flaggable.find((d) => d.share.id === notice?.shareId) ?? flaggable[0];
  if (!target) return reply("There's nothing for you to flag right now.");
  if (!cmd.reason) return reply(`What's off with ${target.expense.description} ${$(target.expense.totalCents)}? Reply like "nope, I didn't eat".`);
  if (!(await disputeShare(ctx, user, target, cmd.reason))) return reply("I couldn't flag that one.");
  await reply(
    `Got it, I let ${nameOf(target.payer)} know. Your ${$(target.share.cents)} share of ${target.expense.description} is on hold until you two sort it out. Running total: ${runningTotal(ctx, group.id, user.id)}.`,
  );
}

/** Flags one specific share (owner only) and asks the payer to fix it, remove it, or add a receipt. */
export async function disputeShare(ctx: Ctx, user: User, target: ShareDetail, reason: string): Promise<boolean> {
  const r = applyShareAction(ctx, target.share.id, { type: "dispute", actorId: user.id, reason });
  if (!r.ok) return false;
  const suggested = suggestedAmount(reason);
  const suggestedCents = suggested && suggested !== target.expense.totalCents ? suggested : undefined;
  setPrompt(
    ctx,
    target.payer.id,
    { kind: "fix", expenseId: target.expense.id, suggestedCents, suggestedBy: user.id },
    timings(ctx.config).promptTtlMs,
  );
  const example = Math.max(1, Math.round((suggestedCents ?? target.expense.totalCents / 2) / 100));
  const options = suggestedCents
    ? `${nameOf(user)} suggests ${$(suggestedCents)}. Reply OK to change it to ${$(suggestedCents)}, reply with a different amount (like "make it $${example}"), REMOVE to delete it, or send the receipt.`
    : `Reply with the new total (like "make it $${example}"), REMOVE to delete it, or send the receipt.`;
  await dm(ctx, target.payer.id, `${nameOf(user)} flagged ${target.expense.description} ${$(target.expense.totalCents)}: "${reason}".\n${options}`);
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
async function revise(
  ctx: Ctx,
  user: User,
  expense: Expense,
  change: { totalCents?: number; receipt?: ReceiptInfo; participantIds?: string[] },
  reply: Reply,
) {
  const totalCents = change.totalCents ?? expense.totalCents;
  const before = sharesOf(ctx, expense.id).filter((s) => s.status !== "rejected").map((s) => s.userId);
  const participantIds = change.participantIds ?? before;
  const removed = before.filter((id) => !participantIds.includes(id) && id !== user.id);
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
  const others = shares.filter((s) => s.userId !== user.id);
  const whoNote = change.participantIds ? ` · ${splitSummary(totalCents, shares.map((s) => s.cents))}` : "";
  await reply(
    `Updated ${expense.description}: ${$(totalCents)}${whoNote} (${flagBadges(flags, receipt?.totalCents)}). I let ${listOf([...others.map((s) => s.userId), ...removed].map((id) => nameOf(getUser(ctx, id))))} know.`,
  );
  for (const id of removed) {
    await dm(ctx, id, `${nameOf(user)} updated ${expense.description}: you're not part of it anymore. Running total: ${runningTotal(ctx, expense.groupId, id)}.`);
  }
  for (const d of shareDetails(ctx, others.map((s) => s.id))) {
    if (change.receipt) await sendReceiptPhoto(ctx, d.share.userId, expense);
    const what =
      change.participantIds && !before.includes(d.share.userId)
        ? ` and added you`
        : change.totalCents !== undefined && change.totalCents !== expense.totalCents
          ? ` to ${$(totalCents)}`
          : change.participantIds
            ? ` (now split ${shares.length === 1 ? "just to you" : `${shares.length} ways`})`
            : "";
    await sendExpenseNotice(ctx, d, `${nameOf(user)} updated ${expense.description}${what}${change.receipt ? " and added the receipt above" : ""}.`);
  }
}

// ------------------------------------------------------------------ expense capture

async function readImage(ctx: Ctx, group: Group, msg: InboundDM, caption: string) {
  const image = msg.images[0]!;
  const data = await image.read();
  const hash = createHash("sha256").update(data).digest("hex");
  const members = membersOf(ctx, group.id).map((m) => ({ id: m.id, name: m.displayName }));
  const extraction = await ctx.extractor.extractFromImage({ data, mimeType: image.mimeType, members, caption: caption || undefined });
  return { extraction, hash, photo: { data, mimeType: image.mimeType } };
}

/** Below this, Gemini isn't sure it read the total right, so we ask instead of guessing. */
const MIN_RECEIPT_CONFIDENCE = 0.5;

const AI_UNAVAILABLE = `I can't read photos right now (my image reader is busy). Text me the amount instead, like "paid $80 for gas", and send the photo again later.`;

/** Sends the receipt photo for an expense, if we kept one. */
async function sendReceiptPhoto(ctx: Ctx, userId: string, expense: Expense) {
  const img = getReceiptImage(ctx, expense.id);
  if (img) await dmImage(ctx, userId, { data: img.data, mimeType: img.mimeType, name: receiptFileName(expense.description, img.mimeType) });
}

function receiptFrom(extraction: ImageExtraction, hash: string): ReceiptInfo {
  return { totalCents: extraction.totalCents, merchant: extraction.merchant, date: extraction.date, hash };
}

function isReadableReceipt(e: ImageExtraction): boolean {
  return e.kind === "receipt" && !!e.totalCents && e.confidence >= MIN_RECEIPT_CONFIDENCE;
}

/**
 * The expense this payer is currently being asked to fix: the one from their
 * open "fix" prompt if it's still disputed, else their newest disputed expense in this group.
 */
function openDispute(ctx: Ctx, user: User, group: Group | undefined): Expense | undefined {
  const prompt = getPrompt(ctx, user.id, "fix");
  const all = disputedExpensesOf(ctx, user.id);
  return all.find((e) => e.id === prompt?.expenseId) ?? all.find((e) => e.groupId === group?.id);
}

async function attachReceipt(ctx: Ctx, user: User, expense: Expense, read: Awaited<ReturnType<typeof readImage>>, reply: Reply) {
  const { extraction, hash, photo } = read;
  clearPrompt(ctx, user.id, "fix");
  saveReceiptImage(ctx, expense.id, photo.mimeType, photo.data);
  return revise(ctx, user, expense, { receipt: receiptFrom(extraction, hash) }, reply);
}

async function captureExpense(
  ctx: Ctx,
  user: User,
  group: Group,
  msg: InboundDM,
  dmId: string,
  reply: Reply,
  preRead?: Awaited<ReturnType<typeof readImage>>,
) {
  // A new expense means they've moved on from any unanswered "what was it for?".
  clearPrompt(ctx, user.id, "reason");
  const text = msg.text?.trim() ?? "";
  const members = membersOf(ctx, group.id).map((m) => ({ id: m.id, name: m.displayName }));
  let receipt: ReceiptInfo | undefined;
  let photo: { data: Buffer; mimeType: string } | undefined;
  let describedText = text;

  if (msg.images.length > 0) {
    const read = preRead ?? (await readImage(ctx, group, msg, text));
    const { extraction, hash } = read;
    if (extraction.unavailable) return reply(AI_UNAVAILABLE);
    if (isReadableReceipt(extraction)) {
      receipt = receiptFrom(extraction, hash);
      photo = read.photo;
    } else if (extraction.kind === "chat_screenshot" && extraction.claimedText) {
      describedText = [extraction.claimedText, text].filter(Boolean).join(". ");
      photo = read.photo; // forwarded as evidence, but it's not a receipt (still flagged "no receipt")
    } else if (extraction.kind === "receipt") {
      return reply(`That looks like a receipt, but I couldn't read the total clearly. Try a sharper photo, or text me the amount, like "paid $80 for gas".`);
    } else {
      return reply(`That doesn't look like a receipt, so I didn't log anything. Send a photo of the receipt, or text me the amount and what it was for, like "paid $80 for gas".`);
    }
  }

  const extraction = describedText
    ? await ctx.extractor.extractFromText({ text: describedText, senderId: user.id, members, recent: recentInbound(ctx, user.id, 20).slice(0, -1) })
    : undefined;

  // Gemini calls "pay me $20" "not an expense"; it's really one missing its reason, so ask.
  const moneyAsk = !!extraction?.amountCents && /\$|\b(pay|paid|owe|send|venmo|spent)\b/i.test(describedText);
  if (!receipt && !extraction?.isExpense && !moneyAsk) {
    return reply(`I didn't catch an expense there. Try "paid $80 for gas" or send a receipt photo. Text HELP for everything I can do.`);
  }

  return recordExpense(ctx, user, group, {
    reason: extraction?.hasReason ? extraction.reason : undefined,
    totalCents: extraction?.amountCents,
    participants: extraction?.participants ?? "all",
    receipt,
    photo,
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
    photo?: { data: Buffer; mimeType: string };
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

  // "...$40 for fortnite lessons" while "Fortnite lessons" is disputed: that's a fix, not a second expense.
  const disputedTwin = disputedExpensesOf(ctx, user.id, group.id).find((e) => sameDescription(e.description, description));
  if (disputedTwin) {
    clearPrompt(ctx, user.id, "fix");
    await reply(`That sounds like the flagged ${disputedTwin.description} (${$(disputedTwin.totalCents)}), so I updated it instead of adding a new one.`);
    if (input.photo) saveReceiptImage(ctx, disputedTwin.id, input.photo.mimeType, input.photo.data);
    return revise(ctx, user, disputedTwin, { totalCents: result.totalCents, receipt: input.receipt }, reply);
  }
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
      `${flagBadges(expense.flags, expense.receiptTotalCents)}. I let ${listOf(others.map((s) => nameOf(getUser(ctx, s.userId))))} know. Running total: ${runningTotal(ctx, group.id, user.id)}.`,
  );
  if (input.photo) saveReceiptImage(ctx, expense.id, input.photo.mimeType, input.photo.data);
  for (const d of shareDetails(ctx, others.map((s) => s.id))) {
    // The photo goes first so the heads-up right below it has the evidence attached.
    if (input.photo) await sendReceiptPhoto(ctx, d.share.userId, expense);
    await sendExpenseNotice(ctx, d);
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
