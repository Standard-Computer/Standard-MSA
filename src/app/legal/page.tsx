import Link from "next/link";
import { publishedDocuments } from "@/lib/legal/documents";
import { recordPageVisit } from "@/lib/visits/record";

// The public /legal index (SHA-2957): every published document, never a
// draft, never a hard-coded slug (architecture principle 1 — the MSA, the
// HIPAA BAA and anything the MSP adds all render from the same read).
export const dynamic = "force-dynamic";

export default async function LegalIndexPage() {
  const docs = await publishedDocuments();
  await recordPageVisit("/legal");

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-bold">Legal agreements</h1>
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
                {history.length > 0 ? ` · ${history.length} earlier version${history.length === 1 ? "" : "s"}` : ""}
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
