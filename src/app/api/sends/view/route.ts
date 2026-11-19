import type { NextRequest } from "next/server";
import { z } from "zod";

import { clampPingSeconds, clientIpFrom } from "@/lib/visits/visits";
import { appendSendEvent, sendByToken } from "@/lib/sends/sends";
import { isSendTokenShape } from "@/lib/sends/tokens";

// Read-timer beacon for the recipient page (SHA-2959).
//
// First-party and same-origin, like the /legal visit beacon it mirrors — and
// it reuses that lane's server-side clamps rather than inventing a second
// set, because the threat is identical: the client is untrusted and a lying
// one must not be able to claim it read an agreement for a week.
//
// The token is the authorisation; there is no recipient login. Every response
// is 204, including shape failures, so this endpoint tells a prober nothing
// about which tokens exist.
export const dynamic = "force-dynamic";

const SCHEMA = z.object({
  token: z.string(),
  seconds: z.number(),
});

function noContent(): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  let parsed;
  try {
    parsed = SCHEMA.safeParse(await req.json());
  } catch {
    return noContent();
  }
  if (!parsed.success || !isSendTokenShape(parsed.data.token)) return noContent();

  const seconds = clampPingSeconds(parsed.data.seconds);
  if (seconds <= 0) return noContent();

  try {
    const send = await sendByToken(parsed.data.token);
    if (send) {
      await appendSendEvent(send.id, {
        type: "viewed",
        ip: clientIpFrom((name) => req.headers.get(name)),
        userAgent: req.headers.get("user-agent"),
        meta: { seconds },
      });
    }
  } catch {
    // A dropped ping costs one interval of read time, which is never worth
    // an error on the page where somebody is reading a contract.
  }
  return noContent();
}
