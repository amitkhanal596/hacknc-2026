import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import type { Config } from "../config";
export function encrypt(secret: Uint8Array, keyHex: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    "base64",
  );
}
export function decrypt(encrypted: string, keyHex: string) {
  const bytes = Buffer.from(encrypted, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return new Uint8Array(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]),
  );
}
export function treasury(config: Config) {
  return Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        config.TREASURY_SECRET_KEY ||
          readFileSync(config.TREASURY_KEY_PATH, "utf8"),
      ) as number[],
    ),
  );
}
