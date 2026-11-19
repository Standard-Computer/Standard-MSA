import Link from "next/link";

import { prisma } from "@/lib/db";
import { documentKindLabel, openDraft } from "@/lib/legal/authoringRules";
import { STARTER_TEMPLATES, TEMPLATE_DISCLAIMER } from "@/lib/legal/templates";
import { requireOperator } from "@/lib/auth/page";
import { importTemplateAction } from "./actions";

// /documents (SHA-3086): the authoring home — every document, its published
// state and its open draft. This is the operator view; the public only ever
// sees /legal, which lists PUBLISHED versions alone.
export const dynamic = "force-dynamic";

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; msg?: string }>;
}) {
  const { ok, msg } = await searchParams;
  await requireOperator("/documents");
  const docs = await prisma.legalDocument.findMany({
    orderBy: { id: "asc" },
    include: { versions: { orderBy: { version: "desc" } } },
  });
  const existingSlugs = new Set(docs.map((d) => d.slug));
  const importable = STARTER_TEMPLATES.filter((t) => !existingSlugs.has(t.slug));

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Documents</h1>
        <Link
          href="/documents/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          New document
        </Link>
      </div>
      <p className="mt-2 text-sm text-slate-600">
        Author the agreements this install publishes at <Link href="/legal" className="text-blue-700">/legal</Link> and
        sends from <Link href="/sends/new" className="text-blue-700">Sends</Link>. Drafts are invisible publicly;
        published versions are immutable.
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

      {docs.length === 0 ? (
        <div className="mt-6 rounded-lg border border-slate-200 p-4 text-sm text-slate-600">
          <p className="font-medium text-slate-800">No documents yet.</p>
          <p className="mt-1">
            Import a starter template below, or create a blank document and paste your own text.
          </p>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {docs.map((d) => {
            const published = d.versions.filter((v) => v.publishedAt !== null);
            const draft = openDraft(d.versions);
            return (
              <li key={d.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex items-baseline justify-between">
                  <Link href={`/documents/${d.slug}`} className="font-medium hover:underline">
                    {d.title}
                  </Link>
                  <span className="text-xs text-slate-500">{documentKindLabel(d.kind)}</span>
                </div>
                <p className="mt-1 text-sm text-slate-600">
                  /legal/{d.slug} ·{" "}
                  {published.length > 0 ? `v${published[0].version} published` : "nothing published yet"}
                  {draft ? ` · draft v${draft.version} open` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {importable.length > 0 ? (
        <section className="mt-10 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900">Starter templates</h2>
          <p className="mt-1 text-sm text-amber-800">{TEMPLATE_DISCLAIMER}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            {importable.map((t) => (
              <form key={t.slug} action={importTemplateAction}>
                <input type="hidden" name="template" value={t.slug} />
                <button
                  type="submit"
                  className="rounded-md border border-amber-400 bg-white px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
                >
                  Import {t.title} as a draft
                </button>
              </form>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
