// Evidence record download (SHA-2959).
//
// The acceptance criterion is that an acceptance produces a RETRIEVABLE
// evidence record, so it is served as a file an operator can hand to a
// lawyer or an auditor — the stored blob verbatim, not a re-rendering of it.

import { guardOperatorRequest } from "@/lib/auth/guard";
import { evidenceFor } from "@/lib/sends/evidence";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Operator-only, and refused BEFORE the id is read: the blob carries the
  // recipient's email, address, phone, IP, user agent and the send token
  // itself, off a sequential integer (SHA-3047).
  const refusal = await guardOperatorRequest(req);
  if (refusal) return refusal;

  const { id } = await ctx.params;
  const sendId = Number(id);
  if (!Number.isInteger(sendId) || sendId <= 0) {
    return new Response("Not found", { status: 404 });
  }
  const evidence = await evidenceFor(sendId);
  if (evidence === null) {
    return new Response("No acceptance evidence for this send.", { status: 404 });
  }
  return new Response(JSON.stringify(evidence, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="standard-msa-acceptance-${sendId}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
