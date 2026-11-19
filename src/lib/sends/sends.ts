import { Prisma } from "@prisma/client";
import { enqueueSendEventWebhooks } from "@/lib/api/webhooks";
import { prisma } from "@/lib/db";
import { normalizeRecipientInput, type RecipientInput, type RecipientInputLike } from "./fields";
import { advanceStatus, type SendEventType } from "./lifecycle";
import { recipientMergeVars } from "./merge";
import { newSendToken } from "./tokens";

// Send persistence (SHA-2959). The ONLY writer of Send, SendEvent and
// Recipient — every lifecycle fact in the app arrives through
// `appendSendEvent` below, so there is one place where "what does this event
// do to the send?" is answered.
//
// No `server-only` marker, matching the email lane's DB modules (queue.ts,
// webhooks.ts, send.ts): this code is acceptance evidence and has to be
// reachable from the DB-backed tests, which run under plain node where
// `server-only` throws on import. The client-bundle boundary is held where
// it actually is — the progressive send form imports only the PURE modules
// in this directory (fields, merge, lifecycle, audience), never this one.

/** Accepts either the client or a transaction client, so acceptance can write
 *  its event and its evidence record in ONE transaction. */
type Db = Prisma.TransactionClient;

const SEND_INCLUDE = {
  recipient: true,
  acceptance: true,
  events: { orderBy: { occurredAt: "asc" } },
  documentVersion: { include: { document: true } },
} satisfies Prisma.SendInclude;

export type SendWithTrail = Prisma.SendGetPayload<{ include: typeof SEND_INCLUDE }>;

export type AppendEventInput = {
  type: SendEventType;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>;
  /** Provider-supplied time for projected events; defaults to now. */
  occurredAt?: Date;
};

/**
 * Append one lifecycle event and roll the send's derived status forward.
 *
 * SendEvent is append-only (it is evidence), so this never edits or removes
 * an event, and `advanceStatus` guarantees the status column only ever moves
 * forward — a late bounce webhook cannot un-accept a signed agreement.
 *
 * A missing send is a no-op rather than a throw: the callers are a public
 * beacon and a webhook projection, and neither should 500 because a row was
 * removed between read and write.
 */
export async function appendSendEvent(
  sendId: number,
  input: AppendEventInput,
  db: Db = prisma,
): Promise<void> {
  const send = await db.send.findUnique({
    where: { id: sendId },
    select: { status: true, sentAt: true, acceptedAt: true },
  });
  if (!send) return;

  const occurredAt = input.occurredAt ?? new Date();
  await db.sendEvent.create({
    data: {
      sendId,
      type: input.type,
      occurredAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 400) ?? null,
      metaJson: JSON.stringify(input.meta ?? {}),
    },
  });

  const data: Prisma.SendUpdateInput = {};
  const nextStatus = advanceStatus(send.status, input.type);
  if (nextStatus !== send.status) data.status = nextStatus;
  // First occurrence wins for both stamps: a re-send or a replayed signal
  // must not rewrite when this agreement went out or when it was accepted.
  if (input.type === "sent" && !send.sentAt) data.sentAt = occurredAt;
  if (input.type === "accepted" && !send.acceptedAt) data.acceptedAt = occurredAt;
  if (Object.keys(data).length > 0) {
    await db.send.update({ where: { id: sendId }, data });
  }

  // Row writes only (SHA-2960): queue `send.<type>` for any webhook
  // subscriptions; the network happens later in the delivery sweep.
  await enqueueSendEventWebhooks(sendId, input.type, db);
}

/** RecipientInput -> column values ("" becomes NULL, which is what empty means). */
function toRecipientRow(input: RecipientInput) {
  return {
    email: input.email,
    fullName: input.fullName || null,
    companyName: input.companyName || null,
    legalName: input.legalName || null,
    address: input.address || null,
    phone: input.phone || null,
  };
}

/**
 * Non-destructive merge of a new submission over what we already hold. A
 * second send that captured more details enriches the recipient; one that
 * captured fewer does NOT blank what the first one learned, because an
 * operator who leaves a field empty is declining to retype it, not asserting
 * that we should forget it.
 */
function mergeRecipient(
  input: RecipientInput,
  existing: { fullName: string | null; companyName: string | null; legalName: string | null; address: string | null; phone: string | null } | null,
): RecipientInput {
  return {
    email: input.email,
    fullName: input.fullName || existing?.fullName || "",
    companyName: input.companyName || existing?.companyName || "",
    legalName: input.legalName || existing?.legalName || "",
    address: input.address || existing?.address || "",
    phone: input.phone || existing?.phone || "",
  };
}

/**
 * Reuse-or-create the recipient for `input.email` with the non-destructive
 * merge above. The one write path for Recipient — the send flow and the
 * API's POST /contacts (SHA-2960) both come through here, so they cannot
 * disagree about what a repeat email does.
 */
export async function upsertRecipient(input: RecipientInput, db: Db = prisma) {
  const existing = await db.recipient.findFirst({
    where: { email: input.email },
    orderBy: { id: "asc" },
  });
  const merged = mergeRecipient(input, existing);
  return existing
    ? db.recipient.update({ where: { id: existing.id }, data: toRecipientRow(merged) })
    : db.recipient.create({ data: toRecipientRow(merged) });
}

export type CreatedSend = {
  send: SendWithTrail;
  /** The recipient values as merged into this send. */
  merged: RecipientInput;
};

/**
 * Create one unique send: reuse-or-create the recipient, mint an unguessable
 * token, FREEZE the merge variables onto the row, and log `created`.
 *
 * Freezing matters for evidence. The recipient row can be enriched by a
 * later send, but what this agreement says must be what was rendered when it
 * was sent — so the document merges `mergedVarsJson`, never a live re-read
 * of the recipient.
 */
export async function createSend(
  documentVersionId: number,
  raw: RecipientInputLike,
): Promise<CreatedSend> {
  const input = normalizeRecipientInput(raw);
  const sendId = await prisma.$transaction(async (tx) => {
    const recipient = await upsertRecipient(input, tx);
    const merged = normalizeRecipientInput(recipient);

    const send = await tx.send.create({
      data: {
        token: newSendToken(),
        documentVersionId,
        recipientId: recipient.id,
        mergedVarsJson: JSON.stringify(recipientMergeVars(merged)),
      },
    });
    await appendSendEvent(send.id, { type: "created" }, tx);
    return send.id;
  });

  const send = await sendById(sendId);
  if (!send) {
    // The transaction above committed this row; an absence here means the
    // database went away mid-request, which is not something to paper over.
    throw new Error(`Send ${sendId} vanished immediately after creation.`);
  }
  return { send, merged: normalizeRecipientInput(send.recipient) };
}

export async function sendById(id: number): Promise<SendWithTrail | null> {
  return prisma.send.findUnique({ where: { id }, include: SEND_INCLUDE });
}

export async function sendByToken(token: string): Promise<SendWithTrail | null> {
  return prisma.send.findUnique({ where: { token }, include: SEND_INCLUDE });
}

/** Every send, newest first — the operator list and the funnels. */
export async function allSends(): Promise<SendWithTrail[]> {
  return prisma.send.findMany({ include: SEND_INCLUDE, orderBy: { createdAt: "desc" } });
}

/** Sends of any version of one document — the update-notice audience pool. */
export async function sendsForDocument(documentId: number): Promise<SendWithTrail[]> {
  return prisma.send.findMany({
    where: { documentVersion: { documentId } },
    include: SEND_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
}
