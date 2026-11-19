import "server-only";

import { prisma } from "@/lib/db";
import { legalSettings } from "./settings";
import { publishedDocuments } from "./documents";
import { assembleEmbedData, mspValuesFrom, type EmbedData } from "./embedAssemble";

// The LIVE read behind the embed frame (SHA-2957): settings + identity +
// published documents, assembled by the pure half in ./embedAssemble.ts
// (which is where the invariants live and where the tests point).

export type { EmbedData };

export async function embedData(baseUrl: string): Promise<EmbedData> {
  const [settings, identity, published] = await Promise.all([
    legalSettings(),
    prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } }),
    publishedDocuments(),
  ]);
  return assembleEmbedData(baseUrl, published, settings, mspValuesFrom(identity));
}
