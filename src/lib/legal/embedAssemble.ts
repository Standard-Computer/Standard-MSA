import type { ResolvedLegalSettings } from "./settings";
import type { PublishedDocument } from "./documents";
import { renderLegalBody, parseVersionDefaults, type MspValues } from "./variables";
import { renderEmbedBody, type EmbedDoc } from "./embedDocument";

// The PURE assembly half of the embed data read (SHA-2957) — split from
// ./embedData.ts so tests can exercise the two rules that matter without a
// database or a Next request:
//
//   · "renders every published document with MSP merges and generic client
//     wording, no raw {{tokens}}" — every body goes through renderLegalBody
//     in "public" mode, the same mode the /legal pages use. The mode is the
//     guarantee: MSP variables fill from MspIdentity, every client-sourced
//     variable renders its neutral generic prose, and nothing here can pass
//     a client value in because nothing here HAS one.
//   · "change the MSP name/footer in settings => embed reflects it, snippet
//     unchanged" — nothing is cached per install and no MSP value is baked
//     into the snippet. The snippet names a host and a container; everything
//     else is resolved per request.

export type EmbedData = {
  docs: EmbedDoc[];
  introParagraphs: string[];
  footerLines: string[];
  accentColor: string;
  indexHref: string;
  embedEnabled: boolean;
  embedOrigins: string[];
};

/** MspIdentity row (or none yet) → the variables' MSP values. */
export function mspValuesFrom(identity: {
  name: string;
  legalName: string | null;
  address: string | null;
  ownerName: string | null;
  email: string | null;
  website: string | null;
  venue: string | null;
} | null): MspValues {
  return {
    mspName: identity?.name ?? "the Service Provider",
    mspLegalName: identity?.legalName ?? null,
    mspAddress: identity?.address ?? null,
    mspOwnerName: identity?.ownerName ?? null,
    mspEmail: identity?.email ?? null,
    mspWebsite: identity?.website ?? null,
    venue: identity?.venue ?? null,
  };
}

/** Free-text intro/footer settings → trimmed, non-empty lines. */
export function textLines(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Footer: MSP name + address lines, then the operator's custom lines. */
export function buildFooterLines(msp: MspValues, footerText: string | null): string[] {
  const lines: string[] = [];
  if (msp.mspName && msp.mspName !== "the Service Provider") lines.push(msp.mspName);
  if (msp.mspAddress) lines.push(msp.mspAddress);
  lines.push(...textLines(footerText));
  return lines;
}

/**
 * Assembly from already-read rows. `baseUrl` is the absolute origin the
 * links must point at: passed IN rather than read from env, because the
 * frame knows something the env does not — the request's own host. Every
 * link in the frame is followed from somebody else's website, so it has to
 * point at the host the visitor's browser actually reached us on.
 */
export function assembleEmbedData(
  baseUrl: string,
  published: PublishedDocument[],
  settings: ResolvedLegalSettings,
  msp: MspValues,
): EmbedData {
  const base = baseUrl.replace(/\/+$/, "");
  const fmt = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

  const docs: EmbedDoc[] = published.map(({ doc, current, history }) => ({
    slug: doc.slug,
    title: doc.title,
    // TWO steps, and the order is the whole guarantee: substitute FIRST in
    // "public" mode, then render the resulting markdown to HTML. Rendering
    // first and substituting into HTML would mean an MSP value containing
    // "<" lands inside markup the renderer already escaped — an injection
    // point created by doing the same two operations in the other order.
    body: renderEmbedBody(
      renderLegalBody(current.bodyMarkdown, "public", msp, parseVersionDefaults(current.variablesJson)),
    ),
    current: {
      version: current.version,
      effective: fmt(current.publishedAt),
      anchor: `${doc.slug}-v${current.version}`,
      href: `${base}/legal/${doc.slug}`,
    },
    // "History" is every published version EXCEPT the one on display. The
    // current one is already rendered in full above it, so repeating it in
    // the list would read as two different versions being in force.
    history: history.map((v) => ({
      version: v.version,
      effective: fmt(v.publishedAt),
      anchor: `${doc.slug}-v${v.version}`,
      href: `${base}/legal/${doc.slug}/${v.version}`,
    })),
  }));

  return {
    docs,
    introParagraphs: textLines(settings.introText),
    footerLines: buildFooterLines(msp, settings.footerText),
    accentColor: settings.accentColor,
    indexHref: `${base}/legal`,
    embedEnabled: settings.embedEnabled,
    embedOrigins: settings.embedOrigins,
  };
}
