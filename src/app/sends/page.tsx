import Link from "next/link";

import {
  FUNNEL_STAGES,
  RECIPIENT_COLUMNS,
  firstEventTimes,
  funnelFor,
  readSeconds,
  type Funnel,
} from "@/lib/sends/lifecycle";
import { listNoticeCandidates } from "@/lib/sends/notices";
import { projectDeliverySignalsForSends } from "@/lib/sends/projection";
import { allSends, type SendWithTrail } from "@/lib/sends/sends";
import { requireOperator } from "@/lib/auth/page";

// Operator screen: the send funnel per document and per recipient (SHA-2959).
export const dynamic = "force-dynamic";

function FunnelRow({ funnel }: { funnel: Funnel }) {
  return (
    <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
      {FUNNEL_STAGES.map((stage) => (
        <div key={stage} className="flex gap-1">
          <dt className="text-slate-500">{stage}</dt>
          <dd className={funnel[stage] > 0 ? "font-medium text-slate-900" : "text-slate-400"}>
            {funnel[stage]}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const STATUS_CLASS: Record<string, string> = {
  accepted: "text-green-700",
  declined: "text-amber-700",
  bounced: "text-red-700",
};

/** UTC timestamp to the minute, same shape as the Created column has always used. */
function utc(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 16);
}

/**
 * Month-to-minute form for the timestamp cells. Seven of these sit side by
 * side, so the year moves onto each cell's title attribute to keep the table
 * inside a 1440px viewport without a scrollbar.
 */
function utcShort(date: Date): string {
  return utc(date).slice(5);
}

function groupByDocument(sends: SendWithTrail[]) {
  const groups = new Map<number, { title: string; slug: string; sends: SendWithTrail[] }>();
  for (const send of sends) {
    const doc = send.documentVersion.document;
    const group = groups.get(doc.id) ?? { title: doc.title, slug: doc.slug, sends: [] };
    group.sends.push(send);
    groups.set(doc.id, group);
  }
  return [...groups.values()];
}

export default async function SendsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; msg?: string }>;
}) {
  const { ok, msg } = await searchParams;
  await requireOperator("/sends");
  const [loaded, candidates] = await Promise.all([allSends(), listNoticeCandidates()]);
  // Email signals reach a send's trail only by projection, and until now the
  // per-send detail page was the only operator screen that projected. So a
  // recipient nobody had clicked into had `delivered` / `opened` / `clicked`
  // sitting in the delivery log and absent from this screen's funnel — and
  // absent from the per-recipient stage columns GH #21 adds here, which read
  // the same trail. Idempotent and serialised per send, exactly as the
  // detail page's call is.
  const projected = await projectDeliverySignalsForSends(loaded);
  const sends = projected > 0 ? await allSends() : loaded;
  const groups = groupByDocument(sends);

  return (
    // max-w-7xl, wider than the other operator screens: this table carries a
    // timestamp column per lifecycle stage (SHA-4504).
    <main className="mx-auto max-w-7xl px-6 py-16">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold">MSA sends</h1>
        <Link href="/sends/new" className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
          Send an MSA
        </Link>
      </div>
      <p className="mt-2 text-slate-600">
        {sends.length} send{sends.length === 1 ? "" : "s"} · every open, click, read and
        acceptance is logged against its own unique link. Each column shows the first time
        that stage happened, in UTC.
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

      {candidates.length > 0 ? (
        <div className="mt-6 rounded-lg border border-blue-300 bg-blue-50 p-4 text-sm">
          <p className="font-medium text-blue-900">
            {candidates.length} document{candidates.length === 1 ? " has" : "s have"} prior
            recipients on an older version.
          </p>
          <p className="mt-1 text-blue-900">
            Nothing has been sent. Notifying them is your call —{" "}
            <Link href="/sends/notices" className="font-medium underline">
              review the changes and choose an audience
            </Link>
            .
          </p>
        </div>
      ) : null}

      {sends.length === 0 ? (
        <p className="mt-8 text-sm text-slate-600">
          Nothing sent yet. <Link href="/sends/new" className="text-blue-700">Send the first MSA</Link>.
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.slug} className="mt-8 rounded-lg border border-slate-200 p-4">
            <h2 className="font-medium">
              {group.title}{" "}
              <span className="text-sm font-normal text-slate-500">
                · {group.sends.length} send{group.sends.length === 1 ? "" : "s"}
              </span>
            </h2>
            <FunnelRow funnel={funnelFor(group.sends)} />

            <div className="overflow-x-auto">
              <table className="mt-4 w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-300 text-slate-500">
                    <th className="px-1.5 py-2">Recipient</th>
                    <th className="px-1.5 py-2">Version</th>
                    <th className="px-1.5 py-2">Status</th>
                    <th className="px-1.5 py-2">Created (UTC)</th>
                    {RECIPIENT_COLUMNS.map((column) => (
                      <th key={column.event} className="px-1.5 py-2">
                        {column.label}
                      </th>
                    ))}
                    <th className="px-1.5 py-2">Outcome</th>
                    <th className="px-1.5 py-2">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {group.sends.map((send) => {
                    const first = firstEventTimes(send.events);
                    const seconds = readSeconds(send.events);
                    return (
                      <tr key={send.id} className="border-b border-slate-100">
                        <td className="px-1.5 py-2">
                          <Link href={`/sends/${send.id}`} className="text-blue-700">
                            {send.recipient.email}
                          </Link>
                          {send.recipient.fullName ? (
                            <span className="text-slate-500"> · {send.recipient.fullName}</span>
                          ) : null}
                        </td>
                        <td className="px-1.5 py-2">v{send.documentVersion.version}</td>
                        <td className={`px-1.5 py-2 font-medium ${STATUS_CLASS[send.status] ?? "text-slate-700"}`}>
                          {send.status}
                        </td>
                        <td className="px-1.5 py-2 whitespace-nowrap">
                          <span title={send.createdAt.toISOString()}>{utcShort(send.createdAt)}</span>
                        </td>
                        {RECIPIENT_COLUMNS.map((column) => {
                          const at = first[column.event];
                          return (
                            <td key={column.event} className="px-1.5 py-2 whitespace-nowrap">
                              {at ? (
                                <>
                                  <span title={at.toISOString()}>{utcShort(at)}</span>
                                  {column.event === "viewed" && seconds > 0 ? (
                                    <span className="text-slate-500"> · {seconds}s</span>
                                  ) : null}
                                </>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                          );
                        })}
                        <td className="px-1.5 py-2 whitespace-nowrap">
                          {first.declined || first.bounced ? (
                            <>
                              {first.declined ? (
                                <div className="text-amber-700" title={first.declined.toISOString()}>
                                  declined {utcShort(first.declined)}
                                </div>
                              ) : null}
                              {first.bounced ? (
                                <div className="text-red-700" title={first.bounced.toISOString()}>
                                  bounced {utcShort(first.bounced)}
                                </div>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-1.5 py-2">
                          {send.acceptance ? (
                            <Link href={`/sends/${send.id}/evidence`} className="text-blue-700">
                              download
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </main>
  );
}
