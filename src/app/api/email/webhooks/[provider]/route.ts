// Provider webhook endpoint (SHA-2958): POST /api/email/webhooks/<provider>
// Authenticity gate lives in isWebhookAuthorized(); unverifiable requests
// are rejected loudly, never silently ingested.

import { getEmailConfig } from "@/lib/email/config";
import { ingestWebhook, isWebhookAuthorized } from "@/lib/email/webhooks";

export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  const state = await getEmailConfig();
  if (!state.configured) {
    return Response.json({ error: "Email delivery is not configured." }, { status: 503 });
  }
  const suppliedKey = new URL(req.url).searchParams.get("key");
  if (!isWebhookAuthorized(provider, suppliedKey, state.config)) {
    return Response.json(
      {
        error:
          "Webhook rejected: set EMAIL_WEBHOOK_SECRET and include it as ?key=… in the " +
          "webhook URL, or configure provider signature verification.",
      },
      { status: 403 },
    );
  }
  const body = await req.text();
  const headers: Record<string, string> = {};
  req.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  const result = await ingestWebhook(provider, body, headers, state.config);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  return Response.json({ ingested: result.ingested });
}
