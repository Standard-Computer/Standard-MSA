import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/db";
import { documentKindLabel, openDraft } from "@/lib/legal/authoringRules";
import { requireOperator } from "@/lib/auth/page";
import { createDraftAction, publishDraftAction } from "../actions";

// /documents/[slug] (SHA-3086): one document's version history and the
// actions on it. Publishing here NEVER emails anybody — update notices are
// the operator's separate, explicit decision on /sends/notices.
export const dynamic = "force-dynamic";

export default async function DocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ ok?: string; msg?: string }>;
}) {
  const { slug } = await params;
  const { ok, msg } = await searchParams;
  await requireOperator(`/documents/${slug}`);
  const doc = await prisma.legalDocument.findUnique({
    where: { slug },
    include: { versions: { orderBy: { version: "desc" } } },
  });
  if (!doc) notFound();

  const draft = openDraft(doc.versions);
  const published = doc.versions.filter((v) => v.publishedAt !== null);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <p className="text-sm">
        <Link href="/documents" className="text-blue-700">
          ← All documents
        </Link>
      </p>
      <div className="mt-2 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">{doc.title}</h1>
        <span className="text-xs text-slate-500">{documentKindLabel(doc.kind)}</span>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        {published.length > 0 ? (
          <>
            Live at{" "}
            <Link href={`/legal/${doc.slug}`} className="text-blue-700">
              /legal/{doc.slug}
            </Link>{" "}
            (v{published[0].version})
          </>
        ) : (
          <>Nothing published yet — /legal/{doc.slug} will exist once a version is published.</>
        )}
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

      <section className="mt-8">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Versions</h2>
          {draft ? (
            <Link
              href={`/documents/${doc.slug}/draft`}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Edit draft v{draft.version}
            </Link>
          ) : (
            <form action={createDraftAction}>
              <input type="hidden" name="slug" value={doc.slug} />
              <button
                type="submit"
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
              >
                {doc.versions.length > 0 ? "Start a new draft from the latest text" : "Start the first draft"}
              </button>
            </form>
          )}
        </div>

        {doc.versions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No versions yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {doc.versions.map((v) => (
              <li key={v.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">
                    v{v.version}{" "}
                    {v.publishedAt ? (
                      <span className="text-green-700">
                        · published {v.publishedAt.toISOString().slice(0, 10)}
                      </span>
                    ) : (
                      <span className="text-amber-700">· draft</span>
                    )}
                  </span>
                  {v.publishedAt === null ? (
                    <span className="flex gap-2">
                      <Link href={`/documents/${doc.slug}/draft`} className="text-blue-700">
                        Edit
                      </Link>
                      {/* Every version row downloads, drafts included — the
                          file says DRAFT on its cover and in every footer. */}
                      <a
                        href={`/documents/${doc.slug}/versions/${v.version}/pdf`}
                        className="text-blue-700"
                      >
                        PDF
                      </a>
                      <form action={publishDraftAction}>
                        <input type="hidden" name="slug" value={doc.slug} />
                        <input type="hidden" name="versionId" value={v.id} />
                        <button type="submit" className="font-medium text-green-700 hover:underline">
                          Publish
                        </button>
                      </form>
                    </span>
                  ) : (
                    <span className="flex gap-2">
                      <Link href={`/legal/${doc.slug}/${v.version}`} className="text-blue-700">
                        View
                      </Link>
                      <a
                        href={`/documents/${doc.slug}/versions/${v.version}/pdf`}
                        className="text-blue-700"
                      >
                        PDF
                      </a>
                    </span>
                  )}
                </div>
                {v.changelog ? <p className="mt-1 text-slate-600">{v.changelog}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-6 text-xs text-slate-500">
        Every <span className="font-medium">PDF</span> above is the version as the public sees it:
        your MSP details are filled in and client and signer details use the generic wording (&ldquo;the
        Client&rdquo;, &ldquo;the date of acceptance&rdquo;), because a download has no recipient. It is the same
        text the embed and{" "}
        <Link href={`/legal/${doc.slug}`} className="text-blue-700">
          /legal/{doc.slug}
        </Link>{" "}
        show when there is no known client — so this is how to read and keep what your website will
        say. A per-recipient copy stays on the send itself.
      </p>

      <p className="mt-4 text-xs text-slate-500">
        Publishing makes a version public and immutable; it never emails anybody. To tell prior
        recipients about an update, use{" "}
        <Link href="/sends/notices" className="text-blue-700">
          Sends → Update notices
        </Link>{" "}
        afterwards — notices are always your explicit call.
      </p>
    </main>
  );
}
