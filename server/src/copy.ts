import type { ExpenseFlag, Group, Payment } from "./db/schema";
import { formatCents as $ } from "./ledger/money";

/** Every user-facing bot message lives here so wording stays consistent. */

export const HELP = `Here's what I can do:
• Text me an expense: "paid $80 for gas" or send a receipt photo
• NEW <trip name>: start a group
• JOIN <code>: join a group
• BALANCE: what you owe and are owed
• YES / DISPUTE <reason>: approve or dispute your share
• WHY: the breakdown behind what you owe
• SETTLE: send everyone their totals
• PAY: pay what you owe in USDC
• USE <group>: switch groups · GROUPS: list them
• NAME <your name>: change what I call you`;

export const WELCOME_NO_GROUP = `Hi! I'm Tab. I keep track of shared costs for trips, roommates, and dinners.
• Start a group: text NEW followed by a name, like "NEW Asheville"
• Or join one: text JOIN and the code your friend sent you`;

export const ASK_NAME = "What should I call you? (Just reply with your first name.)";

export function flagBadges(flags: ExpenseFlag[], receiptTotalCents?: number | null): string {
  const parts: string[] = [];
  if (flags.includes("no_receipt")) parts.push("⚠️ no receipt");
  else if (flags.includes("amount_mismatch")) parts.push(`⚠️ receipt says ${receiptTotalCents ? $(receiptTotalCents) : "a different amount"}`);
  else parts.push("🧾 receipt matched");
  if (flags.includes("possible_duplicate")) parts.push("⚠️ looks like a duplicate");
  return parts.join(" · ");
}

export function splitSummary(totalCents: number, shareCents: number[]): string {
  const n = shareCents.length;
  // Even split if everyone pays the same, allowing the payer to absorb leftover cents.
  const base = Math.floor(totalCents / n);
  const even = shareCents.filter((c) => c !== base).length <= 1 && shareCents.every((c) => c >= base && c < base + n);
  return even ? `split ${n} ways (${$(base)} each)` : `split between ${n} people`;
}

/**
 * The invite the organizer pastes into the real group chat. With Photon's shared
 * line, each person texts a different number, so the invite is a web page that
 * registers them and has the bot text them first.
 */
export function joinInvite(group: Group, config: { publicBaseUrl: string }): string {
  return `Join our ${group.name} tab 👉 ${config.publicBaseUrl}/j/${group.joinCode}\n(Already texting Tab? Just send: JOIN ${group.joinCode})`;
}

export function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function railLabel(p: Pick<Payment, "rail" | "simulated">): string {
  if (p.rail === "apple_pay") return "Apple Pay";
  return p.simulated ? "USDC, simulated" : "USDC";
}

export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
