"use server";

// Document-authoring server actions (SHA-3086). Feedback travels as an
// ?ok=/&msg= redirect so every screen stays a plain server component,
// matching Sends (SHA-2959) and Settings → Email (SHA-2958).
//
// Everything here goes through src/lib/legal/authoring.ts — the same rules
// the /api/v1 authoring endpoints enforce — so the UI and the API cannot
// disagree about slugs, the one-open-draft invariant, or immutability.

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { createDocument, createDraft, markPublished, updateDraft } from "@/lib/legal/authoring";
import { parseVersionDefaults } from "@/lib/legal/variables";
import { starterTemplate } from "@/lib/legal/templates";
import { requireOperator } from "@/lib/auth/page";

// AUTH (SHA-3047): every action here calls requireOperator() first. A server
// action is a POST endpoint on its page's path, so gating the screen alone
// would leave the write reachable by anyone who can derive an action id —
// and this repo is public, so that build is reproducible.

function finish(path: string, ok: boolean, message: string): never {
  redirect(`${path}?ok=${ok ? "1" : "0"}&msg=${encodeURIComponent(message)}`);
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** The variables textarea: a JSON object of string values, or "" for none. */
function parseVariablesField(raw: string): { ok: true; variables: Record<string, string> } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, variables: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "Variables must be a JSON object, e.g. {\"payment_terms_days\": \"30\"}." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Variables must be a JSON object of string values." };
  }
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      return { ok: false, error: `Variable "${key}" must be a string value.` };
    }
    variables[key] = value;
  }
  return { ok: true, variables };
}

/** Create an empty document; the editor opens on its first draft next. */
export async function createDocumentAction(formData: FormData): Promise<void> {
  await requireOperator("/documents/new");
  const result = await createDocument({
    slug: text(formData, "slug"),
    title: text(formData, "title"),
    kind: text(formData, "kind"),
  });
  if (!result.ok) finish("/documents/new", false, result.message);
  finish(`/documents/${result.document.slug}`, true, "Document created. Start its first draft below.");
}

/**
 * Import a starter template as a new document WITH its first draft. The
 * result is the operator's own draft — invisible publicly, theirs to edit,
 * and published only when they say so.
 */
export async function importTemplateAction(formData: FormData): Promise<void> {
  await requireOperator("/documents");
  const template = starterTemplate(text(formData, "template"));
  if (!template) finish("/documents", false, "Unknown template.");
  const created = await createDocument({
    slug: template.slug,
    title: template.title,
    kind: template.kind,
  });
  if (!created.ok) finish("/documents", false, created.message);
  const draft = await createDraft(template.slug, {
    bodyMarkdown: template.bodyMarkdown,
    variables: template.variables,
    changelog: "Imported starter template — review with your own counsel before publishing.",
  });
  if (!draft.ok) finish("/documents", false, draft.message);
  finish(
    `/documents/${template.slug}/draft`,
    true,
    "Template imported as a draft. It is an example, not legal advice — review it with your own counsel, then publish.",
  );
}

/** Open the next draft, seeded from the latest version's text when there is one. */
export async function createDraftAction(formData: FormData): Promise<void> {
  const slug = text(formData, "slug");
  await requireOperator(`/documents/${slug}`);
  const document = await prisma.legalDocument.findUnique({
    where: { slug },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  if (!document) finish("/documents", false, "No such document.");
  // Seeded from the latest version — text AND variable defaults — so a new
  // draft starts as "the current agreement, ready to amend".
  const latest = document.versions[0];
  const result = await createDraft(slug, {
    bodyMarkdown: latest?.bodyMarkdown ?? `## ${document.title}\n\nWrite the agreement here. {{msp_name}} is the provider; {{client_legal_name}} is the client.`,
    variables: latest ? parseVersionDefaults(latest.variablesJson) : {},
    changelog: null,
  });
  if (!result.ok) finish(`/documents/${slug}`, false, result.message);
  finish(`/documents/${slug}/draft`, true, `Draft v${result.version.version} opened.`);
}

export async function saveDraftAction(formData: FormData): Promise<void> {
  const slug = text(formData, "slug");
  await requireOperator(`/documents/${slug}/draft`);
  const versionId = Number(text(formData, "versionId"));
  if (!Number.isInteger(versionId) || versionId <= 0) {
    finish(`/documents/${slug}/draft`, false, "Unknown draft.");
  }
  const variables = parseVariablesField(text(formData, "variables"));
  if (!variables.ok) finish(`/documents/${slug}/draft`, false, variables.error);
  const result = await updateDraft(versionId, {
    bodyMarkdown: text(formData, "bodyMarkdown"),
    variables: variables.variables,
    changelog: text(formData, "changelog") || null,
  });
  if (!result.ok) finish(`/documents/${slug}/draft`, false, result.message);
  finish(`/documents/${slug}/draft`, true, "Draft saved. The preview below is what readers will see.");
}

/**
 * Publish the open draft. Publishing NEVER emails anybody — if prior
 * recipients should hear about the change, that is the operator's separate,
 * explicit choice on /sends/notices (Sean's rule).
 */
export async function publishDraftAction(formData: FormData): Promise<void> {
  const slug = text(formData, "slug");
  await requireOperator(`/documents/${slug}`);
  const versionId = Number(text(formData, "versionId"));
  const document = await prisma.legalDocument.findUnique({ where: { slug } });
  if (!document) finish("/documents", false, "No such document.");
  const version = await prisma.legalDocumentVersion.findUnique({ where: { id: versionId } });
  if (!version || version.documentId !== document.id) {
    finish(`/documents/${slug}`, false, "No such version on this document.");
  }
  const { version: published, alreadyPublished } = await markPublished(document, version);
  finish(
    `/documents/${slug}`,
    true,
    alreadyPublished
      ? `v${published.version} was already published.`
      : `v${published.version} is published and live at /legal/${slug}. Nobody was emailed — to tell prior recipients, use Sends → Update notices.`,
  );
}
