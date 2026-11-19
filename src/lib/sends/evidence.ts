// Acceptance, decline, and the evidence record (SHA-2959).
//
// This is the file whose output has to survive a dispute years from now, so
// the AcceptanceRecord is deliberately SELF-CONTAINED: it freezes the merged
// body the recipient actually agreed to, its hash, who they were, and the
// whole event trail up to the signature. Reconstructing any of that by
// re-rendering later would prove what the document says TODAY, which is not
// the question anyone asks.

import { prisma } from "@/lib/db";
import { parseMergeVars } from "./merge";
import { renderSendDocument } from "./render";
import { appendSendEvent, sendByToken, type SendWithTrail } from "./sends";

/** Schema tag on every evidence blob, so a later reader knows the shape. */
export const EVIDENCE_SCHEMA = "standard-msa/acceptance-evidence/1";

export type AcceptInput = {
  acceptorName: string;
  ip: string | null;
  userAgent: string | null;
};

export type AcceptOutcome =
  | { ok: true; send: SendWithTrail; alreadyAccepted: boolean }
  | { ok: false; error: string };

/**
 * Record an acceptance.
 *
 * Idempotent on purpose: a double-submitted form, or a recipient hitting
 * back and re-accepting, returns the FIRST acceptance untouched rather than
 * erroring or writing a second signature. `AcceptanceRecord.sendId` is
 * unique in the schema, so this is also enforced below the application.
 *
 * Accepting after a decline is allowed — a prospect who declines and then
 * changes their mind is a normal human sequence, and the trail keeps both
 * acts. The status column resolves it because `accepted` outranks
 * `declined` (see ./lifecycle.ts), so no special case is needed here.
 */
export async function acceptSend(token: string, input: AcceptInput): Promise<AcceptOutcome> {
  const send = await sendByToken(token);
  if (!send) return { ok: false, error: "This agreement link is not valid." };
  if (send.acceptance) {
    return { ok: true, send, alreadyAccepted: true };
  }
  const acceptorName = input.acceptorName.trim().slice(0, 200);
  if (acceptorName === "") {
    return { ok: false, error: "Type your full name to sign." };
  }

  const acceptedAt = new Date();
  // Rendered BEFORE the write so the frozen body is the one on screen when
  // they clicked — but with `acceptedAt` passed in, because on this
  // not-yet-saved row the column is still null and the date tokens would
  // fall through to the unaccepted "the date of acceptance" prose. The
  // signed copy has to NAME the day, and has to be the same document (and
  // therefore the same hash) that a later re-read of this send produces.
  const rendered = await renderSendDocument(send, { acceptedAt });

  try {
    await prisma.$transaction(async (tx) => {
      await appendSendEvent(
        send.id,
        {
          type: "accepted",
          occurredAt: acceptedAt,
          ip: input.ip,
          userAgent: input.userAgent,
          meta: { acceptorName, bodyHash: rendered.bodyHash },
        },
        tx,
      );

      // Re-read inside the transaction so the frozen trail INCLUDES the
      // acceptance event itself — evidence that stops one event short of the
      // signature is evidence of everything except the signature.
      const trail = await tx.sendEvent.findMany({
        where: { sendId: send.id },
        orderBy: { occurredAt: "asc" },
      });

      await tx.acceptanceRecord.create({
        data: {
          sendId: send.id,
          acceptedAt,
          acceptorName,
          ip: input.ip,
          userAgent: input.userAgent?.slice(0, 400) ?? null,
          signatureJson: JSON.stringify({ type: "typed", name: acceptorName, acceptedAt }),
          evidenceJson: JSON.stringify({
            schema: EVIDENCE_SCHEMA,
            capturedAt: acceptedAt,
            send: {
              id: send.id,
              token: send.token,
              createdAt: send.createdAt,
              sentAt: send.sentAt,
            },
            recipient: {
              id: send.recipient.id,
              email: send.recipient.email,
              fullName: send.recipient.fullName,
              companyName: send.recipient.companyName,
              legalName: send.recipient.legalName,
              address: send.recipient.address,
              phone: send.recipient.phone,
            },
            document: {
              documentVersionId: send.documentVersionId,
              slug: rendered.slug,
              title: rendered.title,
              version: rendered.version,
              publishedAt: send.documentVersion.publishedAt,
            },
            mergedVars: parseMergeVars(send.mergedVarsJson),
            // The agreed words themselves, not a pointer to them. A contract
            // body is a few KB; a dispute is not.
            bodyMarkdown: rendered.markdown,
            bodyHash: rendered.bodyHash,
            acceptance: { acceptedAt, acceptorName, ip: input.ip, userAgent: input.userAgent },
            trail: trail.map((e) => ({
              type: e.type,
              occurredAt: e.occurredAt,
              ip: e.ip,
              userAgent: e.userAgent,
              meta: e.metaJson,
            })),
          }),
        },
      });
    });
  } catch {
    // Lost the race against a concurrent accept: the unique sendId refused
    // the second record. The first one stands, which is the right answer.
    const existing = await sendByToken(token);
    if (existing?.acceptance) return { ok: true, send: existing, alreadyAccepted: true };
    return { ok: false, error: "Could not record the acceptance. Please try again." };
  }

  const after = await sendByToken(token);
  return { ok: true, send: after ?? send, alreadyAccepted: false };
}

export type DeclineOutcome = { ok: true } | { ok: false; error: string };

/** Record a decline. No evidence record — nothing was agreed to. */
export async function declineSend(
  token: string,
  input: { reason: string; ip: string | null; userAgent: string | null },
): Promise<DeclineOutcome> {
  const send = await sendByToken(token);
  if (!send) return { ok: false, error: "This agreement link is not valid." };
  if (send.acceptance) {
    return { ok: false, error: "This agreement has already been accepted." };
  }
  await appendSendEvent(send.id, {
    type: "declined",
    ip: input.ip,
    userAgent: input.userAgent,
    meta: { reason: input.reason.trim().slice(0, 1000) || undefined },
  });
  return { ok: true };
}

/** The stored evidence blob for a send, parsed, or null if never accepted. */
export async function evidenceFor(sendId: number): Promise<unknown | null> {
  const record = await prisma.acceptanceRecord.findUnique({ where: { sendId } });
  if (!record) return null;
  try {
    return JSON.parse(record.evidenceJson);
  } catch {
    // Unparseable blob: hand back the raw string rather than nothing. This
    // is evidence; a reader deserves whatever is actually stored.
    return record.evidenceJson;
  }
}
