// The /setup SCREEN's own gate, against a real database (SHA-4474).
//
// tests/auth/setup-db.test.ts holds the LIBRARY refusal: claimOperatorPassword()
// cannot claim an instance that is already claimed, env-configured or closed.
// That is the privilege boundary, and it is why nothing here is a security
// defect. What nothing held was the screen in front of it:
//
//   const unclaimed = await requireUnclaimed();
//   if (!unclaimed) redirect("/login");
//
// Deleting those lines left 373/373 green. The cost of losing them is a trust
// defect rather than a privilege one: a claimed or env-configured instance
// would render the first-boot claim form — a state disclosure plus a password
// prompt that cannot be honoured — to any anonymous visitor who guesses the
// path. On a public template deploy (SHA-4455) that is an alarming thing to
// serve, so it gets an assertion.
//
// Asserted by CALLING the page component against a real migrated database,
// not by matching its source: a regex over src/app/setup/page.tsx is exactly
// the kind of guardrail SHA-4458 and SHA-4469 both caught being insufficient.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbDir = mkdtempSync(join(tmpdir(), "sha4474-setup-screen-"));
process.env.DATABASE_URL = `file:${join(dbDir, "test.db")}`;
process.env.APP_BASE_URL = "https://msa.example.com";
// Unset deliberately, then set per test: the screen behaves differently for
// each of the four gate states and this file asserts all four.
delete process.env.OPERATOR_PASSWORD;
execSync("npx prisma migrate deploy", { stdio: "pipe", env: process.env });

// `next/navigation` resolves to its CLIENT build, which builds a React
// context at import time — and under `--conditions=react-server` (the
// condition `npm test` runs, and the one a server component really loads
// under) `react` has no createContext. Next's own bundler solves this by
// aliasing the specifier to `navigation.react-server` for server code; this
// is that same alias, applied through the module cache so the page's own
// `import { redirect } from "next/navigation"` picks it up.
//
// The point of doing it this way rather than with a hand-written stub: the
// `redirect` the page calls below is Next's real one, re-exported unchanged
// from `next/dist/client/components/redirect` by both builds. The assertions
// are about Next's behaviour, not about a fake's.
const req = createRequire(join(process.cwd(), "package.json"));
const NAVIGATION = req.resolve("next/navigation");
const alias = new Module(NAVIGATION, undefined);
alias.filename = NAVIGATION;
alias.loaded = true;
alias.exports = req(req.resolve("next/dist/client/components/navigation.react-server"));
req.cache[NAVIGATION] = alias;

/** Next's public "is this my own control-flow error?" check. */
const unstableRethrow = alias.exports.unstable_rethrow as (error: unknown) => void;

const PASSWORD = "the-first-operator-password";
const ENV_PASSWORD = "an-env-operator-password";

// Imported dynamically so the modules initialise after DATABASE_URL is set,
// and after the alias above is in place.
let setupPage: typeof import("../../src/app/setup/page");
let setupActions: typeof import("../../src/app/setup/actions");
let credential: typeof import("../../src/lib/auth/credential");
let gate: typeof import("../../src/lib/auth/gate");
let config: typeof import("../../src/lib/auth/config");
let prisma: typeof import("../../src/lib/db").prisma;

before(async () => {
  setupPage = await import("../../src/app/setup/page");
  setupActions = await import("../../src/app/setup/actions");
  credential = await import("../../src/lib/auth/credential");
  gate = await import("../../src/lib/auth/gate");
  config = await import("../../src/lib/auth/config");
  prisma = (await import("../../src/lib/db")).prisma;
});

after(async () => {
  await prisma.$disconnect();
  rmSync(dbDir, { recursive: true, force: true });
});

/** Render the screen the way Next does: call it, with searchParams resolved. */
function render(error?: string): Promise<React.ReactNode> {
  return setupPage.default({ searchParams: Promise.resolve({ error }) });
}

interface Element {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

/** Every element in a rendered tree, outermost first. */
function* elements(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const candidate = node as { type?: unknown; props?: unknown };
  if (typeof candidate.props !== "object" || candidate.props === null) return;
  const props = candidate.props as Record<string, unknown>;
  yield { type: candidate.type, props };
  yield* elements(props.children);
}

/**
 * The destination of a thrown Next redirect, or null if this is not one.
 *
 * Next encodes a redirect as a thrown error whose digest is
 * `NEXT_REDIRECT;<kind>;<url>;<status>;`. Parsed here rather than imported
 * because the extractor is not public API — and cross-checked against
 * Next's own `unstable_rethrow`, which IS, so a digest-format change in Next
 * shows up as a failure here rather than as a test that quietly stops
 * recognising redirects.
 */
function redirectTarget(thrown: unknown): string | null {
  const digest = (thrown as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string") return null;
  const parts = digest.split(";");
  if (parts[0] !== "NEXT_REDIRECT") return null;
  assert.throws(
    () => unstableRethrow(thrown),
    "Next must recognise this as its own redirect, not just look like one",
  );
  return parts[2] ?? null;
}

/** Call the screen and return where it sent the browser, or null if it rendered. */
async function redirectedTo(): Promise<string | null> {
  try {
    await render();
  } catch (thrown) {
    const target = redirectTarget(thrown);
    assert.ok(target !== null, `the screen threw something that is not a redirect: ${thrown}`);
    return target;
  }
  return null;
}

test("the parser recognises a redirect and nothing else", () => {
  // A negative control for redirectTarget(): without it, "no redirect
  // happened" and "my parser stopped working" look identical below.
  assert.equal(redirectTarget(new Error("an ordinary failure")), null);
  assert.equal(redirectTarget(null), null);
  assert.equal(redirectTarget({ digest: "NEXT_NOT_FOUND" }), null);
  unstableRethrow(new Error("an ordinary failure"));
});

test("an unclaimed instance renders the claim form", async () => {
  await prisma.operatorCredential.deleteMany();
  assert.equal(await gate.requireUnclaimed(), true, "precondition: unclaimed");

  const tree = [...elements(await render())];

  const forms = tree.filter((el) => el.type === "form");
  assert.equal(forms.length, 1, "exactly one form on the screen");
  assert.equal(
    forms[0].props.action,
    setupActions.setupAction,
    "the form must post to the real claim action, not to some other handler",
  );

  const inputs = tree.filter((el) => el.type === "input");
  assert.deepEqual(
    inputs.map((el) => el.props.name),
    ["password", "confirmation"],
    "a password and its confirmation",
  );
  for (const input of inputs) {
    assert.equal(input.props.type, "password", `${String(input.props.name)} is a password field`);
    assert.equal(input.props.required, true);
    assert.equal(input.props.minLength, config.MIN_PASSWORD_LENGTH);
  }

  // No error banner when no `?error=` code arrived, and the right one when it
  // did — the branch that renders a FIXED message per code rather than text
  // from the URL (src/app/setup/page.tsx).
  const banners = (node: unknown): string[] =>
    [...elements(node)]
      .filter((el) => typeof el.props.className === "string" && el.props.className.includes("bg-red-50"))
      .map((el) => String(el.props.children));
  assert.deepEqual(banners(await render()), []);
  assert.deepEqual(banners(await render("mismatch")), ["The two passwords do not match."]);
  assert.deepEqual(banners(await render("whatever-an-attacker-puts-here")), []);
});

test("a claimed instance is redirected to /login and shown no form", async () => {
  await prisma.operatorCredential.deleteMany();
  assert.equal((await credential.claimOperatorPassword(PASSWORD)).claimed, true);
  assert.equal((await gate.operatorGate()).kind, "stored", "precondition: claimed");

  // The whole point: the person who deployed this already claimed it, so a
  // later visitor must not be offered the claim form at all.
  assert.equal(await redirectedTo(), "/login");
});

test("an env-configured instance is redirected to /login", async () => {
  // The state the primary key cannot see: OPERATOR_PASSWORD is set, so the
  // credential table is EMPTY and the screen's only defence is its gate.
  await prisma.operatorCredential.deleteMany();
  process.env.OPERATOR_PASSWORD = ENV_PASSWORD;
  try {
    assert.equal((await gate.operatorGate()).kind, "env", "precondition: env-configured");
    assert.equal(await prisma.operatorCredential.count(), 0, "precondition: nothing stored");
    assert.equal(await redirectedTo(), "/login");
  } finally {
    delete process.env.OPERATOR_PASSWORD;
  }
});

test("a closed instance is redirected to /login, not reopened for claiming", async () => {
  // Fail-closed, the same stance src/lib/auth/gate.ts takes: a present but
  // rejected OPERATOR_PASSWORD is a deliberate misconfiguration, and the one
  // thing it must never do is invite the next passer-by to claim the
  // instance.
  await prisma.operatorCredential.deleteMany();
  process.env.OPERATOR_PASSWORD = "short";
  try {
    assert.equal((await gate.operatorGate()).kind, "closed", "precondition: closed");
    assert.equal(await redirectedTo(), "/login");
  } finally {
    delete process.env.OPERATOR_PASSWORD;
  }
});

test("and first boot reopens once the credential is gone", async () => {
  // The recovery path, asserted on the screen rather than on the library:
  // the redirect above is conditional, not permanent.
  await prisma.operatorCredential.deleteMany();
  assert.equal(await redirectedTo(), null, "the screen renders again");
  assert.equal([...elements(await render())].filter((el) => el.type === "form").length, 1);
});
