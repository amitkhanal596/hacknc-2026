import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ensure } from "../domain/money";
export type ChainExpected = {
  source: string;
  destination: string;
  sender: string;
  recipient: string;
  mint: string;
  units: string;
  reference: string;
  signature: string;
};
export function verifyTransaction(
  tx: ParsedTransactionWithMeta | null,
  expected: ChainExpected,
  finalized: boolean,
): boolean {
  ensure(
    finalized && tx && tx.meta && tx.meta.err === null,
    "CHAIN_UNCONFIRMED",
    "Transaction must be successful and finalized.",
  );
  ensure(
    tx.transaction.signatures[0] === expected.signature,
    "CHAIN_SIGNATURE",
    "Transaction signature mismatch.",
  );
  const keys = tx.transaction.message.accountKeys;
  ensure(
    keys.some((k) => k.pubkey.toBase58() === expected.sender && k.signer),
    "CHAIN_SIGNER",
    "Expected sender did not sign.",
  );
  const instructions = tx.transaction.message.instructions;
  const transfers = instructions.filter(
    (ix) =>
      "parsed" in ix &&
      ix.programId.equals(TOKEN_PROGRAM_ID) &&
      ix.parsed?.type === "transferChecked",
  );
  ensure(
    transfers.length === 1,
    "CHAIN_TRANSFER",
    "Expected exactly one checked token transfer.",
  );
  const transfer = transfers[0]!;
  ensure("parsed" in transfer, "CHAIN_TRANSFER", "Missing parsed transfer.");
  const info = transfer.parsed.info;
  ensure(
    info.source === expected.source &&
      info.destination === expected.destination &&
      info.authority === expected.sender &&
      info.mint === expected.mint &&
      info.tokenAmount?.amount === expected.units &&
      info.tokenAmount?.decimals === 6,
    "CHAIN_MISMATCH",
    "Token transfer does not match the authorized intent.",
  );
  ensure(
    instructions.some(
      (ix) =>
        "parsed" in ix &&
        ix.programId.toBase58() ===
          "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" &&
        ix.parsed === expected.reference,
    ),
    "CHAIN_REFERENCE",
    "Payment reference mismatch.",
  );
  const delta = (address: string, owner: string) => {
    const idx = keys.findIndex((k) => k.pubkey.toBase58() === address);
    const pre = tx.meta!.preTokenBalances?.find((b) => b.accountIndex === idx);
    const post = tx.meta!.postTokenBalances?.find(
      (b) => b.accountIndex === idx,
    );
    ensure(
      pre &&
        post &&
        pre.owner === owner &&
        post.owner === owner &&
        pre.mint === expected.mint &&
        post.mint === expected.mint &&
        pre.uiTokenAmount.decimals === 6 &&
        post.uiTokenAmount.decimals === 6,
      "CHAIN_ACCOUNT",
      "Token account owner or mint mismatch.",
    );
    return BigInt(post.uiTokenAmount.amount) - BigInt(pre.uiTokenAmount.amount);
  };
  ensure(
    delta(expected.destination, expected.recipient) ===
      BigInt(expected.units) &&
      delta(expected.source, expected.sender) === -BigInt(expected.units),
    "CHAIN_DELTA",
    "Token balance movement mismatch.",
  );
  return true;
}
