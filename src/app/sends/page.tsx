import Link from "next/link";

import { FUNNEL_STAGES, funnelFor, readSeconds, type Funnel } from "@/lib/sends/lifecycle";
import { listNoticeCandidates } from "@/lib/sends/notices";
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
  const [sends, candidates] = await Promise.all([allSends(), listNoticeCandidates()]);
  const groups = groupByDocument(sends);

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold">MSA sends</h1>
        <Link href="/sends/new" className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
          Send an MSA
        </Link>
      </div>
      <p className="mt-2 text-slate-600">
        {sends.length} send{sends.length === 1 ? "" : "s"} · every open, click, read and
        acceptance is logged against its own unique link.
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

            <table className="mt-4 w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-300 text-slate-500">
                  <th className="p-2">Recipient</th>
                  <th className="p-2">Version</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Created (UTC)</th>
                  <th className="p-2">Events</th>
                  <th className="p-2">Read</th>
                  <th className="p-2">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {group.sends.map((send) => {
                  const seconds = readSeconds(send.events);
                  return (
                    <tr key={send.id} className="border-b border-slate-100">
                      <td className="p-2">
                        <Link href={`/sends/${send.id}`} className="text-blue-700">
                          {send.recipient.email}
                        </Link>
                        {send.recipient.fullName ? (
                          <span className="text-slate-500"> · {send.recipient.fullName}</span>
                        ) : null}
                      </td>
                      <td className="p-2">v{send.documentVersion.version}</td>
                      <td className={`p-2 font-medium ${STATUS_CLASS[send.status] ?? "text-slate-700"}`}>
                        {send.status}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {send.createdAt.toISOString().replace("T", " ").slice(0, 16)}
                      </td>
                      <td className="p-2">{send.events.length}</td>
                      <td className="p-2">{seconds > 0 ? `${seconds}s` : "—"}</td>
                      <td className="p-2">
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
          </section>
        ))
      )}
    </main>
  );
}
