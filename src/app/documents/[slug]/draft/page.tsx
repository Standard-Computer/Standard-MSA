import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { openDraft } from "@/lib/legal/authoringRules";
import { mspValuesFrom } from "@/lib/legal/embedAssemble";
import { embedCss, renderEmbedBody } from "@/lib/legal/embedDocument";
import { legalSettings } from "@/lib/legal/settings";
import { TEMPLATE_DISCLAIMER } from "@/lib/legal/templates";
import { parseVersionDefaults, renderLegalBody } from "@/lib/legal/variables";
import { requireOperator } from "@/lib/auth/page";
import { publishDraftAction, saveDraftAction } from "../../actions";

// /documents/[slug]/draft (SHA-3086): edit the open draft and preview it
// through the EXACT public-mode pipeline /legal and the embed use — same
// variable resolution, same markdown renderer, same stylesheet — so what
// the operator approves is what readers get.
export const dynamic = "force-dynamic";

const UNSET_RE = /\[unset: ([a-z0-9_]+)\]/g;

export default async function DraftEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ ok?: string; msg?: string }>;
}) {
  const { slug } = await params;
  const { ok, msg } = await searchParams;
  await requireOperator(`/documents/${slug}/draft`);
  const doc = await prisma.legalDocument.findUnique({
    where: { slug },
    include: { versions: { orderBy: { version: "desc" } } },
  });
  if (!doc) notFound();
  const draft = openDraft(doc.versions);
  // No open draft: the detail page is where one gets started.
  if (!draft) redirect(`/documents/${slug}`);

  const [settings, identity] = await Promise.all([
    legalSettings(),
    prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } }),
  ]);
  const defaults = parseVersionDefaults(draft.variablesJson);
  const rendered = renderLegalBody(draft.bodyMarkdown, "public", mspValuesFrom(identity), defaults);
  const previewHtml = renderEmbedBody(rendered);
  const unresolved = [...new Set([...rendered.matchAll(UNSET_RE)].map((m) => m[1]))];

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <p className="text-sm">
        <Link href={`/documents/${slug}`} className="text-blue-700">
          ← {doc.title}
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold">
        Draft v{draft.version} — {doc.title}
      </h1>
      <p className="mt-2 text-sm text-slate-600">
        Drafts are invisible on /legal, in the embed and to sends until published. {TEMPLATE_DISCLAIMER}
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

      {unresolved.length > 0 ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          Unresolved variables render as a visible blank: {unresolved.map((k) => `{{${k}}}`).join(", ")}.
          Give each a default in the variables box below, or fill your{" "}
          <Link href="/settings/identity" className="underline">
            MSP identity
          </Link>
          .
        </div>
      ) : null}

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="text-sm font-semibold text-slate-700">Edit</h2>
          <form action={saveDraftAction} className="mt-2 space-y-4">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="versionId" value={draft.id} />
            <div>
              <label htmlFor="bodyMarkdown" className="block text-sm font-medium">
                Body (Markdown with {"{{variable}}"} placeholders)
              </label>
              <textarea
                id="bodyMarkdown"
                name="bodyMarkdown"
                required
                rows={28}
                defaultValue={draft.bodyMarkdown}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs leading-relaxed"
              />
            </div>
            <div>
              <label htmlFor="variables" className="block text-sm font-medium">
                Variable defaults (JSON object)
              </label>
              <textarea
                id="variables"
                name="variables"
                rows={4}
                defaultValue={JSON.stringify(defaults, null, 2)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
              />
              <p className="mt-1 text-xs text-slate-500">
                Defaults for tokens that are neither MSP identity ({"{{msp_name}}"}, {"{{venue}}"}, …) nor
                recipient details ({"{{client_legal_name}}"}, {"{{signer_name}}"}, …).
              </p>
            </div>
            <div>
              <label htmlFor="changelog" className="block text-sm font-medium">
                Changelog
              </label>
              <input
                id="changelog"
                name="changelog"
                maxLength={2000}
                defaultValue={draft.changelog ?? ""}
                placeholder="What changed in this version"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Save draft
            </button>
          </form>

          <form action={publishDraftAction} className="mt-4 border-t border-slate-200 pt-4">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="versionId" value={draft.id} />
            <button
              type="submit"
              className="rounded-md border border-green-600 px-4 py-2 text-sm font-medium text-green-700 hover:bg-green-50"
            >
              Publish v{draft.version}
            </button>
            <p className="mt-2 text-xs text-slate-500">
              Publishing uses the last SAVED text, makes it public and immutable, and emails nobody —
              update notices stay a separate choice on Sends → Update notices.
            </p>
          </form>
        </section>

        <section>
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-semibold text-slate-700">
              Preview — as the public /legal page will render it
            </h2>
            {/* The preview and the download are the same text through the
                same pipeline, so the generic wording is reviewable here and
                keepable as a file before anything is published (SHA-4501). */}
            <a
              href={`/documents/${slug}/versions/${draft.version}/pdf`}
              className="shrink-0 text-sm text-blue-700 hover:underline"
            >
              Download as PDF (draft)
            </a>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Both show the no-known-client wording: your MSP details filled in, and client and signer
            details as the generic prose the website uses (&ldquo;the Client&rdquo;, &ldquo;the date of
            acceptance&rdquo;). A send fills in the real recipient instead.
          </p>
          <div className="mt-2 rounded-lg border border-slate-200 p-5">
            <style dangerouslySetInnerHTML={{ __html: embedCss(settings.accentColor) }} />
            <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
          </div>
        </section>
      </div>
    </main>
  );
}
