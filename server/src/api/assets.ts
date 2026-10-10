import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import * as s from "../db/schema";
import { Ledger, uid } from "../domain/ledger";
import { ensure } from "../domain/money";
import type { Extractor } from "../ai/extractor";
export function sniff(bytes: Uint8Array) {
  ensure(
    bytes.length > 0 && bytes.length <= 4 * 1024 * 1024,
    "FILE_SIZE",
    "Images must be smaller than 4 MB.",
  );
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  ensure(false, "FILE_TYPE", "Upload a PNG, JPEG or WebP image.");
}
export class Assets {
  constructor(
    public ledger: Ledger,
    public extractor: Extractor,
  ) {}
  async upload(
    actor: string,
    groupId: string,
    bytes: Uint8Array,
    purpose: "expense" | "evidence",
    participants: string[],
  ) {
    this.ledger.member(groupId, actor);
    const mime = sniff(bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    let asset = this.ledger.db
      .select()
      .from(s.assets)
      .where(and(eq(s.assets.groupId, groupId), eq(s.assets.digest, digest)))
      .get();
    if (asset?.parserStatus === "done" || (purpose === "evidence" && asset))
      return {
        id: asset.id,
        expenseId: asset.expenseId,
        duplicate: true,
        extraction:
          asset.extracted &&
          (asset.purpose !== "evidence" || asset.uploader === actor)
            ? (JSON.parse(asset.extracted) as unknown)
            : null,
      };
    if (!asset) {
      const id = uid();
      this.ledger.db
        .insert(s.assets)
        .values({
          id,
          groupId,
          digest,
          mime,
          uploader: actor,
          purpose,
          data: Buffer.from(bytes).toString("base64"),
          parserStatus: purpose === "evidence" ? "evidence_only" : "pending",
        })
        .onConflictDoNothing()
        .run();
      asset = this.ledger.db
        .select()
        .from(s.assets)
        .where(and(eq(s.assets.groupId, groupId), eq(s.assets.digest, digest)))
        .get()!;
    }
    if (purpose === "evidence") {
      // OCR can suggest a link, but this code never calls any payment mutation.
      if (this.extractor.mode === "gemini") {
        try {
          const extracted = await this.extractor.parse({
            text: "Classify this voluntarily uploaded payment evidence. Extract displayed fields into paymentRecord; displayed completion is never verification.",
            actorId: actor,
            members: this.ledger.groupMembers(groupId),
            image: { mime, base64: asset.data! },
          });
          const suggestedIntentIds =
            extracted.kind === "payment_screenshot"
              ? this.ledger
                  .pending(groupId)
                  .filter(
                    (i) =>
                      (i.fromId === actor || i.toId === actor) &&
                      i.amountCents === extracted.paymentRecord?.amountCents,
                  )
                  .map((i) => i.id)
              : [];
          const result = {
            ...extracted,
            suggestedIntentIds,
            verification: "unverified_evidence",
          };
          this.ledger.db
            .update(s.assets)
            .set({ parserStatus: "done", extracted: JSON.stringify(result) })
            .where(eq(s.assets.id, asset.id))
            .run();
          return {
            id: asset.id,
            expenseId: null,
            duplicate: false,
            extraction: result,
          };
        } catch {
          this.ledger.db
            .update(s.assets)
            .set({ parserStatus: "evidence_only" })
            .where(eq(s.assets.id, asset.id))
            .run();
        }
      }
      return {
        id: asset.id,
        expenseId: null,
        duplicate: false,
        extraction: null,
      };
    }
    try {
      const extracted = await this.extractor.parse({
        text: "@tab split this. Participants explicitly selected in the private form.",
        actorId: actor,
        members: this.ledger.groupMembers(groupId),
        image: { mime, base64: asset.data! },
      });
      let expenseId: string | null = null;
      if (
        ["expense_receipt", "invoice_or_bill"].includes(extracted.kind) &&
        extracted.totalCents
      ) {
        const selected = participants.length
          ? participants
          : extracted.participantIds;
        ensure(
          selected.length,
          "PARTICIPANTS_REQUIRED",
          "Who should split this receipt? Select participants.",
        );
        const proposal = this.ledger.propose(actor, {
          groupId,
          payerId: extracted.payerId,
          description: extracted.description,
          totalCents: extracted.totalCents,
          currency: extracted.currency,
          participants: selected,
          sourceId: `image:${digest}`,
        });
        expenseId = proposal.id;
      }
      this.ledger.db
        .update(s.assets)
        .set({
          expenseId,
          extracted: JSON.stringify(extracted),
          parserStatus: "done",
        })
        .where(eq(s.assets.id, asset.id))
        .run();
      return {
        id: asset.id,
        expenseId,
        duplicate: false,
        extraction: extracted,
      };
    } catch (error) {
      this.ledger.db
        .update(s.assets)
        .set({ parserStatus: "needs_review" })
        .where(eq(s.assets.id, asset.id))
        .run();
      throw error;
    }
  }
  cleanup() {
    this.ledger.db
      .update(s.assets)
      .set({ data: null })
      .where(lt(s.assets.createdAt, Date.now() - 7 * 86_400_000))
      .run();
  }
}
