import Link from "next/link";

import { getEmailConfig } from "@/lib/email/config";
import { publishedDocuments } from "@/lib/legal/documents";
import { SendForm, type SendFormDocument } from "@/components/sends/SendForm";
import { createAndSendAction } from "../actions";
import { requireOperator } from "@/lib/auth/page";

// Operator screen: send a unique MSA to one recipient (SHA-2959).
export const dynamic = "force-dynamic";

export default async function NewSendPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; msg?: string }>;
}) {
  const { ok, msg } = await searchParams;
  await requireOperator("/sends/new");
  const [published, emailState] = await Promise.all([publishedDocuments(), getEmailConfig()]);

  const documents: SendFormDocument[] = published.map((p) => ({
    versionId: p.current.id,
    label: `${p.doc.title} — v${p.current.version}`,
  }));

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-sm">
        <Link href="/sends" className="text-blue-700">
          ← All sends
        </Link>
      </p>
      <h1 className="mt-2 text-3xl font-semibold">Send an MSA</h1>
      <p className="mt-2 text-slate-600">
        Each send gets its own unguessable URL, its own merged copy of the agreement, and
        its own lifecycle log.
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
          Email is not configured, so nothing can be mailed yet: {emailState.reason} You can
          still create the send and copy its unique link by hand.{" "}
          <Link href="/settings/email" className="underline">
            Settings → Email
          </Link>
        </div>
      ) : null}

      {documents.length === 0 ? (
        <div className="mt-6 rounded-lg border border-slate-200 p-4 text-sm text-slate-600">
          <p className="font-medium text-slate-800">No published document to send.</p>
          <p className="mt-1">
            A send is always of a <em>published</em> version — a draft is not an offer. This
            build has no document authoring screen yet, so published versions come from the
            database directly.
          </p>
        </div>
      ) : (
        <SendForm documents={documents} action={createAndSendAction} />
      )}
    </main>
  );
}
