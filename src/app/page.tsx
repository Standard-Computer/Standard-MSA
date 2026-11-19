import Link from "next/link";
import { redirect } from "next/navigation";

import { requireOperator } from "@/lib/auth/page";
import { mspIdentity, needsOnboarding } from "@/lib/identity/identity";

// Reads the database (onboarding redirect); never prerender at build.
export const dynamic = "force-dynamic";

const modules = [
  {
    title: "Onboarding",
    body: "MSP identity, contract header preview, venue. Re-run any time.",
    lane: "SHA-2956",
    href: "/settings/identity",
  },
  {
    title: "/legal site",
    body: "Public legal pages, website embed generator, visitor log, liveness monitor.",
    lane: "SHA-2957",
    href: null,
  },
  {
    title: "Email delivery",
    body: "SMTP2GO / SendGrid / SMTP — configured at runtime, keys from env only.",
    lane: "SHA-2958",
    href: null,
  },
  {
    title: "Documents",
    body: "Author the MSA / HIPAA BAA: drafts, preview, publish, version history. Starter templates included.",
    lane: "SHA-3086",
    href: "/documents",
  },
  {
    title: "MSA sends",
    body: "Unique per-recipient MSAs with full lifecycle tracking and acceptance evidence.",
    lane: "SHA-2959",
    href: "/sends",
  },
  {
    title: "API",
    body: "API keys, OpenAPI spec and webhooks for PSA/AI tools to create MSA sends.",
    lane: "SHA-2960",
    href: "/settings/api",
  },
];

export default async function Home() {
  await requireOperator("/");
  // First visit goes to the wizard until it is completed or deliberately
  // skipped (docs/ARCHITECTURE.md § Self-host story).
  const row = await mspIdentity();
  if (needsOnboarding(row)) redirect("/onboarding");

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="flex items-baseline justify-between">
        <h1 className="text-3xl font-semibold">Standard-MSA</h1>
        <Link href="/settings/identity" className="text-sm text-slate-600 hover:underline">
          Settings → Identity
        </Link>
      </div>
      <p className="mt-2 text-slate-600">
        Stand-alone, self-hosted MSA/compliance tool for MSPs. Scaffold build —
        modules land here as they are completed.
      </p>
      <ul className="mt-8 space-y-4">
        {modules.map((m) => (
          <li key={m.title} className="rounded-lg border border-slate-200 p-4">
            <div className="font-medium">
              {m.href ? (
                <Link href={m.href} className="hover:underline">
                  {m.title}
                </Link>
              ) : (
                m.title
              )}
            </div>
            <div className="text-sm text-slate-600">{m.body}</div>
          </li>
        ))}
      </ul>
    </main>
  );
}
