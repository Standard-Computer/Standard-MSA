// /api/v1/sends (SHA-2960): list, and THE core call — create an MSA send.
//
// The tolerant-payload bar: `{"email": "x@y.com"}` alone must succeed. The
// document defaults to the instance's obvious choice (the "msa" slug, or
// the only published document), and a mail-delivery failure is reported in
// the response, never thrown — the unique URL already exists and works.

import { ApiError } from "@/lib/api/errors";
import { apiHandler } from "@/lib/api/handler";
import { pageFrom } from "@/lib/api/params";
import { SendCreateSchema } from "@/lib/api/schemas";
import { apiBaseUrl, serializeSend } from "@/lib/api/serializers";
import { prisma } from "@/lib/db";
import { publishedDocument, publishedDocuments } from "@/lib/legal/documents";
import { validateRecipientInput } from "@/lib/sends/fields";
import { dispatchSend } from "@/lib/sends/msaEmail";
import { createSend } from "@/lib/sends/sends";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ scope: "sends:read", endpoint: "GET /sends" }, async ({ req }) => {
  const url = new URL(req.url);
  const page = pageFrom(url.searchParams);
  const status = url.searchParams.get("status");
  const contactId = Number(url.searchParams.get("contactId") ?? "");
  const documentSlug = url.searchParams.get("documentSlug");

  const rows = await prisma.send.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(Number.isInteger(contactId) && contactId > 0 ? { recipientId: contactId } : {}),
      ...(documentSlug ? { documentVersion: { document: { slug: documentSlug } } } : {}),
    },
    include: {
      recipient: true,
      acceptance: true,
      documentVersion: { include: { document: true } },
    },
    orderBy: { id: "desc" },
    ...page,
  });
  const base = apiBaseUrl(req);
  return { status: 200, body: { sends: rows.map((s) => serializeSend(s, base)) } };
});

/** The published version to send when the caller names no slug: the "msa"
 *  document if one is published, else the instance's only published one. */
async function defaultDocumentVersionId(): Promise<number> {
  const published = await publishedDocuments();
  const msa = published.find((p) => p.doc.slug === "msa");
  if (msa) return msa.current.id;
  if (published.length === 1) return published[0].current.id;
  throw new ApiError(
    "validation_failed",
    published.length === 0
      ? "No document has a published version yet; publish one before creating sends."
      : "Several documents are published; specify which with documentSlug.",
    { details: [{ path: "documentSlug", message: "Required on this instance." }] },
  );
}

export const POST = apiHandler(
  { scope: "sends:write", endpoint: "POST /sends", idempotent: true },
  async ({ req, json }) => {
    const body = SendCreateSchema.parse(json ?? {});

    // Who to: an existing contact, inline details, or both (inline enriches).
    let email = body.email ?? "";
    if (body.contactId !== undefined) {
      const contact = await prisma.recipient.findUnique({ where: { id: body.contactId } });
      if (!contact) throw new ApiError("not_found", "No such contact.");
      email = email || contact.email;
    }
    const validation = validateRecipientInput({
      email,
      fullName: body.name,
      companyName: body.company,
      legalName: body.legalName,
      address: body.address,
      phone: body.phone,
    });
    if (!validation.ok) {
      throw new ApiError("validation_failed", validation.error, {
        details: [{ path: validation.field, message: validation.error }],
      });
    }

    // Which document: named slug (its current published version) or default.
    let documentVersionId: number;
    if (body.documentSlug !== undefined) {
      const doc = await publishedDocument(body.documentSlug);
      if (!doc) throw new ApiError("not_found", "No published document has that slug.");
      documentVersionId = doc.current.id;
    } else {
      documentVersionId = await defaultDocumentVersionId();
    }

    const { send } = await createSend(documentVersionId, validation.input);

    // Delivery is best-effort DATA in the response. deliver:false callers
    // (a PSA that mails through its own templates) skip it entirely.
    let delivery: { attempted: boolean; ok: boolean; error: string | null };
    if (body.deliver === false) {
      delivery = { attempted: false, ok: false, error: null };
    } else {
      const identity = await prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } });
      const dispatched = await dispatchSend(send, identity?.name ?? null);
      delivery = dispatched.ok
        ? { attempted: true, ok: true, error: null }
        : { attempted: true, ok: false, error: dispatched.error };
    }

    const fresh = await prisma.send.findUniqueOrThrow({
      where: { id: send.id },
      include: {
        recipient: true,
        acceptance: true,
        documentVersion: { include: { document: true } },
      },
    });
    return { status: 201, body: { ...serializeSend(fresh, apiBaseUrl(req)), delivery } };
  },
);
