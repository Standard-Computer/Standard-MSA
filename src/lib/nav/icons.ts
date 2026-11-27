// Nav glyphs (SHA-4503, GH #17).
//
// The collapsed rail shows icons instead of labels, so every nav item needs
// one. Hand-drawn 24×24 stroke paths rather than an icon dependency: this app
// is a self-hosted single binary and eight outlines do not justify a package.
//
// Data, not JSX, so tests/nav/nav.test.ts can assert the cover is complete
// without rendering a React tree. Keyed by `NavItem.id`.

/** `d` attribute for a 24×24, `fill="none"`, `stroke="currentColor"` glyph. */
export const NAV_ICON_PATHS: Readonly<Record<string, string>> = {
  // Checklist: two ticked lines — the onboarding wizard.
  onboarding: "M4 7l2 2 3-3M4 16l2 2 3-3M13 8h7M13 17h7",
  // Dog-eared page.
  documents: "M7 3h7l4 4v14H7zM14 3v4h4",
  // Paper plane.
  sends: "M3 12l18-9-8 18-2-7z",
  // Angle brackets: the embed snippet.
  "legal-embed": "M9 8l-4 4 4 4M15 8l4 4-4 4",
  // Eye: the visitor log.
  "legal-visits":
    "M2 12c3-4 6-6 10-6s7 2 10 6c-3 4-6 6-10 6s-7-2-10-6zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6",
  // Globe: the public site.
  "legal-public":
    "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c3 4 3 14 0 18M12 3c-3 4-3 14 0 18",
  // Person.
  "settings-identity": "M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8M4 20c0-4 4-6 8-6s8 2 8 6",
  // Envelope.
  "settings-email": "M3 6h18v12H3zM3 7l9 7 9-7",
  // Terminal window.
  "settings-api": "M4 5h16v14H4zM8 10l3 2-3 2M13 14h4",
};
