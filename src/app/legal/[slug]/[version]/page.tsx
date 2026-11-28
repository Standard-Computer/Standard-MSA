import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { publishedVersion } from "@/lib/legal/documents";
import { renderEmbedBody, embedCss } from "@/lib/legal/embedDocument";
import { legalSettings } from "@/lib/legal/settings";
import { mspValuesFrom } from "@/lib/legal/embedAssemble";
import { renderLegalBody, parseVersionDefaults } from "@/lib/legal/variables";
import { recordPageVisit } from "@/lib/visits/record";

// A specific PUBLISHED version of a document (SHA-2957). A customer who
// accepted v1 must still be able to read v1 after v2 ships — that is the
// entire reason history pages exist. Drafts stay invisible.
export const dynamic = "force-dynamic";

export default async function LegalVersionPage({
  params,
}: {
  params: Promise<{ slug: string; version: string }>;
}) {
  const { slug, version: versionRaw } = await params;
  const version = Number.parseInt(versionRaw, 10);
  if (!Number.isInteger(version) || version < 1) notFound();

  const found = await publishedVersion(slug, version);
  if (!found) notFound();
  const { doc, ver } = found;

  const [settings, identity] = await Promise.all([
    legalSettings(),
    prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } }),
  ]);
  const msp = mspValuesFrom(identity);
  const html = renderEmbedBody(
    renderLegalBody(ver.bodyMarkdown, "public", msp, parseVersionDefaults(ver.variablesJson)),
  );

  await recordPageVisit(`/legal/${doc.slug}/${ver.version}`, doc.slug, ver.version);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <style dangerouslySetInnerHTML={{ __html: embedCss(settings.accentColor) }} />
      <p className="text-sm">
        <Link href={`/legal/${doc.slug}`} className="text-blue-700">
          ← Current version
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-bold">{doc.title}</h1>
      <p className="mt-1 text-sm text-slate-500">
        v{ver.version}
        {ver.publishedAt ? ` · effective ${ver.publishedAt.toISOString().slice(0, 10)}` : ""}
        {/* This version's own ID — the one a client who accepted THIS text
            cites, which is the whole reason old versions stay readable
            (AC12). */}
        {ver.publicId ? ` · ID ${ver.publicId}` : ""} · historical version{" · "}
        {/* A reader who accepted this version can keep a copy of THIS
            version, not only of the current one (SHA-4501). */}
        <a href={`/legal/${doc.slug}/${ver.version}/pdf`} className="text-blue-700">
          Download PDF
        </a>
      </p>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </main>
  );
}
