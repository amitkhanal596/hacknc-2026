import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Small signed tokens (payload.signature, both base64url). Used for pay links
 * (`/p/:token`) and extension API bearer tokens. Not JWT, but the same idea.
 */
export type TokenPayload =
  | { t: "pay"; groupId: string; fromId: string; toId: string; exp: number }
  | { t: "api"; userId: string; exp: number }
  /** Read-only link to someone's tab (summary page + preview card). */
  | { t: "tab"; userId: string; groupId: string; exp: number };

const b64 = (buf: Buffer) => buf.toString("base64url");

export function signToken(payload: TokenPayload, secret: string): string {
  const body = b64(Buffer.from(JSON.stringify(payload)));
  const sig = b64(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken<T extends TokenPayload["t"]>(
  token: string,
  secret: string,
  type: T,
  now = Date.now(),
): Extract<TokenPayload, { t: T }> | undefined {
  const [body, sig] = token.split(".");
  if (!body || !sig) return undefined;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (payload.t !== type || payload.exp < now) return undefined;
    return payload as Extract<TokenPayload, { t: T }>;
  } catch {
    return undefined;
  }
}
