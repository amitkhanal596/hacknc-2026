import { Keypair } from "@solana/web3.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Wallets the backend makes and holds (devnet only). Secret keys are encrypted
 * at rest with AES-256-GCM. Stored format: iv.tag.ciphertext (base64).
 */
function key(hex: string): Buffer {
  const k = Buffer.from(hex, "hex");
  if (k.length !== 32) throw new Error("WALLET_ENC_KEY must be 64 hex characters (32 bytes)");
  return k;
}

export function encryptSecret(secret: Uint8Array, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(keyHex), iv);
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(stored: string, keyHex: string): Uint8Array {
  const [iv, tag, ct] = stored.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !ct) throw new Error("malformed encrypted wallet secret");
  const decipher = createDecipheriv("aes-256-gcm", key(keyHex), iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
}

export function newWallet(keyHex: string): { pubkey: string; secretEnc: string } {
  const kp = Keypair.generate();
  return { pubkey: kp.publicKey.toBase58(), secretEnc: encryptSecret(kp.secretKey, keyHex) };
}

export function loadKeypair(secretEnc: string, keyHex: string): Keypair {
  return Keypair.fromSecretKey(decryptSecret(secretEnc, keyHex));
}
