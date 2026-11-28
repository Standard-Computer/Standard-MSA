import Link from "next/link";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { DEFAULT_LEGAL_INTRO, resolveIntroParagraphs } from "@/lib/legal/intro";
import { mspValuesFrom } from "@/lib/legal/embedAssemble";
import {
  embedIframeSnippet,
  embedScriptSnippet,
  parseEmbedOrigins,
} from "@/lib/legal/embed";
import { legalSettings, updateLegalSettings } from "@/lib/legal/settings";
import { getAlertSender } from "@/lib/liveness/delivery";
import { CopyButton } from "@/components/legal/CopyButton";
import { requireOperator } from "@/lib/auth/page";

// Operator screen: the snippet generator + embed/monitor settings
// (SHA-2957). Server-rendered with a server action — no client state beyond
// the copy buttons.
//
// AUTH: behind the operator gate (SHA-3047). The snippet itself is public by
// design, but the settings here control a public surface — the embed origin
// allow-list and the visit retention window — so a stranger must not reach
// the form that changes them.
export const dynamic = "force-dynamic";

async function saveSettings(formData: FormData) {
  "use server";
  // A server action is a POST endpoint on this page's path; gating only the
  // render would leave the write reachable (SHA-3047).
  await requireOperator("/embed");
  const originsRaw = String(formData.get("embedOrigins") ?? "");
  const retentionRaw = Number.parseInt(String(formData.get("visitRetentionDays") ?? ""), 10);
  await updateLegalSettings({
    embedEnabled: formData.get("embedEnabled") === "on",
    embedOriginsJson: JSON.stringify(parseEmbedOrigins(originsRaw)),
    introText: String(formData.get("introText") ?? "").trim() || null,
    footerText: String(formData.get("footerText") ?? "").trim() || null,
    visitRetentionDays: Number.isInteger(retentionRaw) && retentionRaw >= 1 ? retentionRaw : 365,
    hashVisitorIps: formData.get("hashVisitorIps") === "on",
    monitorEnabled: formData.get("monitorEnabled") === "on",
    monitorUrl: String(formData.get("monitorUrl") ?? "").trim() || null,
  });
  revalidatePath("/embed");
}

async function requestBaseUrl(): Promise<string> {
  // The snippet must name the host the operator is actually using, which the
  // request knows and the env may not.
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host) return `${proto}://${host}`;
  return process.env.APP_BASE_URL || "http://localhost:3000";
}

export default async function EmbedAdminPage() {
  await requireOperator("/embed");
  const [settings, monitor, sender, identity, baseUrl] = await Promise.all([
    legalSettings(),
    prisma.monitorState.findFirst({ orderBy: { id: "asc" } }),
    getAlertSender(),
    prisma.mspIdentity.findFirst({ orderBy: { id: "asc" } }),
    requestBaseUrl(),
  ]);

  const scriptSnippet = embedScriptSnippet({ baseUrl });
  const iframeSnippet = embedIframeSnippet({ baseUrl });
  // The same resolver the public page and the embed use, so the preview
  // cannot claim something the visitor will not see.
  const introPreview = resolveIntroParagraphs(settings.introText, mspValuesFrom(identity));

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold">Legal embed</h1>
      <p className="mt-2 text-sm text-slate-600">
        Paste one of these on your website&apos;s <code>/legal</code> page. The script variant
        auto-sizes and inherits your site&apos;s fonts; the iframe variant is for site builders
        that strip scripts. Both render the same content and update automatically when you
        publish a new version.
      </p>

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Script embed (recommended)</h2>
          <CopyButton text={scriptSnippet} />
        </div>
        <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
          {scriptSnippet}
        </pre>
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Iframe fallback</h2>
          <CopyButton text={iframeSnippet} />
        </div>
        <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100">
          {iframeSnippet}
        </pre>
      </section>

      <section className="mt-8">
        <h2 className="font-semibold">Liveness monitor</h2>
        <p className="mt-1 text-sm text-slate-600">
          Status:{" "}
          <b>
            {monitor?.status ?? "never checked"}
          </b>
          {monitor?.lastCheckedAt ? ` · last check ${monitor.lastCheckedAt.toISOString()}` : ""}
          {monitor?.lastDetail ? ` · ${monitor.lastDetail}` : ""}
        </p>
        {settings.monitorEnabled && sender === null && (
          <p className="mt-1 text-sm text-amber-700">
            Email is not configured yet — outages are recorded here but no alert email can be
            sent until a delivery provider is set up.
          </p>
        )}
        {settings.monitorEnabled && !identity?.email && (
          <p className="mt-1 text-sm text-amber-700">
            No notification address: set your email in MSP identity settings to receive
            alerts.
          </p>
        )}
      </section>

      <form action={saveSettings} className="mt-8 space-y-4">
        <h2 className="font-semibold">Settings</h2>
        <label className="block text-sm">
          <input type="checkbox" name="embedEnabled" defaultChecked={settings.embedEnabled} />{" "}
          Embed enabled (off serves a blank frame, never an error, so your site shows an empty
          space instead of breaking)
        </label>
        <label className="block text-sm">
          Allowed embedding websites (one per line; empty = any — the content is public either
          way, this only prevents other sites framing it as theirs)
          <textarea
            name="embedOrigins"
            rows={3}
            defaultValue={settings.embedOrigins.join("\n")}
            className="mt-1 w-full rounded border border-slate-300 p-2 font-mono text-xs"
          />
        </label>
        <label className="block text-sm">
          Intro text — shown above the agreements on BOTH your public{" "}
          <code>/legal</code> page and the website embed (one paragraph per line; blank
          lines ignored)
          <textarea
            name="introText"
            rows={8}
            // When nothing is saved, the box is PREFILLED with the shipped
            // default rather than left empty, so the operator can see and
            // edit exactly what the public page is showing (GH #33 §5).
            // Saving it back unchanged stores the same text the fallback
            // would have produced, so the page does not change.
            defaultValue={settings.introText ?? DEFAULT_LEGAL_INTRO}
            className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
          />
          <span className="mt-1 block text-xs text-slate-500">
            Clear this field and save to restore the default text above. Variables are
            filled from MSP identity when the page is rendered, so they stay current:{" "}
            <code>{"{{msp_name}}"}</code>, <code>{"{{msp_legal_name}}"}</code>,{" "}
            <code>{"{{msp_phone}}"}</code>, <code>{"{{msp_email}}"}</code>,{" "}
            <code>{"{{msp_address}}"}</code>, <code>{"{{msp_website}}"}</code>,{" "}
            <code>{"{{msp_owner_name}}"}</code>, <code>{"{{venue}}"}</code> — the same MSP
            variables you can use in an agreement body. Set these on{" "}
            <Link href="/settings/identity" className="text-blue-700">
              MSP identity
            </Link>
            . With no phone saved, <code>{"{{msp_phone}}"}</code> falls back to your
            notification email, and if that is blank too the sentence it sits in ends
            early rather than showing a gap.
          </span>
        </label>
        <label className="block text-sm">
          Footer text (optional, one line per line) — the same variables work here
          <textarea
            name="footerText"
            rows={2}
            defaultValue={settings.footerText ?? ""}
            className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
          />
        </label>
        <section className="rounded border border-slate-200 bg-slate-50 p-3">
          <h3 className="text-sm font-semibold">Intro preview (as the public page renders it)</h3>
          <div className="mt-2 space-y-2 text-sm text-slate-700">
            {introPreview.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Resolved from your saved intro and current MSP identity. Reflects the last save,
            not what is typed above.
          </p>
        </section>
        <label className="block text-sm">
          Visit retention (days) — older visit rows are purged by the scheduled job
          <input
            type="number"
            name="visitRetentionDays"
            min={1}
            defaultValue={settings.visitRetentionDays}
            className="mt-1 w-32 rounded border border-slate-300 p-2 text-sm"
          />
        </label>
        <label className="block text-sm">
          <input type="checkbox" name="hashVisitorIps" defaultChecked={settings.hashVisitorIps} />{" "}
          Store a salted hash instead of visitor IP addresses (see README § Visitor log for the
          privacy trade-offs)
        </label>
        <label className="block text-sm">
          <input type="checkbox" name="monitorEnabled" defaultChecked={settings.monitorEnabled} />{" "}
          Monitor my website&apos;s legal page
        </label>
        <label className="block text-sm">
          Page to monitor (your website&apos;s /legal URL)
          <input
            type="url"
            name="monitorUrl"
            placeholder="https://www.example.com/legal"
            defaultValue={settings.monitorUrl ?? ""}
            className="mt-1 w-full rounded border border-slate-300 p-2 text-sm"
          />
        </label>
        <button type="submit" className="rounded bg-blue-700 px-4 py-2 text-sm text-white">
          Save
        </button>
      </form>
    </main>
  );
}
