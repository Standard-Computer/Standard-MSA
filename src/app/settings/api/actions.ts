"use server";

// Settings → API server actions (SHA-2960). Key creation returns its result
// to the client component instead of redirecting: the plaintext is shown
// exactly once, and a secret must never ride in a URL where history and
// access logs would keep it.

import { redirect } from "next/navigation";
import { createApiKey, isApiScope, revokeApiKey, type ApiScope } from "@/lib/api/keys";
import { requireOperator } from "@/lib/auth/page";

// AUTH (SHA-3047): every action here calls requireOperator() first. A server
// action is a POST endpoint on its page's path, so gating the screen alone
// would leave key minting and revocation reachable by anyone who can derive
// an action id — and this repo is public, so that build is reproducible.

export type CreateKeyState =
  | { status: "idle" }
  | { status: "error"; error: string }
  | { status: "created"; name: string; plaintext: string };

export async function createApiKeyAction(
  _prev: CreateKeyState,
  formData: FormData,
): Promise<CreateKeyState> {
  await requireOperator("/settings/api");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { status: "error", error: "Name the integration this key is for." };
  const scopes = formData.getAll("scopes").map(String).filter(isApiScope) as ApiScope[];
  const { plaintext, record } = await createApiKey(name, scopes);
  return { status: "created", name: record.name, plaintext };
}

export async function revokeApiKeyAction(formData: FormData): Promise<void> {
  await requireOperator("/settings/api");
  const id = Number(String(formData.get("id") ?? ""));
  const ok = Number.isInteger(id) && id > 0 && (await revokeApiKey(id));
  const msg = ok ? "Key revoked. Requests with it now fail." : "That key is already revoked or unknown.";
  redirect(`/settings/api?ok=${ok ? "1" : "0"}&msg=${encodeURIComponent(msg)}`);
}
