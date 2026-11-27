import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { publishedDocument } from "@/lib/legal/documents";
import { renderEmbedBody, embedCss } from "@/lib/legal/embedDocument";
import { legalSettings } from "@/lib/legal/settings";
import { mspValuesFrom } from "@/lib/legal/embedAssemble";
import { renderLegalBody, parseVersionDefaults } from "@/lib/legal/variables";
import { recordPageVisit } from "@/lib/visits/record";

// The public page for one document's CURRENT published version (SHA-2957).
// Renders through the exact same public-mode pipeline as the embed frame, so
// the two surfaces cannot disagree about what is in force.
export const dynamic = "force-dynamic";

export default async function LegalDocumentPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const published = await publishedDocument(slug);
  if (!published) notFound();
  const { doc, current, history } = published;

  const [settings, identity] = await Promise.all([
    legalSettings(),
    prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } }),
  ]);
  const msp = mspValuesFrom(identity);
  const html = renderEmbedBody(
    renderLegalBody(current.bodyMarkdown, "public", msp, parseVersionDefaults(current.variablesJson)),
  );

  await recordPageVisit(`/legal/${doc.slug}`, doc.slug, current.version);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      {/* The sm-l-* stylesheet the markdown renderer targets — the same CSS
          the frame ships, so one look everywhere. */}
      <style dangerouslySetInnerHTML={{ __html: embedCss(settings.accentColor) }} />
      <p className="text-sm">
        <Link href="/legal" className="text-blue-700">
          ← All agreements
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-bold">{doc.title}</h1>
      <p className="mt-1 text-sm text-slate-500">
        v{current.version}
        {current.publishedAt ? ` · effective ${current.publishedAt.toISOString().slice(0, 10)}` : ""}
        {" · "}
        <a href={`/legal/${doc.slug}/pdf`} className="text-blue-700">
          Download PDF
        </a>
      </p>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {history.length > 0 && (
        <section className="mt-8 border-t border-slate-200 pt-4 text-sm">
          <h2 className="font-semibold">Version history</h2>
          <ul className="mt-2 space-y-1">
            {history.map((v) => (
              <li key={v.id}>
                <Link href={`/legal/${doc.slug}/${v.version}`} className="text-blue-700">
                  v{v.version}
                </Link>
                {v.publishedAt ? ` · effective ${v.publishedAt.toISOString().slice(0, 10)}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
