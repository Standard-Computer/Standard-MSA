// /api/v1/contacts (SHA-2960): list and create-or-enrich.

import { apiHandler } from "@/lib/api/handler";
import { pageFrom } from "@/lib/api/params";
import { ContactCreateSchema } from "@/lib/api/schemas";
import { serializeContact } from "@/lib/api/serializers";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/email/address";
import { upsertRecipient } from "@/lib/sends/sends";

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  { scope: "contacts:read", endpoint: "GET /contacts" },
  async ({ req }) => {
    const url = new URL(req.url);
    const page = pageFrom(url.searchParams);
    const email = url.searchParams.get("email");
    const rows = await prisma.recipient.findMany({
      where: email ? { email: normalizeEmail(email) } : undefined,
      orderBy: { id: "desc" },
      ...page,
    });
    return { status: 200, body: { contacts: rows.map(serializeContact) } };
  },
);

export const POST = apiHandler(
  { scope: "contacts:write", endpoint: "POST /contacts", idempotent: true },
  async ({ json }) => {
    const body = ContactCreateSchema.parse(json ?? {});
    const contact = await upsertRecipient({
      email: normalizeEmail(body.email),
      fullName: body.name ?? "",
      companyName: body.company ?? "",
      legalName: body.legalName ?? "",
      address: body.address ?? "",
      phone: body.phone ?? "",
    });
    return { status: 201, body: serializeContact(contact) };
  },
);
