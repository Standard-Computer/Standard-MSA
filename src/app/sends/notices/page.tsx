import Link from "next/link";

import { SubmitButton } from "@/components/sends/SubmitButton";
import { NOTICE_AUDIENCE_LABELS, NOTICE_AUDIENCES } from "@/lib/sends/audience";
import { getEmailConfig } from "@/lib/email/config";
import { listNoticeCandidates, noticeContext } from "@/lib/sends/notices";
import { sendNoticeAction } from "./actions";

// Operator screen: offer the update notice (SHA-2959).
//
// Nothing on this page sends anything on load. It shows which documents have
// prior recipients on an older version, what changed, and who could be told —
// then waits for a human to choose. Per Sean, the notice is an option
// presented, never automatic.
export const dynamic = "force-dynamic";

const DIFF_CLASS: Record<string, string> = {
  added: "bg-green-50 text-green-900",
  removed: "bg-red-50 text-red-900",
  same: "text-slate-500",
};

const DIFF_MARK: Record<string, string> = { added: "+", removed: "−", same: " " };

export default async function NoticesPage({
  searchParams,
}: {
  searchParams: Promise<{ documentId?: string; ok?: string; msg?: string }>;
}) {
  const { documentId, ok, msg } = await searchParams;
  const selectedId = Number(documentId);
  const [candidates, emailState] = await Promise.all([listNoticeCandidates(), getEmailConfig()]);
  const context =
    Number.isInteger(selectedId) && selectedId > 0 ? await noticeContext(selectedId) : null;

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <p className="text-sm">
        <Link href="/sends" className="text-blue-700">
          ← All sends
        </Link>
      </p>
      <h1 className="mt-2 text-3xl font-semibold">Update notices</h1>
      <p className="mt-2 text-slate-600">
        When a document is republished, prior recipients are <strong>not</strong> notified
        automatically. Review what changed, choose who should hear about it, and send.
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

      {!emailState.configured ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          Email is not configured, so no notice can be sent: {emailState.reason}
        </div>
      ) : null}

      {candidates.length === 0 ? (
        <p className="mt-8 text-sm text-slate-600">
          Nothing to notify. Every prior recipient already holds the current published version
          of the document they were sent.
        </p>
      ) : (
        <section className="mt-6 rounded-lg border border-slate-200 p-4">
          <h2 className="font-medium">Documents with recipients on an older version</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {candidates.map((candidate) => (
              <li
                key={candidate.documentId}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-2 last:border-0"
              >
                <span>
                  <strong>{candidate.title}</strong> · current v{candidate.currentVersion} ·{" "}
                  {candidate.staleRecipients.length} recipient
                  {candidate.staleRecipients.length === 1 ? "" : "s"} behind (
                  {candidate.acceptedRecipients.length} accepted)
                </span>
                <Link
                  href={`/sends/notices?documentId=${candidate.documentId}`}
                  className="text-blue-700"
                >
                  Review and choose →
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {context ? (
        <>
          <section className="mt-8 rounded-lg border border-slate-200 p-4">
            <h2 className="font-medium">
              What changed in {context.candidate.title} v{context.version.version}
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {context.previous
                ? `Compared with v${context.previous.version}: ${context.summary.added} line${
                    context.summary.added === 1 ? "" : "s"
                  } added, ${context.summary.removed} removed.`
                : "No earlier published version to compare against — the whole body is new."}
            </p>
            {context.version.changelog ? (
              <p className="mt-2 text-sm">
                <span className="text-slate-500">Changelog: </span>
                {context.version.changelog}
              </p>
            ) : null}

            {context.diff.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">The body is unchanged.</p>
            ) : (
              <div className="mt-3 max-h-96 overflow-auto rounded border border-slate-200">
                {context.diff.map((hunk, index) => (
                  <pre
                    key={index}
                    className="border-b border-slate-200 p-2 text-xs leading-relaxed last:border-0"
                  >
                    {hunk.lines.map((line, i) => (
                      <div key={i} className={DIFF_CLASS[line.kind]}>
                        <span className="select-none pr-2 font-bold">{DIFF_MARK[line.kind]}</span>
                        {line.text || " "}
                      </div>
                    ))}
                  </pre>
                ))}
              </div>
            )}
          </section>

          <form action={sendNoticeAction} className="mt-6 rounded-lg border border-slate-200 p-4">
            <input type="hidden" name="documentId" value={context.candidate.documentId} />
            <h2 className="font-medium">Choose the audience</h2>

            <div className="mt-3 space-y-2 text-sm">
              {NOTICE_AUDIENCES.map((audience, index) => (
                <label key={audience} className="flex items-center gap-2">
                  <input type="radio" name="audience" value={audience} defaultChecked={index === 0} />
                  <span>
                    {NOTICE_AUDIENCE_LABELS[audience]}
                    {audience === "all" ? ` (${context.candidate.staleRecipients.length})` : null}
                    {audience === "accepted"
                      ? ` (${context.candidate.acceptedRecipients.length})`
                      : null}
                  </span>
                </label>
              ))}
            </div>

            <fieldset className="mt-4 rounded border border-slate-200 p-3 text-sm">
              <legend className="px-1 text-slate-500">
                Selected recipients — used only with &ldquo;Selected recipients&rdquo; above
              </legend>
              {context.recipients.map((recipient) => (
                <label key={recipient.recipientId} className="mt-1 flex items-center gap-2 first:mt-0">
                  <input type="checkbox" name="recipientIds" value={recipient.recipientId} />
                  <span>
                    {recipient.email}
                    {recipient.name ? ` · ${recipient.name}` : ""} · holds v{recipient.heldVersion}
                    {recipient.accepted ? " · accepted" : ""}
                  </span>
                </label>
              ))}
            </fieldset>

            <p className="mt-3 text-xs text-slate-500">
              The notice links to the public current version. It does not alter an agreement
              anyone already accepted — their accepted copy stays exactly as accepted.
            </p>

            <SubmitButton
              disabled={!emailState.configured}
              pendingLabel="Sending…"
              className="mt-3 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:bg-slate-400"
            >
              Send update notice
            </SubmitButton>
            <p className="mt-2 text-xs text-slate-500">
              Each recipient is notified once per version. Sending again reaches only people who
              have not already been told about v{context.version.version}.
            </p>
          </form>
        </>
      ) : null}
    </main>
  );
}
