import type { Metadata } from "next";
import "./globals.css";

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
        {children}
      </body>
    </html>
  );
}
