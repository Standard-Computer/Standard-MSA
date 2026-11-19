import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIVENESS_FAILURES_BEFORE_DOWN,
  framePresent,
  nextMonitorState,
  probeTarget,
  runLivenessTick,
  snippetPresent,
  type MonitorSnapshot,
} from "../../src/lib/liveness/liveness";
import type { AlertMessage } from "../../src/lib/liveness/delivery";

const FRESH: MonitorSnapshot = {
  status: "unknown",
  consecutiveFailures: 0,
  downSince: null,
  lastAlertAt: null,
  lastRecoveryAt: null,
};

const T = new Date("2026-11-19T00:00:00Z");

test("markers: snippet and frame asserts, not just HTTP 200", () => {
  assert.equal(snippetPresent('<html><div id="sm-legal"></div></html>'), true);
  assert.equal(snippetPresent('<script src="https://x/legal/embed.js"></script>'), true);
  assert.equal(snippetPresent('<iframe src="https://x/legal/embed/frame"></iframe>'), true);
  assert.equal(snippetPresent("<html><h1>Legal</h1><p>call us</p></html>"), false);
  assert.equal(framePresent('<div class="sm-l-root">…</div>'), true);
  assert.equal(framePresent("<html></html>"), false);
});

test("a deliberately broken page emits EXACTLY one alert, then one recovery", () => {
  // Sequence: fail, fail, fail, fail, ok, ok — the acceptance criterion.
  let state = FRESH;
  const actions: (string | null)[] = [];
  for (const ok of [false, false, false, false, true, true]) {
    const r = nextMonitorState(state, ok, T);
    state = r.state;
    actions.push(r.action);
  }
  assert.deepEqual(actions, [null, "alert", null, null, "recover", null]);
  assert.equal(state.status, "up");
});

test("a single timeout never alerts", () => {
  const first = nextMonitorState(FRESH, false, T);
  assert.equal(first.action, null);
  assert.equal(first.state.status, "unknown");
  const healed = nextMonitorState(first.state, true, T);
  assert.equal(healed.action, null); // was never down, so no recovery either
  assert.equal(healed.state.status, "up");
});

test(`down requires ${LIVENESS_FAILURES_BEFORE_DOWN} consecutive failures, reset by success`, () => {
  const f1 = nextMonitorState(FRESH, false, T);
  const okAgain = nextMonitorState(f1.state, true, T);
  assert.equal(okAgain.state.consecutiveFailures, 0);
  const f2 = nextMonitorState(okAgain.state, false, T);
  assert.equal(f2.action, null, "counter restarted — one failure after a success is not down");
});

function fetchStub(bodies: Record<string, { status: number; body: string } | Error>) {
  return async (url: string) => {
    const hit = Object.entries(bodies).find(([k]) => url.startsWith(k))?.[1];
    if (!hit) throw new Error(`no stub for ${url}`);
    if (hit instanceof Error) throw hit;
    return { status: hit.status, text: async () => hit.body };
  };
}

test("runLivenessTick: broken page → alert email to the configured address once", async () => {
  const sent: AlertMessage[] = [];
  const sender = { send: async (m: AlertMessage) => (sent.push(m), { ok: true }) };
  const deps = {
    fetchImpl: fetchStub({
      "https://msp.example/legal": { status: 200, body: "<html>no snippet here</html>" },
      "https://msa.example": { status: 200, body: '<div class="sm-l-root"></div>' },
    }),
    sender,
    alertTo: "ops@standardcomputer.com",
    now: () => T,
  };

  const r1 = await runLivenessTick("https://msp.example/legal", "https://msa.example", FRESH, deps);
  assert.equal(r1.action, null);
  const r2 = await runLivenessTick("https://msp.example/legal", "https://msa.example", r1.state, deps);
  assert.equal(r2.action, "alert");
  assert.equal(r2.emailed, true);
  const r3 = await runLivenessTick("https://msp.example/legal", "https://msa.example", r2.state, deps);
  assert.equal(r3.action, null, "still down — no second alert");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /embed snippet is not present/);

  // Restore the page: one recovery notice.
  const healthy = {
    ...deps,
    fetchImpl: fetchStub({
      "https://msp.example/legal": { status: 200, body: '<div id="sm-legal"></div>' },
      "https://msa.example": { status: 200, body: '<div class="sm-l-root"></div>' },
    }),
  };
  const r4 = await runLivenessTick("https://msp.example/legal", "https://msa.example", r3.state, healthy);
  assert.equal(r4.action, "recover");
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /again/);
});

test("runLivenessTick without a sender records 'email not configured'", async () => {
  const deps = {
    fetchImpl: fetchStub({
      "https://msp.example/legal": new Error("ECONNREFUSED"),
      "https://msa.example": { status: 200, body: '<div class="sm-l-root"></div>' },
    }),
    sender: null,
    alertTo: "ops@standardcomputer.com",
    now: () => T,
  };
  const r1 = await runLivenessTick("https://msp.example/legal", "https://msa.example", FRESH, deps);
  const r2 = await runLivenessTick("https://msp.example/legal", "https://msa.example", r1.state, deps);
  assert.equal(r2.action, "alert");
  assert.equal(r2.emailed, false);
  assert.equal(r2.emailError, "email not configured");
});

test("probeTarget distinguishes unreachable / bad status / missing snippet", async () => {
  const dead = await probeTarget("https://x/legal", fetchStub({ "https://x/legal": new Error("boom") }));
  assert.equal(dead.ok, false);
  assert.match(dead.detail, /unreachable/);
  const e500 = await probeTarget("https://x/legal", fetchStub({ "https://x/legal": { status: 500, body: "" } }));
  assert.equal(e500.ok, false);
  assert.match(e500.detail, /HTTP 500/);
  const missing = await probeTarget(
    "https://x/legal",
    fetchStub({ "https://x/legal": { status: 200, body: "<html></html>" } }),
  );
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /not present/);
});
