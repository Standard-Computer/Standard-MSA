import Link from "next/link";

import { DOCUMENT_SLUG_RULE } from "@/lib/legal/authoringRules";
import { requireOperator } from "@/lib/auth/page";
import { createDocumentAction } from "../actions";

// /documents/new (SHA-3086): a blank document. Starter templates import
// from /documents instead — this screen is for an MSP pasting its own text.
export const dynamic = "force-dynamic";

export default async function NewDocumentPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; msg?: string }>;
}) {
  const { ok, msg } = await searchParams;
  await requireOperator("/documents/new");

  return (
    <main className="mx-auto max-w-xl px-6 py-12">
      <p className="text-sm">
        <Link href="/documents" className="text-blue-700">
          ← All documents
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold">New document</h1>
      <p className="mt-2 text-sm text-slate-600">
        The slug becomes the public URL (/legal/&lt;slug&gt;) and cannot change later. After
        creating, you will open its first draft and paste or write the text.
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

      <form action={createDocumentAction} className="mt-6 space-y-4">
        <div>
          <label htmlFor="title" className="block text-sm font-medium">
            Title
          </label>
          <input
            id="title"
            name="title"
            required
            maxLength={200}
            placeholder="Master Service Agreement"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="slug" className="block text-sm font-medium">
            Slug
          </label>
          <input
            id="slug"
            name="slug"
            required
            maxLength={80}
            pattern="[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9]"
            placeholder="msa"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
          />
          <p className="mt-1 text-xs text-slate-500">{DOCUMENT_SLUG_RULE}</p>
        </div>
        <div>
          <label htmlFor="kind" className="block text-sm font-medium">
            Kind
          </label>
          <select
            id="kind"
            name="kind"
            defaultValue="msa"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="msa">Master Service Agreement</option>
            <option value="hipaa-baa">HIPAA Business Associate Agreement</option>
            <option value="other">Other</option>
          </select>
        </div>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Create document
        </button>
      </form>
    </main>
  );
}
