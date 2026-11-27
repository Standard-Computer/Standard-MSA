import type { Metadata } from "next";
import "./globals.css";

import { OperatorShell } from "@/components/nav/OperatorShell";
import { NAV_COLLAPSE_BOOTSTRAP } from "@/lib/nav/collapse";

export const metadata: Metadata = {
  title: "Standard-MSA",
  description:
    "Self-hosted MSA/compliance tool for MSPs: publish legal documents, send unique per-recipient MSAs, and keep acceptance evidence.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">
        {/* Applies the stored nav collapse state before the rail below is
            parsed, so a collapsed menu never flashes open (SHA-4496). The
            content is a fixed literal built in src/lib/nav/collapse.ts from
            two constants — no request data, no interpolation at render. */}
        <script dangerouslySetInnerHTML={{ __html: NAV_COLLAPSE_BOOTSTRAP }} />
        {/* The shared operator chrome. It renders `children` untouched on the
            public surfaces — /legal, /msa/[token], /login, /setup. */}
        <OperatorShell>{children}</OperatorShell>
      </body>
    </html>
  );
}
