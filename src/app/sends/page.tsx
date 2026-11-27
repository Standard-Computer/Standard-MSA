import Link from "next/link";

import {
  FUNNEL_STAGES,
  funnelFor,
  readSeconds,
  recipientStages,
  visibleStages,
  type Funnel,
} from "@/lib/sends/lifecycle";
import { listNoticeCandidates } from "@/lib/sends/notices";
import { projectDeliverySignalsForSends } from "@/lib/sends/projection";
import { allSends, type SendWithTrail } from "@/lib/sends/sends";
import { requireOperator } from "@/lib/auth/page";

// Operator screen: the send funnel per document, and per recipient what
// happened and when (SHA-2959, per-recipient stages SHA-4500).
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

/** How a reached stage reads. Signed is the one an operator scans for. */
const STAGE_CLASS: Record<string, string> = {
  accepted: "font-medium text-green-700",
  declined: "text-amber-700",
  bounced: "text-red-700",
};

/**
 * `2026-11-27T14:32:08.000Z` -> `11-27 14:32`.
 *
 * Short because there are up to eight of these on a row, and the row has to
 * stay scannable — the full instant is on the cell's `title`, and the header
 * says UTC once for all of them rather than eight times.
 */
function stageStamp(at: Date): string {
  return at.toISOString().slice(5, 16).replace("T", " ");
}

/**
 * One stage cell: when it first happened, or an em dash.
 *
 * A timestamp rather than a tick wherever we have one — "opened" is a
 * different fact from "opened four minutes after it was sent", and the
 * second is the one that tells an operator whether to chase it.
 */
function StageCell({ type, at }: { type: string; at: Date | null }) {
  if (!at) {
    return (
      <td className="p-2 text-slate-300" aria-label="not yet">
        —
      </td>
    );
  }
  return (
    <td
      className={`p-2 whitespace-nowrap ${STAGE_CLASS[type] ?? "text-slate-700"}`}
      title={`${at.toISOString().replace("T", " ").slice(0, 19)} UTC`}
    >
      {stageStamp(at)}
    </td>
  );
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
  // The Received / Opened / Clicked cells are read off each send's own
  // trail, and email signals only reach that trail by projection. Until
  // SHA-4500 the only operator screen that projected was the per-send detail
  // page, so those cells would have read "—" on this list for every
  // recipient whose detail page nobody had opened yet — present in the
  // delivery log, absent from the table that exists to show them.
  // Idempotent and serialised per send, exactly as the detail page's call is.
  const projected = await projectDeliverySignalsForSends(loaded);
  const sends = projected > 0 ? await allSends() : loaded;
  const groups = groupByDocument(sends);

  return (
    <main className="mx-auto max-w-7xl px-6 py-16">
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
        groups.map((group) => {
          // Per group, so a document nobody declined does not carry an empty
          // Declined column, and one that had a bounce does.
          const stages = visibleStages(group.sends);
          return (
            <section key={group.slug} className="mt-8 rounded-lg border border-slate-200 p-4">
              <h2 className="font-medium">
                {group.title}{" "}
                <span className="text-sm font-normal text-slate-500">
                  · {group.sends.length} send{group.sends.length === 1 ? "" : "s"}
                </span>
              </h2>
              <FunnelRow funnel={funnelFor(group.sends)} />

              <div className="mt-4 overflow-x-auto">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-300 text-slate-500">
                      <th className="p-2">Recipient</th>
                      <th className="p-2">Version</th>
                      <th className="p-2">Status</th>
                      <th className="p-2">Created</th>
                      {stages.map((stage) => (
                        <th key={stage.type} className="p-2 whitespace-nowrap">
                          {stage.label}
                        </th>
                      ))}
                      <th className="p-2">Read</th>
                      <th className="p-2">Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.sends.map((send) => {
                      const seconds = readSeconds(send.events);
                      const cells = recipientStages(send.events, send.acceptance?.acceptedAt ?? null);
                      const byType = new Map(cells.map((cell) => [cell.type, cell]));
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
                            {stageStamp(send.createdAt)}
                          </td>
                          {stages.map((stage) => (
                            <StageCell
                              key={stage.type}
                              type={stage.type}
                              at={byType.get(stage.type)?.at ?? null}
                            />
                          ))}
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
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Stage times are the FIRST time each thing happened, in UTC (MM-DD HH:MM; hover
                for the exact instant). Status is the furthest rung this send reached — it never
                reads &ldquo;clicked&rdquo;, which is why clicks have their own column.
              </p>
            </section>
          );
        })
      )}
    </main>
  );
}
