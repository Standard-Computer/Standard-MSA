"use client";

import { useState } from "react";

/** One-click copy for the snippet generator (SHA-2957). */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}
