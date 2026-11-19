import { notFound } from "next/navigation";

import { AcceptPanel } from "@/components/sends/AcceptPanel";
import { embedCss } from "@/lib/legal/embedDocument";
import { legalSettings } from "@/lib/legal/settings";
import { renderSendDocument } from "@/lib/sends/render";
import { sendByToken } from "@/lib/sends/sends";
import { isSendTokenShape } from "@/lib/sends/tokens";
import { acceptAction, declineAction } from "./actions";

// The recipient's own copy of one agreement (SHA-2959).
//
// The token is the whole authorisation — no login, deliberately, because
// making a prospect create an account before reading the MSA is how the MSA
// does not get signed. An unknown token is a plain 404: confirming that a
// token exists but belongs to someone else would be worse than useless.
export const dynamic = "force-dynamic";

export default async function RecipientMsaPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ ok?: string; msg?: string }>;
}) {
  const { token } = await params;
  const { ok, msg } = await searchParams;
  if (!isSendTokenShape(token)) notFound();

  const send = await sendByToken(token);
  if (!send) notFound();

  const [rendered, settings] = await Promise.all([renderSendDocument(send), legalSettings()]);
  const accepted = send.acceptance !== null;
  const declined = !accepted && send.status === "declined";

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      {/* The same sm-l-* stylesheet the public /legal pages and the embed use,
          so the recipient's copy and the public copy look identical. */}
      <style dangerouslySetInnerHTML={{ __html: embedCss(settings.accentColor) }} />

      {msg ? (
        <div
          className={`mb-6 rounded-lg border p-3 text-sm ${
            ok === "1" ? "border-green-300 bg-green-50" : "border-red-300 bg-red-50"
          }`}
        >
          {msg}
        </div>
      ) : null}

      <h1 className="text-2xl font-bold">{rendered.title}</h1>
      <p className="mt-1 text-sm text-slate-500">
        v{rendered.version} · prepared for{" "}
        {send.recipient.fullName ?? send.recipient.companyName ?? send.recipient.email}
      </p>

      {accepted ? (
        <div className="mt-4 rounded-lg border border-green-300 bg-green-50 p-4 text-sm">
          <p className="font-medium text-green-900">
            Accepted on{" "}
            {send.acceptance?.acceptedAt.toISOString().replace("T", " ").slice(0, 19)} UTC
            {send.acceptance?.acceptorName ? ` by ${send.acceptance.acceptorName}` : ""}.
          </p>
          <p className="mt-1 text-green-900">
            This page is your copy of what you agreed to. It will not change.
          </p>
        </div>
      ) : null}

      {declined ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          You declined this agreement. If that was a mistake, you can still accept it below.
        </div>
      ) : null}

      <div dangerouslySetInnerHTML={{ __html: rendered.html }} />

      {accepted ? null : (
        <AcceptPanel
          token={send.token}
          documentTitle={rendered.title}
          acceptAction={acceptAction}
          declineAction={declineAction}
        />
      )}

      <p className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-500">
        This link is unique to you. Please do not forward it — anyone holding it can read and
        accept this agreement on your behalf.
      </p>
    </main>
  );
}
