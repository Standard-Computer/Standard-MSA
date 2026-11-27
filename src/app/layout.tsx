import type { Metadata } from "next";
import { cookies } from "next/headers";

import { OperatorShell } from "@/components/nav/OperatorShell";
import { NAV_COLLAPSED_COOKIE, parseNavCollapsed } from "@/lib/nav/collapse";
import "./globals.css";

export const metadata: Metadata = {
  title: "Standard-MSA",
  description:
    "Self-hosted MSA/compliance tool for MSPs: publish legal documents, send unique per-recipient MSAs, and keep acceptance evidence.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The collapse preference is read here, on the server, so the sidebar's
  // first paint is already the right width (src/lib/nav/collapse.ts). Reading
  // a cookie costs no caching: every page in this app is `force-dynamic`.
  //
  // The shell itself decides whether to draw anything — public surfaces get
  // `children` untouched — because only a client component can see the
  // pathname. See src/components/nav/OperatorShell.tsx.
  const jar = await cookies();
  const collapsed = parseNavCollapsed(jar.get(NAV_COLLAPSED_COOKIE)?.value);

  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">
        <OperatorShell initialCollapsed={collapsed}>{children}</OperatorShell>
      </body>
    </html>
  );
}
