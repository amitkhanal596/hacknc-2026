import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomString(length: number, alphabet = ALPHABET): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

/** Prefixed random id, e.g. `exp_k3j9x0a1b2c3`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomString(12)}`;
}

/** Join codes like TAHOE42: up to 5 letters from the group name + 2 digits. */
export function newJoinCode(groupName: string): string {
  const letters = groupName.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5) || "TAB";
  return letters + randomString(2, "0123456789");
}

export function sixDigitCode(): string {
  return randomString(6, "0123456789");
}
