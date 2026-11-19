import "server-only";

import type { LegalSettings } from "@prisma/client";
import { prisma } from "@/lib/db";

// The LegalSettings singleton (SHA-2957). Reads never 500 an empty install:
// a missing row resolves to defaults, and the first write creates it.

export type ResolvedLegalSettings = {
  embedEnabled: boolean;
  /** Normalized origins; empty = any (see src/lib/legal/embed.ts). */
  embedOrigins: string[];
  introText: string | null;
  footerText: string | null;
  accentColor: string;
  visitRetentionDays: number;
  hashVisitorIps: boolean;
  monitorEnabled: boolean;
  monitorUrl: string | null;
};

const DEFAULTS: ResolvedLegalSettings = {
  embedEnabled: true,
  embedOrigins: [],
  introText: null,
  footerText: null,
  accentColor: "#1d4ed8",
  visitRetentionDays: 365,
  hashVisitorIps: false,
  monitorEnabled: false,
  monitorUrl: null,
};

function resolve(row: LegalSettings | null): ResolvedLegalSettings {
  if (!row) return DEFAULTS;
  let origins: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.embedOriginsJson);
    if (Array.isArray(parsed)) origins = parsed.filter((o): o is string => typeof o === "string");
  } catch {
    origins = [];
  }
  // The accent lands in a CSS value on somebody else's website; a non-hex
  // stored value falls back to the shipped default rather than reaching CSS.
  const accent = /^#[0-9a-f]{3,8}$/i.test(row.accentColor) ? row.accentColor : DEFAULTS.accentColor;
  return {
    embedEnabled: row.embedEnabled,
    embedOrigins: origins,
    introText: row.introText,
    footerText: row.footerText,
    accentColor: accent,
    visitRetentionDays: Math.max(1, row.visitRetentionDays),
    hashVisitorIps: row.hashVisitorIps,
    monitorEnabled: row.monitorEnabled,
    monitorUrl: row.monitorUrl,
  };
}

export async function legalSettings(): Promise<ResolvedLegalSettings> {
  const row = await prisma.legalSettings.findFirst({ orderBy: { id: "asc" } });
  return resolve(row);
}

export type LegalSettingsPatch = Partial<{
  embedEnabled: boolean;
  embedOriginsJson: string;
  introText: string | null;
  footerText: string | null;
  accentColor: string;
  visitRetentionDays: number;
  hashVisitorIps: boolean;
  monitorEnabled: boolean;
  monitorUrl: string | null;
}>;

export async function updateLegalSettings(patch: LegalSettingsPatch): Promise<void> {
  const row = await prisma.legalSettings.findFirst({ orderBy: { id: "asc" } });
  if (row) {
    await prisma.legalSettings.update({ where: { id: row.id }, data: patch });
  } else {
    await prisma.legalSettings.create({ data: patch });
  }
}
