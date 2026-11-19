// Settings → API (SHA-2960): create and revoke API keys, see per-key usage,
// and find the spec. Keys exist only as hashes; there is nothing here that
// can re-show one.

import { keyScopes } from "@/lib/api/keys";
import { webhookEvents } from "@/lib/api/serializers";
import { prisma } from "@/lib/db";
import { requireOperator } from "@/lib/auth/page";
import { revokeApiKeyAction } from "./actions";
import CreateKeyForm from "./CreateKeyForm";

export const dynamic = "force-dynamic";

export default async function ApiSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; msg?: string }>;
}) {
  await requireOperator("/settings/api");
  const { ok, msg } = await searchParams;
  const keys = await prisma.apiKey.findMany({
    orderBy: { id: "asc" },
    include: { _count: { select: { requests: true } } },
  });
  const webhooks = await prisma.webhook.findMany({ orderBy: { id: "asc" } });

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold">API access</h1>
      <p className="mt-2 text-slate-600">
        Keys for PSA and AI integrations against <code>/api/v1</code>. The OpenAPI spec is at{" "}
        <a href="/api/v1/openapi.json" className="underline">
          /api/v1/openapi.json
        </a>
        ; usage notes in <code>docs/API.md</code>. No key ships with the product — every key
        is created here, by you.
      </p>

      {msg ? (
        <div
          className={`mt-4 rounded-lg border p-3 text-sm ${
            ok === "1" ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"
          }`}
        >
          {msg}
        </div>
      ) : null}

      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium">Create a key</h2>
        <CreateKeyForm />
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium">Keys</h2>
        {keys.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">
            No keys yet — the API rejects every request until one exists.
          </p>
        ) : (
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 pr-3">Name</th>
                <th className="py-1 pr-3">Key</th>
                <th className="py-1 pr-3">Scopes</th>
                <th className="py-1 pr-3">Requests</th>
                <th className="py-1 pr-3">Last used</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} className="border-t border-slate-100 align-top">
                  <td className="py-2 pr-3">{key.name}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{key.prefix || "smsa_…"}</td>
                  <td className="py-2 pr-3 text-xs">{keyScopes(key).join(", ")}</td>
                  <td className="py-2 pr-3">{key._count.requests}</td>
                  <td className="py-2 pr-3">
                    {key.lastUsedAt ? key.lastUsedAt.toISOString().slice(0, 16).replace("T", " ") : "never"}
                  </td>
                  <td className="py-2 text-right">
                    {key.revokedAt ? (
                      <span className="text-slate-400">revoked</span>
                    ) : (
                      <form action={revokeApiKeyAction}>
                        <input type="hidden" name="id" value={key.id} />
                        <button className="text-red-700 hover:underline">Revoke</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium">Webhook subscriptions</h2>
        <p className="mt-2 text-sm text-slate-600">
          Managed by integrations through the API (<code>POST /api/v1/webhooks</code>); listed
          here for visibility.
        </p>
        {webhooks.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">None.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {webhooks.map((hook) => (
              <li key={hook.id} className="font-mono text-xs">
                {hook.url}{" "}
                <span className="text-slate-500">
                  ({hook.revokedAt ? "revoked" : webhookEvents(hook).join(", ") || "all events"})
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
