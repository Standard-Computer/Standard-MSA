// Rendering one send's document (SHA-2959).
//
// Goes through the SAME pipeline as the public /legal surface — the shared
// `renderLegalBody` and the shared `sm-l-*` markdown renderer — with the
// mode switched to `filled` and the frozen per-send merge variables layered
// in. One pipeline is the point: if the recipient's copy and the public copy
// could be produced by different code, they could disagree about what the
// agreement says.

import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { mspValuesFrom } from "@/lib/legal/embedAssemble";
import { renderEmbedBody } from "@/lib/legal/embedDocument";
import { parseVersionDefaults, renderLegalBody } from "@/lib/legal/variables";
import { acceptanceMergeVars, parseMergeVars } from "./merge";
import type { SendWithTrail } from "./sends";

export type RenderedSend = {
  title: string;
  slug: string;
  version: number;
  /** The merged Markdown — what the recipient agreed to, in source form. */
  markdown: string;
  /** The merged body as HTML for the reading surface. */
  html: string;
  /** sha256 of `markdown`, so evidence can prove the exact words later. */
  bodyHash: string;
};

export function hashBody(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

/**
 * Render a send's document as the recipient sees it.
 *
 * MSP values are read LIVE (the MSP's own address changing is a correction
 * to their own details), while recipient values come from the send's frozen
 * `mergedVarsJson` — never a live re-read of the recipient row, which a
 * later send to the same person may have enriched.
 *
 * Date tokens resolve only once accepted; before that they fall through to
 * the generic "the date of acceptance" wording rather than showing a blank,
 * because an unaccepted agreement genuinely has no effective date yet.
 */
export async function renderSendDocument(send: SendWithTrail): Promise<RenderedSend> {
  const identity = await prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } });
  const msp = mspValuesFrom(identity);
  const version = send.documentVersion;

  const recipientValues = {
    ...parseMergeVars(send.mergedVarsJson),
    ...acceptanceMergeVars(send.acceptedAt),
  };
  const markdown = renderLegalBody(
    version.bodyMarkdown,
    "filled",
    msp,
    parseVersionDefaults(version.variablesJson),
    recipientValues,
  );

  return {
    title: version.document.title,
    slug: version.document.slug,
    version: version.version,
    markdown,
    html: renderEmbedBody(markdown),
    bodyHash: hashBody(markdown),
  };
}
