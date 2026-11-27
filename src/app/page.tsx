import Link from "next/link";
import { redirect } from "next/navigation";

import { requireOperator } from "@/lib/auth/page";
import { mspIdentity, needsOnboarding } from "@/lib/identity/identity";
import { dashboardCards } from "@/lib/nav/nav";

// Reads the database (onboarding redirect); never prerender at build.
export const dynamic = "force-dynamic";

export default async function Home() {
  await requireOperator("/");
  // First visit goes to the wizard until it is completed or deliberately
  // skipped (docs/ARCHITECTURE.md § Self-host story).
  const row = await mspIdentity();
  if (needsOnboarding(row)) redirect("/onboarding");

  // The cards come from the nav table (src/lib/nav/nav.ts), which is why they
  // no longer have an `href: null` state to fall into: a card is a property of
  // a nav destination, so it cannot exist without that destination's link.
  const cards = dashboardCards();

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Standard-MSA</h1>
      <p className="mt-2 text-slate-600">
        Stand-alone, self-hosted MSA/compliance tool for MSPs. Every module is
        in the menu on the left.
      </p>
      <ul className="mt-8 space-y-4">
        {cards.map((m) => (
          <li
            key={m.id}
            className="rounded-lg border border-slate-200 p-4 hover:border-slate-300"
          >
            <div className="font-medium">
              <Link href={m.href} className="hover:underline">
                {m.card.title}
              </Link>
            </div>
            <div className="text-sm text-slate-600">{m.card.body}</div>
          </li>
        ))}
      </ul>
    </main>
  );
}
