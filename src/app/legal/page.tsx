import Link from "next/link";
import { prisma } from "@/lib/db";
import { publishedDocuments } from "@/lib/legal/documents";
import { legalSettings } from "@/lib/legal/settings";
import { mspValuesFrom } from "@/lib/legal/embedAssemble";
import { resolveIntroParagraphs } from "@/lib/legal/intro";
import { recordPageVisit } from "@/lib/visits/record";

// The public /legal index (SHA-2957): every published document, never a
// draft, never a hard-coded slug (architecture principle 1 — the MSA, the
// HIPAA BAA and anything the MSP adds all render from the same read).
//
// SHA-4708 adds the intro above the list, and the citable version ID plus a
// history link on each row. The intro comes from resolveIntroParagraphs —
// the SAME function the embed assembler calls — so this page and the embed
// cannot show different text (GH #33 §1).
export const dynamic = "force-dynamic";

export default async function LegalIndexPage() {
  const [docs, settings, identity] = await Promise.all([
    publishedDocuments(),
    legalSettings(),
    prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } }),
  ]);
  // Tokens resolve from CURRENT identity, not from a snapshot taken when the
  // intro was saved: an MSP that changes its phone number changes this page.
  const introParagraphs = resolveIntroParagraphs(settings.introText, mspValuesFrom(identity));
  await recordPageVisit("/legal");

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold">Legal agreements</h1>
      {introParagraphs.length > 0 && (
        <div className="mt-4 space-y-3 text-sm text-slate-700">
          {introParagraphs.map((paragraph, i) => (
            // A PLAIN-TEXT JSX CHILD, never dangerouslySetInnerHTML. This is
            // the escape half of "substitute first, then escape": the intro
            // is operator-written text plus merged identity values, so a
            // saved "<script>" or a trading name containing "<" must reach
            // the page as characters, and React guarantees that here (AC4).
            // The index is deliberately keyed by position — the paragraphs
            // are resolved text with no identity of their own.
            <p key={i}>{paragraph}</p>
          ))}
        </div>
      )}
      {docs.length === 0 ? (
        <p className="mt-4 text-slate-600">No agreements have been published yet.</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {docs.map(({ doc, current, history }) => (
            <li key={doc.id} className="rounded border border-slate-200 p-4">
              <Link href={`/legal/${doc.slug}`} className="text-lg font-semibold text-blue-700">
                {doc.title}
              </Link>
              <p className="mt-1 text-sm text-slate-500">
                v{current.version}
                {current.publishedAt ? ` · effective ${current.publishedAt.toISOString().slice(0, 10)}` : ""}
                {/* The unique version ID the intro promises (AC11). Omitted
                    rather than shown blank on a row the backfill has not
                    reached. */}
                {current.publicId ? ` · ID ${current.publicId}` : ""}
                {" · "}
                {/* Was plain text ("N earlier versions"); now the link to the
                    history page the intro tells visitors about. It points at
                    the existing per-agreement page's #history section — no
                    new route (AC11). The link shows even with no earlier
                    versions, because the section lists the current one too,
                    so the promise in the intro is never dead. */}
                <Link href={`/legal/${doc.slug}#history`} className="text-blue-700">
                  {history.length === 0
                    ? "Version history"
                    : `Version history (${history.length} earlier)`}
                </Link>
                {" · "}
                <a href={`/legal/${doc.slug}/pdf`} className="text-blue-700">
                  PDF
                </a>
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
