// Document-authoring rules (SHA-3086). PURE.
//
// The decisions that make authoring safe live here, importable by the API
// schemas, the server actions and the unit tests without a database:
//
//   1. What a slug may look like — it becomes a public URL segment
//      (/legal/{slug}) and an API path segment (/documents/{slug}/…), so it
//      is locked to lowercase-kebab at creation and never editable after.
//   2. One OPEN DRAFT per document. Versions are a linear history; two
//      parallel drafts would make "the draft" ambiguous for the editor, the
//      publish button and POST /documents/{slug}/versions alike. (Contrary
//      to a note on the lane issue, no DB partial index enforces this — the
//      schema has none; enforcement is here and in the transaction that
//      calls it.)
//   3. Version numbers only count up: next = highest existing + 1, drafts
//      included, so a discarded-then-recreated draft can never collide with
//      a published number.

// Kept to a linear character-class pattern (the edge-hyphen rule is two
// string checks) so security/detect-unsafe-regex stays quiet and the same
// pattern is publishable in the OpenAPI schema.
export const DOCUMENT_SLUG_RE = /^[a-z0-9-]{1,80}$/;

export const DOCUMENT_SLUG_RULE =
  "Slugs are 1–80 characters of lowercase a-z, 0-9 and hyphens, starting and ending with a letter or digit.";

export function isValidDocumentSlug(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    DOCUMENT_SLUG_RE.test(raw) &&
    !raw.startsWith("-") &&
    !raw.endsWith("-")
  );
}

/** Known document kinds get labels; anything else renders as itself. */
export const DOCUMENT_KIND_LABELS: Record<string, string> = {
  msa: "Master Service Agreement",
  "hipaa-baa": "HIPAA Business Associate Agreement",
  "website-terms": "Website Terms of Use",
};

export function documentKindLabel(kind: string): string {
  return DOCUMENT_KIND_LABELS[kind] ?? kind;
}

export type VersionSlice = { version: number; publishedAt: Date | null };

/** The open draft among a document's versions, or null. */
export function openDraft<V extends VersionSlice>(versions: readonly V[]): V | null {
  return versions.find((v) => v.publishedAt === null) ?? null;
}

/** The next version number: highest existing + 1, drafts included. */
export function nextVersionNumber(versions: readonly VersionSlice[]): number {
  return versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
}

/**
 * variables for a draft, as posted → the string stored in variablesJson.
 * Only string values survive (matching parseVersionDefaults on the way
 * out); keys are lowercased so `{{Client_Name}}` in a body and
 * `client_name` in defaults meet.
 */
export function serializeVersionDefaults(variables: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(variables)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return JSON.stringify(out);
}
