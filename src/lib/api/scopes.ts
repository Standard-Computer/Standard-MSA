// API scope vocabulary (SHA-2960). PURE — the key-creation form imports
// this client-side, so it must stay free of node and database imports.

/** Scopes an MSP can grant a key. An empty scope list on the row = all. */
export const API_SCOPES = [
  "contacts:read",
  "contacts:write",
  "sends:read",
  "sends:write",
  "documents:read",
  "documents:publish",
  "stats:read",
  "webhooks:manage",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(raw: unknown): raw is ApiScope {
  return typeof raw === "string" && (API_SCOPES as readonly string[]).includes(raw);
}
