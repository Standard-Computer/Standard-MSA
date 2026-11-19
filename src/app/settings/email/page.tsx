// Settings → Email (SHA-2958). Shows provider choice, non-secret settings,
// key PRESENCE (never values), capability honesty for the chosen provider,
// the send-test-email action, and the recent delivery log.

import { prisma } from "@/lib/db";
import { getEmailConfig } from "@/lib/email/config";
import { describeSecret } from "@/lib/email/redact";
import { getProvider, listProviders } from "@/lib/email/registry";
import { saveEmailSettings, sendTestEmailAction } from "./actions";
import { requireOperator } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; msg?: string }>;
}) {
  const { ok, msg } = await searchParams;
  await requireOperator("/settings/email");
  const state = await getEmailConfig();
  const activeRow = await prisma.emailProviderConfig.findFirst({
    where: { active: true },
    orderBy: { id: "desc" },
  });
  const recent = await prisma.emailOutbound.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  const provider = state.configured ? getProvider(state.config.provider) : undefined;

  let rowSettings: Record<string, unknown> = {};
  if (activeRow) {
    try {
      rowSettings = JSON.parse(activeRow.settingsJson) as Record<string, unknown>;
    } catch {
      rowSettings = {};
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold">Email delivery</h1>
      <p className="mt-2 text-slate-600">
        Provider keys are read from the environment only — they are never stored in the
        database or shown here.
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
        <h2 className="font-medium">Status</h2>
        {state.configured ? (
          <div className="mt-2 text-sm text-slate-700">
            <p>
              Configured: <strong>{provider?.label}</strong>, sending as{" "}
              <strong>{state.config.fromAddress}</strong>.
            </p>
            {provider && !provider.capabilities.bounces ? (
              <p className="mt-1 text-amber-700">
                This provider has no webhooks: bounces and complaints will not be recorded.
                Opens and clicks still track through this instance.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-amber-700">Not configured: {state.reason}</p>
        )}
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-slate-600">
          <dt>SMTP2GO_API_KEY</dt>
          <dd>{describeSecret(process.env.SMTP2GO_API_KEY)}</dd>
          <dt>SENDGRID_API_KEY</dt>
          <dd>{describeSecret(process.env.SENDGRID_API_KEY)}</dd>
          <dt>SMTP_PASSWORD</dt>
          <dd>{describeSecret(process.env.SMTP_PASSWORD)}</dd>
          <dt>EMAIL_WEBHOOK_SECRET</dt>
          <dd>{describeSecret(process.env.EMAIL_WEBHOOK_SECRET)}</dd>
        </dl>
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium">Provider settings (non-secret)</h2>
        <form action={saveEmailSettings} className="mt-3 space-y-3 text-sm">
          <label className="block">
            Provider
            <select
              name="provider"
              defaultValue={activeRow?.provider ?? "smtp2go"}
              className="mt-1 block w-full rounded border border-slate-300 p-2"
            >
              {listProviders().map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            From address
            <input
              name="fromAddress"
              type="email"
              defaultValue={activeRow?.fromAddress ?? ""}
              placeholder="msa@your-msp.example"
              className="mt-1 block w-full rounded border border-slate-300 p-2"
            />
          </label>
          <fieldset className="rounded border border-slate-200 p-3">
            <legend className="px-1 text-slate-500">SMTP only</legend>
            <label className="block">
              Host
              <input
                name="smtpHost"
                defaultValue={typeof rowSettings.smtpHost === "string" ? rowSettings.smtpHost : ""}
                className="mt-1 block w-full rounded border border-slate-300 p-2"
              />
            </label>
            <div className="mt-2 flex gap-4">
              <label className="block flex-1">
                Port
                <input
                  name="smtpPort"
                  defaultValue={typeof rowSettings.smtpPort === "number" ? String(rowSettings.smtpPort) : "587"}
                  className="mt-1 block w-full rounded border border-slate-300 p-2"
                />
              </label>
              <label className="block flex-1">
                Username
                <input
                  name="smtpUsername"
                  defaultValue={typeof rowSettings.smtpUsername === "string" ? rowSettings.smtpUsername : ""}
                  className="mt-1 block w-full rounded border border-slate-300 p-2"
                />
              </label>
            </div>
            <label className="mt-2 block">
              <input
                name="smtpSecure"
                type="checkbox"
                defaultChecked={rowSettings.smtpSecure === true}
                className="mr-2"
              />
              Implicit TLS (port 465)
            </label>
            <p className="mt-2 text-slate-500">
              The SMTP password comes from <code>SMTP_PASSWORD</code> in the environment.
            </p>
          </fieldset>
          <button type="submit" className="rounded bg-slate-900 px-4 py-2 text-white">
            Save settings
          </button>
        </form>
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium">Send test email</h2>
        <p className="mt-1 text-sm text-slate-600">
          Proves the configured provider works before anything relies on it.
        </p>
        <form action={sendTestEmailAction} className="mt-3 flex gap-3 text-sm">
          <input
            name="to"
            type="email"
            placeholder="you@your-msp.example"
            className="flex-1 rounded border border-slate-300 p-2"
          />
          <button type="submit" className="rounded bg-slate-900 px-4 py-2 text-white">
            Send test
          </button>
        </form>
      </section>

      <section className="mt-6 rounded-lg border border-slate-200 p-4">
        <h2 className="font-medium">Recent outbound</h2>
        {recent.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">Nothing sent yet.</p>
        ) : (
          <table className="mt-2 w-full text-left text-sm">
            <thead>
              <tr className="text-slate-500">
                <th className="py-1 pr-3">To</th>
                <th className="py-1 pr-3">Subject</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">Attempts</th>
                <th className="py-1">Last error</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row) => (
                <tr key={row.id} className="border-t border-slate-100 align-top">
                  <td className="py-1 pr-3">{row.toAddress}</td>
                  <td className="py-1 pr-3">{row.subject}</td>
                  <td className="py-1 pr-3">{row.status}</td>
                  <td className="py-1 pr-3">{row.attempts}</td>
                  <td className="py-1 text-slate-600">{row.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
