// The one canonical HTML escaper for the legal surface (ported from
// ShadowPSA's src/lib/html.ts posture: one escaper, no second implementation
// anywhere in the lane — a second escaper is how one call site quietly uses
// the wrong one).

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}
