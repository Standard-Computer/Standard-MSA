import Link from "next/link";
import { redirect } from "next/navigation";

import { requireOperator } from "@/lib/auth/page";
import { mspIdentity, needsOnboarding } from "@/lib/identity/identity";
import { MODULE_CARDS } from "@/lib/nav/operatorNav";

// Reads the database (onboarding redirect); never prerender at build.
export const dynamic = "force-dynamic";

export default async function Home() {
  await requireOperator("/");
  // First visit goes to the wizard until it is completed or deliberately
  // skipped (docs/ARCHITECTURE.md § Self-host story).
  const row = await mspIdentity();
  if (needsOnboarding(row)) redirect("/onboarding");

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Standard-MSA</h1>
      <p className="mt-2 text-slate-600">
        Stand-alone, self-hosted MSA/compliance tool for MSPs. Every module is
        in the menu on the left, and on a card below.
      </p>
      <ul className="mt-8 space-y-4">
        {/* MODULE_CARDS is the same table the left nav is held against
            (src/lib/nav/operatorNav.ts): every card links somewhere, and
            tests/nav/links.test.ts fails if a destination is not in the nav.
            The v0 version of this list let `href` be null, which is how
            /embed and /settings/email sat unreachable (SHA-4496, GH #17). */}
        {MODULE_CARDS.map((m) => (
          <li key={m.title} className="rounded-lg border border-slate-200 p-4">
            <div className="font-medium">
              <Link href={m.href} className="hover:underline">
                {m.title}
              </Link>
            </div>
            <div className="text-sm text-slate-600">{m.body}</div>
          </li>
        ))}
      </ul>
    </main>
  );
}
