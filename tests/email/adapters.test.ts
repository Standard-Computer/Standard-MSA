import "./setup";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { smtp2goProvider } from "../../src/lib/email/providers/smtp2go";
import { sendgridProvider } from "../../src/lib/email/providers/sendgrid";
import { OUTBOUND_ID_HEADER, type OutboundPayload, type ResolvedEmailConfig } from "../../src/lib/email/types";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch;
}

const payload: OutboundPayload = {
  to: "rcpt@example.com",
  from: "msa@example.com",
  subject: "Subject",
  text: "text",
  html: "<p>html</p>",
  headers: { [OUTBOUND_ID_HEADER]: "ob-123" },
};

function config(secrets: ResolvedEmailConfig["secrets"]): ResolvedEmailConfig {
  return {
    provider: "any",
    fromAddress: "msa@example.com",
    secrets,
    smtp: { port: 587, secure: false },
    baseUrl: "https://msa.example.com",
  };
}

const SMTP2GO_KEY = "api-TESTTESTTESTTESTTESTTEST00";
const SENDGRID_KEY = "SG.unittestunittestun.unittestunittestun";

test("smtp2go success parses email_id and sends the key as a header only", async () => {
  let sawAuth = "";
  let sawBody = "";
  mockFetch((url, init) => {
    sawAuth = (init.headers as Record<string, string>)["X-Smtp2go-Api-Key"];
    sawBody = String(init.body);
    assert.equal(url, "https://api.smtp2go.com/v3/email/send");
    return Response.json({ data: { succeeded: 1, failed: 0, email_id: "1a2b3c" } });
  });
  const result = await smtp2goProvider.send(payload, config({ smtp2goApiKey: SMTP2GO_KEY }));
  assert.deepEqual(result, { ok: true, providerMessageId: "1a2b3c" });
  assert.equal(sawAuth, SMTP2GO_KEY);
  assert.ok(!sawBody.includes(SMTP2GO_KEY), "key must not be in the request body");
  const parsed = JSON.parse(sawBody) as { custom_headers: Array<{ header: string; value: string }> };
  assert.ok(parsed.custom_headers.some((h) => h.header === OUTBOUND_ID_HEADER && h.value === "ob-123"));
});

test("smtp2go 4xx is permanent, 5xx and network errors are retryable", async () => {
  mockFetch(() => Response.json({ data: { error: "bad sender domain" } }, { status: 400 }));
  let result = await smtp2goProvider.send(payload, config({ smtp2goApiKey: SMTP2GO_KEY }));
  assert.ok(!result.ok && result.permanent);
  assert.match(!result.ok ? result.error : "", /bad sender domain/);

  mockFetch(() => Response.json({ data: {} }, { status: 500 }));
  result = await smtp2goProvider.send(payload, config({ smtp2goApiKey: SMTP2GO_KEY }));
  assert.ok(!result.ok && !result.permanent);

  globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
  result = await smtp2goProvider.send(payload, config({ smtp2goApiKey: SMTP2GO_KEY }));
  assert.ok(!result.ok && !result.permanent);
});

test("smtp2go error that echoes the key comes back redacted", async () => {
  mockFetch(() => Response.json({ data: { error: `invalid key ${SMTP2GO_KEY}` } }, { status: 401 }));
  const result = await smtp2goProvider.send(payload, config({ smtp2goApiKey: SMTP2GO_KEY }));
  assert.ok(!result.ok);
  if (!result.ok) assert.ok(!result.error.includes(SMTP2GO_KEY), "key must be redacted from the error");
});

test("missing smtp2go key fails permanently without calling the network", async () => {
  mockFetch(() => {
    throw new Error("network must not be touched");
  });
  const result = await smtp2goProvider.send(payload, config({}));
  assert.ok(!result.ok && result.permanent);
  if (!result.ok) assert.match(result.error, /SMTP2GO_API_KEY/);
});

test("sendgrid 202 succeeds with x-message-id and carries custom_args + bearer", async () => {
  let sawAuth = "";
  let sawBody = "";
  mockFetch((url, init) => {
    sawAuth = (init.headers as Record<string, string>)["Authorization"];
    sawBody = String(init.body);
    assert.equal(url, "https://api.sendgrid.com/v3/mail/send");
    return new Response(null, { status: 202, headers: { "x-message-id": "sg-msg-1" } });
  });
  const result = await sendgridProvider.send(payload, config({ sendgridApiKey: SENDGRID_KEY }));
  assert.deepEqual(result, { ok: true, providerMessageId: "sg-msg-1" });
  assert.equal(sawAuth, `Bearer ${SENDGRID_KEY}`);
  const parsed = JSON.parse(sawBody) as {
    personalizations: Array<{ custom_args?: { outbound_id?: string } }>;
  };
  assert.equal(parsed.personalizations[0].custom_args?.outbound_id, "ob-123");
});

test("sendgrid 400 is permanent and redacts an echoed key; 429 is retryable", async () => {
  mockFetch(() =>
    Response.json({ errors: [{ message: `bad key ${SENDGRID_KEY}` }] }, { status: 400 }),
  );
  let result = await sendgridProvider.send(payload, config({ sendgridApiKey: SENDGRID_KEY }));
  assert.ok(!result.ok && result.permanent);
  if (!result.ok) assert.ok(!result.error.includes(SENDGRID_KEY));

  mockFetch(() => new Response(null, { status: 429 }));
  result = await sendgridProvider.send(payload, config({ sendgridApiKey: SENDGRID_KEY }));
  assert.ok(!result.ok && !result.permanent);
});
