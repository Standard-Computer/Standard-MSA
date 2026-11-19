"use client";

// The recipient's accept/decline panel and read timer (SHA-2959).
//
// The timer only accrues while the tab is actually VISIBLE, which is what
// makes read-time evidence worth keeping: a contract left open in a
// background tab overnight did not get read overnight, and recording that it
// did would be evidence of nothing.

import { useEffect, useRef, useState } from "react";

import { SEND_PING_SECONDS, SEND_VIEW_API_PATH } from "@/lib/sends/constants";

function useReadTimer(token: string): void {
  // Refs, not state: the interval must not re-subscribe on every tick.
  const accrued = useRef(0);
  const lastTick = useRef<number | null>(null);

  useEffect(() => {
    const flush = () => {
      const seconds = Math.floor(accrued.current);
      if (seconds <= 0) return;
      accrued.current -= seconds;
      void fetch(SEND_VIEW_API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, seconds }),
        keepalive: true,
      }).catch(() => {});
    };

    const tick = () => {
      const now = Date.now();
      if (document.visibilityState === "visible") {
        if (lastTick.current !== null) accrued.current += (now - lastTick.current) / 1000;
        lastTick.current = now;
      } else {
        lastTick.current = null;
      }
    };

    lastTick.current = document.visibilityState === "visible" ? Date.now() : null;
    const ticker = window.setInterval(tick, 1000);
    const flusher = window.setInterval(flush, SEND_PING_SECONDS * 1000);

    const onVisibility = () => {
      tick();
      // Flush on the way out: a reader who closes the tab still read it.
      if (document.visibilityState !== "visible") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(ticker);
      window.clearInterval(flusher);
      document.removeEventListener("visibilitychange", onVisibility);
      tick();
      flush();
    };
  }, [token]);
}

export function AcceptPanel({
  token,
  documentTitle,
  acceptAction,
  declineAction,
}: {
  token: string;
  documentTitle: string;
  acceptAction: (formData: FormData) => void;
  declineAction: (formData: FormData) => void;
}) {
  useReadTimer(token);

  const [name, setName] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [declining, setDeclining] = useState(false);
  const canAccept = name.trim() !== "" && agreed;

  return (
    <section className="mt-10 rounded-lg border-2 border-slate-300 p-5">
      <h2 className="text-lg font-semibold">Accept this {documentTitle}</h2>
      <p className="mt-1 text-sm text-slate-600">
        Typing your name below and accepting creates a binding electronic signature. We
        record the time, your IP address and your browser as evidence of acceptance.
      </p>

      <form action={acceptAction} className="mt-4 space-y-3 text-sm">
        <input type="hidden" name="token" value={token} />
        <label className="block">
          Your full name
          <input
            name="acceptorName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            className="mt-1 block w-full rounded border border-slate-300 p-2"
            placeholder="Type your full legal name"
          />
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1"
          />
          <span>
            I have read the {documentTitle} above and I agree to it on behalf of the Client.
          </span>
        </label>
        <button
          type="submit"
          disabled={!canAccept}
          className="rounded bg-slate-900 px-5 py-2.5 text-white disabled:bg-slate-400"
        >
          Accept and sign
        </button>
      </form>

      <div className="mt-5 border-t border-slate-200 pt-4 text-sm">
        {declining ? (
          <form action={declineAction} className="space-y-2">
            <input type="hidden" name="token" value={token} />
            <label className="block">
              Decline this agreement — a reason helps, but is optional
              <input
                name="reason"
                className="mt-1 block w-full rounded border border-slate-300 p-2"
                placeholder="Not proceeding at this time"
              />
            </label>
            <div className="flex gap-2">
              <button type="submit" className="rounded border border-amber-400 px-3 py-1.5 text-amber-800">
                Confirm decline
              </button>
              <button
                type="button"
                onClick={() => setDeclining(false)}
                className="rounded border border-slate-300 px-3 py-1.5"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setDeclining(true)}
            className="text-slate-600 underline"
          >
            I do not want to accept this
          </button>
        )}
      </div>
    </section>
  );
}
