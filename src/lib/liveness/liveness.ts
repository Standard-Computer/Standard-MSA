import { EMBED_CONTAINER_ID } from "@/lib/legal/embed";
import type { AlertMessage, AlertSender } from "./delivery";

// The liveness monitor (SHA-2957): is the MSP's own /legal page actually
// showing the embed?
//
// Two asserts, because HTTP 200 proves nothing about a page whose embed div
// was deleted in a site-builder redesign:
//
//   (a) fetch the MSP's page and assert the SNIPPET is present — the
//       container div or a script/iframe pointing at this install's
//       /legal/embed path. A plain fetch cannot execute JavaScript, so
//       "the embed renders" is verified as "the thing that renders it is on
//       the page"; the companion assert covers the rendering half.
//   (b) fetch our OWN /legal/embed/frame and assert the known marker
//       (`sm-l-root`) renders — if our half is broken, the MSP's page shows
//       a blank space no matter what their HTML says.
//
// Debounce is a pure state machine (`nextMonitorState`) so the one behaviour
// the acceptance criteria name — exactly one alert per outage, one recovery
// notice, nothing in between — is a unit test, not a hope. Two consecutive
// failures are required before "down" so a single timeout never pages
// anyone.

export const LIVENESS_FAILURES_BEFORE_DOWN = 2;
export const LIVENESS_TIMEOUT_MS = 15_000;

/** The marker assert for the MSP's page — exported for tests. */
export function snippetPresent(html: string): boolean {
  return (
    html.includes(`id="${EMBED_CONTAINER_ID}"`) ||
    html.includes(`id='${EMBED_CONTAINER_ID}'`) ||
    html.includes("/legal/embed.js") ||
    html.includes("/legal/embed/frame")
  );
}

/** The marker assert for our own frame — exported for tests. */
export function framePresent(html: string): boolean {
  return html.includes('class="sm-l-root"');
}

export type ProbeResult = { ok: boolean; statusCode: number | null; detail: string };

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

async function fetchText(url: string, fetchImpl: FetchLike): Promise<{ status: number | null; body: string; error: string | null }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), LIVENESS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: ac.signal,
      headers: { "User-Agent": "Standard-MSA-liveness/1.0" },
    });
    const body = await res.text();
    return { status: res.status, body, error: null };
  } catch (err) {
    return { status: null, body: "", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the MSP's page: reachable + snippet present. */
export async function probeTarget(url: string, fetchImpl: FetchLike): Promise<ProbeResult> {
  const r = await fetchText(url, fetchImpl);
  if (r.error !== null || r.status === null) {
    return { ok: false, statusCode: null, detail: `unreachable: ${(r.error ?? "no response").slice(0, 200)}` };
  }
  if (r.status < 200 || r.status >= 400) return { ok: false, statusCode: r.status, detail: `HTTP ${r.status}` };
  if (!snippetPresent(r.body)) {
    return { ok: false, statusCode: r.status, detail: "page loads but the embed snippet is not present" };
  }
  return { ok: true, statusCode: r.status, detail: "snippet present" };
}

/** Probe our own frame: renders the marker. */
export async function probeOwnFrame(baseUrl: string, fetchImpl: FetchLike): Promise<ProbeResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}/legal/embed/frame`;
  const r = await fetchText(url, fetchImpl);
  if (r.error !== null || r.status === null) {
    return { ok: false, statusCode: null, detail: `frame unreachable: ${(r.error ?? "no response").slice(0, 200)}` };
  }
  if (r.status !== 200) return { ok: false, statusCode: r.status, detail: `frame HTTP ${r.status}` };
  if (!framePresent(r.body)) return { ok: false, statusCode: r.status, detail: "frame serves but does not render" };
  return { ok: true, statusCode: r.status, detail: "frame renders" };
}

// ── The debounce state machine ───────────────────────────────────────

export type MonitorSnapshot = {
  status: string; // unknown|up|down
  consecutiveFailures: number;
  downSince: Date | null;
  lastAlertAt: Date | null;
  lastRecoveryAt: Date | null;
};

export type MonitorAction = "alert" | "recover" | null;

/**
 * One check result → the next state and the one action it triggers.
 *
 * Rules, pinned by tests:
 *   · ok while up/unknown  → up, counter reset, no action.
 *   · ok while down        → up, ONE "recover" action.
 *   · fail while up/unknown→ counter++; on reaching
 *     LIVENESS_FAILURES_BEFORE_DOWN → down, ONE "alert" action.
 *   · fail while down      → stays down, counter++, NO action — one outage
 *     is one alert, however long it lasts.
 */
export function nextMonitorState(
  prev: MonitorSnapshot,
  probeOk: boolean,
  now: Date,
): { state: MonitorSnapshot; action: MonitorAction } {
  if (probeOk) {
    const wasDown = prev.status === "down";
    return {
      state: {
        status: "up",
        consecutiveFailures: 0,
        downSince: null,
        lastAlertAt: prev.lastAlertAt,
        lastRecoveryAt: wasDown ? now : prev.lastRecoveryAt,
      },
      action: wasDown ? "recover" : null,
    };
  }
  const failures = prev.consecutiveFailures + 1;
  if (prev.status !== "down" && failures >= LIVENESS_FAILURES_BEFORE_DOWN) {
    return {
      state: {
        status: "down",
        consecutiveFailures: failures,
        downSince: now,
        lastAlertAt: now,
        lastRecoveryAt: prev.lastRecoveryAt,
      },
      action: "alert",
    };
  }
  return {
    state: { ...prev, consecutiveFailures: failures },
    action: null,
  };
}

// ── Alert content ─────────────────────────────────────────────────────

export function alertEmail(targetUrl: string, detail: string, to: string): AlertMessage {
  return {
    to,
    kind: "liveness-alert",
    subject: "Your legal page is not showing the embedded agreements",
    text:
      `The scheduled check of ${targetUrl} failed twice in a row.\n\n` +
      `Detail: ${detail}\n\n` +
      `What this means: visitors to your legal page may not be seeing your ` +
      `published agreements. Check that the page is reachable and that the ` +
      `embed snippet is still present (Settings → Legal embed has the code ` +
      `to re-paste).\n\n` +
      `You will get one recovery notice when the page is healthy again.`,
  };
}

export function recoveryEmail(targetUrl: string, to: string): AlertMessage {
  return {
    to,
    kind: "liveness-recovery",
    subject: "Your legal page is showing the embedded agreements again",
    text:
      `The scheduled check of ${targetUrl} is passing again. No action is ` +
      `needed.`,
  };
}

// ── The full check, dependency-injected for tests ─────────────────────

export type LivenessDeps = {
  fetchImpl: FetchLike;
  sender: AlertSender | null;
  alertTo: string | null;
  now: () => Date;
};

export type LivenessRun = {
  probe: ProbeResult;
  action: MonitorAction;
  emailed: boolean;
  emailError: string | null;
  state: MonitorSnapshot;
};

/**
 * One monitor tick against explicit state: probe the MSP page AND our own
 * frame, advance the debounce machine, send the one email the transition
 * calls for (when a sender and an address exist). Pure apart from the
 * injected I/O; the cron route owns persistence.
 */
export async function runLivenessTick(
  targetUrl: string,
  baseUrl: string,
  prev: MonitorSnapshot,
  deps: LivenessDeps,
): Promise<LivenessRun> {
  const [target, own] = await Promise.all([
    probeTarget(targetUrl, deps.fetchImpl),
    probeOwnFrame(baseUrl, deps.fetchImpl),
  ]);
  const probe: ProbeResult = target.ok && own.ok ? target : target.ok ? own : target;
  const { state, action } = nextMonitorState(prev, target.ok && own.ok, deps.now());

  let emailed = false;
  let emailError: string | null = null;
  if (action !== null) {
    if (deps.sender === null || !deps.alertTo) {
      emailError = "email not configured";
    } else {
      const msg =
        action === "alert"
          ? alertEmail(targetUrl, probe.detail, deps.alertTo)
          : recoveryEmail(targetUrl, deps.alertTo);
      const res = await deps.sender.send(msg);
      emailed = res.ok;
      emailError = res.ok ? null : (res.error ?? "send failed");
    }
  }
  return { probe, action, emailed, emailError, state };
}
