import Link from "next/link";
import { notFound } from "next/navigation";

import { CopyButton } from "@/components/legal/CopyButton";
import { getEmailConfig } from "@/lib/email/config";
import { FUNNEL_STAGES, funnelFor, readSeconds } from "@/lib/sends/lifecycle";
import { outboundsForSend, projectDeliverySignals } from "@/lib/sends/projection";
import { renderSendDocument } from "@/lib/sends/render";
import { sendById } from "@/lib/sends/sends";
import { sendUrl } from "@/lib/sends/tokens";
import { requireOperator } from "@/lib/auth/page";
import { resendAction } from "../actions";

// Operator screen: one recipient's whole lifecycle (SHA-2959) — the funnel,
// the timestamped trail with IP and user agent, the delivery log behind it,
// and the acceptance evidence.
export const dynamic = "force-dynamic";

/** `viewed` pings are collapsed: a 10-minute read is 40 rows of noise, and
 *  the raw events stay in the evidence blob either way. */
const COLLAPSED = "viewed";

export default async function SendDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; msg?: string }>;
}) {
  const { id } = await params;
  const { ok, msg } = await searchParams;
  // Before the id is even parsed: this page renders the accept token, and a
  // 404-vs-200 difference on a sequential integer is itself an enumeration
  // oracle (SHA-3047).
  await requireOperator(`/sends/${id}`);
  const sendId = Number(id);
  if (!Number.isInteger(sendId) || sendId <= 0) notFound();

  const initial = await sendById(sendId);
  if (!initial) notFound();

  // Idempotent: pulls any email signals that arrived since the last load into
  // the send's own trail. Safe to run on every render by design.
  await projectDeliverySignals(initial);
  const send = (await sendById(sendId)) ?? initial;

  const [emailState, outbounds, rendered] = await Promise.all([
    getEmailConfig(),
    outboundsForSend(send),
    renderSendDocument(send),
  ]);

  const url = sendUrl(
    emailState.configured ? emailState.config.baseUrl : process.env.APP_BASE_URL || "http://localhost:3000",
    send.token,
  );
  const funnel = funnelFor([send]);
  const seconds = readSeconds(send.events);
  const viewPings = send.events.filter((e) => e.type === COLLAPSED);
  const trail = send.events.filter((e) => e.type !== COLLAPSED);

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <p className="text-sm">
        <Link href="/sends" className="text-blue-700">
          ← All sends
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold">{send.recipient.email}</h1>
      <p className="mt-1 text-slate-600">
        {rendered.title} v{rendered.version} · status{" "}
        <strong className="text-slate-900">{send.status}</strong>
      </p>

      {msg ? (
        <div
          className={`mt-4 rounded-lg border p-3 text-sm ${
            ok === "1" ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"
          }`}
        >
          {msg}
        </div>
      ) : null}

      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium">Unique link</h2>
        <p className="mt-1 text-sm text-slate-600">
          Unguessable and specific to this recipient — anyone holding it can accept this
          agreement, so treat it like a password.
        </p>
        <div className="mt-2 flex items-center gap-3">
          <code className="flex-1 truncate rounded bg-slate-100 p-2 text-xs">{url}</code>
          <CopyButton text={url} label="Copy link" />
        </div>
        <form action={resendAction} className="mt-3">
          <input type="hidden" name="sendId" value={send.id} />
          <button type="submit" className="rounded border border-slate-300 px-3 py-1.5 text-sm">
            Re-send this link
          </button>
        </form>
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium">Funnel</h2>
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {FUNNEL_STAGES.map((stage) => (
            <div key={stage} className="flex gap-1.5">
              <dt className="text-slate-500">{stage}</dt>
              <dd className={funnel[stage] > 0 ? "font-medium text-green-700" : "text-slate-400"}>
                {funnel[stage] > 0 ? "yes" : "no"}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-sm text-slate-600">
          Read time {seconds}s across {viewPings.length} ping
          {viewPings.length === 1 ? "" : "s"}.
        </p>
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium">Captured details</h2>
        <dl className="mt-2 grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">Full name</dt>
          <dd>{send.recipient.fullName ?? "—"}</dd>
          <dt className="text-slate-500">Company</dt>
          <dd>{send.recipient.companyName ?? "—"}</dd>
          <dt className="text-slate-500">Legal entity</dt>
          <dd>{send.recipient.legalName ?? "—"}</dd>
          <dt className="text-slate-500">Address</dt>
          <dd>{send.recipient.address ?? "—"}</dd>
          <dt className="text-slate-500">Phone</dt>
          <dd>{send.recipient.phone ?? "—"}</dd>
        </dl>
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium">Lifecycle log</h2>
        <p className="mt-1 text-sm text-slate-600">
          Append-only. Kept as acceptance evidence, so nothing here is ever edited.
        </p>
        <table className="mt-3 w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-300 text-slate-500">
              <th className="p-2">When (UTC)</th>
              <th className="p-2">Event</th>
              <th className="p-2">IP</th>
              <th className="p-2">User agent</th>
              <th className="p-2">Detail</th>
            </tr>
          </thead>
          <tbody>
            {trail.map((event) => (
              <tr key={event.id} className="border-b border-slate-100 align-top">
                <td className="p-2 whitespace-nowrap">
                  {event.occurredAt.toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td className="p-2 font-medium">{event.type}</td>
                <td className="p-2">{event.ip ?? "—"}</td>
                <td className="p-2 max-w-48 truncate">{event.userAgent ?? "—"}</td>
                <td className="p-2 max-w-64 truncate text-slate-600">
                  {event.metaJson === "{}" ? "—" : event.metaJson}
                </td>
              </tr>
            ))}
            {viewPings.length > 0 ? (
              <tr className="border-b border-slate-100 align-top">
                <td className="p-2 whitespace-nowrap">
                  {viewPings[viewPings.length - 1].occurredAt.toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td className="p-2 font-medium">viewed</td>
                <td className="p-2">{viewPings[viewPings.length - 1].ip ?? "—"}</td>
                <td className="p-2 max-w-48 truncate">
                  {viewPings[viewPings.length - 1].userAgent ?? "—"}
                </td>
                <td className="p-2 text-slate-600">
                  {viewPings.length} read ping{viewPings.length === 1 ? "" : "s"}, {seconds}s total
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium">Email delivery</h2>
        {outbounds.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">Nothing has been mailed for this send yet.</p>
        ) : (
          <table className="mt-2 w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-300 text-slate-500">
                <th className="p-2">Queued (UTC)</th>
                <th className="p-2">Status</th>
                <th className="p-2">Attempts</th>
                <th className="p-2">Last error</th>
              </tr>
            </thead>
            <tbody>
              {outbounds.map((row) => (
                <tr key={row.id} className="border-b border-slate-100 align-top">
                  <td className="p-2 whitespace-nowrap">
                    {row.createdAt.toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="p-2">{row.status}</td>
                  <td className="p-2">{row.attempts}</td>
                  <td className="p-2 text-slate-600">{row.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Channel-level outcomes (queued, failed, complained) live here rather than in the
          lifecycle log above — they describe the email, not the agreement.
        </p>
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium">Acceptance evidence</h2>
        {send.acceptance ? (
          <>
            <dl className="mt-2 grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-500">Accepted</dt>
              <dd>{send.acceptance.acceptedAt.toISOString().replace("T", " ").slice(0, 19)} UTC</dd>
              <dt className="text-slate-500">Signed by</dt>
              <dd>{send.acceptance.acceptorName ?? "—"}</dd>
              <dt className="text-slate-500">IP</dt>
              <dd>{send.acceptance.ip ?? "—"}</dd>
              <dt className="text-slate-500">User agent</dt>
              <dd className="truncate">{send.acceptance.userAgent ?? "—"}</dd>
            </dl>
            <p className="mt-3 text-sm">
              <Link href={`/sends/${send.id}/evidence`} className="text-blue-700">
                Download the evidence record (JSON)
              </Link>
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Self-contained: the merged body as accepted, its SHA-256, the recipient, and the
              full event trail frozen at signature.
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-slate-600">Not accepted yet.</p>
        )}
      </section>
    </main>
  );
}
