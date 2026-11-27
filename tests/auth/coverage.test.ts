// The guardrail (SHA-3047).
//
// Finding 4 on PR #7 was not a mistake in a line of code — it was a route
// that shipped without anybody deciding whether it needed auth. So this
// walks src/app, works out the real route table, and fails when:
//
//   1. a route is not matched by any entry in src/lib/auth/surfaces.ts, or
//   2. an operator route does not call the guard, or
//   3. a file holding server actions sits under an operator route without
//      every exported action calling the guard.
//
// Adding a route to this app therefore means classifying it. That is the
// whole point: the next lane cannot reintroduce this bug by omission.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { classifyPath, SURFACES, UNMATCHED } from "../../src/lib/auth/surfaces";
import { findActionSites, findUngradedExports } from "./_actionSplit";

const APP_DIR = path.join(process.cwd(), "src", "app");

// Walking a directory tree means non-literal paths by definition. Every path
// below is built from APP_DIR plus names this repo's own src/app yields —
// nothing here reads request input.
/* eslint-disable security/detect-non-literal-fs-filename */
const listDir = (dir: string): string[] => readdirSync(dir);
const isDir = (full: string): boolean => statSync(full).isDirectory();
const readSource = (full: string): string => readFileSync(full, "utf8");
/* eslint-enable security/detect-non-literal-fs-filename */

interface RouteFile {
  /** The URL path Next derives from the directory, e.g. `/sends/[id]`. */
  readonly route: string;
  /** Repo-relative file path, for a failure message that says where to look. */
  readonly file: string;
  readonly source: string;
}

/** Route groups `(name)` and private folders `_name` are not URL segments. */
function isUrlSegment(dir: string): boolean {
  return !(dir.startsWith("(") && dir.endsWith(")")) && !dir.startsWith("_");
}

function walk(dir: string, segments: string[], out: RouteFile[]): void {
  for (const entry of listDir(dir)) {
    const full = path.join(dir, entry);
    if (isDir(full)) {
      walk(full, isUrlSegment(entry) ? [...segments, entry] : segments, out);
      continue;
    }
    if (entry !== "page.tsx" && entry !== "page.ts" && entry !== "route.ts") continue;
    out.push({
      route: `/${segments.join("/")}`,
      file: path.relative(process.cwd(), full),
      source: readSource(full),
    });
  }
}

/** Every page and route handler in the app, with its URL path. */
function routeFiles(): RouteFile[] {
  const out: RouteFile[] = [];
  walk(APP_DIR, [], out);
  return out;
}

/** Files that declare server actions, with the operator route they sit under. */
function actionFiles(): RouteFile[] {
  const out: RouteFile[] = [];
  const visit = (dir: string, segments: string[]): void => {
    for (const entry of listDir(dir)) {
      const full = path.join(dir, entry);
      if (isDir(full)) {
        visit(full, isUrlSegment(entry) ? [...segments, entry] : segments);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      const source = readSource(full);
      if (!/^\s*["']use server["'];/m.test(source)) continue;
      out.push({ route: `/${segments.join("/")}`, file: path.relative(process.cwd(), full), source });
    }
  };
  visit(APP_DIR, []);
  return out;
}

/**
 * The same source with comments blanked out.
 *
 * Every rule below matches a CALL with a regex, and a regex cannot tell a call
 * from prose about a call. Found the hard way (SHA-4458): the first revision
 * of the public-action rule at the bottom of this file passed with the gate
 * check deleted from src/app/setup/actions.ts, because the comment above that
 * line names `requireUnclaimed()` — parentheses included — and the regex
 * matched the comment. A guardrail a comment can satisfy is not a guardrail.
 *
 * GUARD_CALL has always had the same exposure, so it runs on stripped source
 * too: before this, a file that merely *mentioned* `requireOperator()` in a
 * comment satisfied the operator rules.
 *
 * Quotes and template literals are tracked only so that a `//` or `/*` inside
 * a string is not mistaken for a comment opener — their contents are kept,
 * since a call is a call. Newlines inside block comments are preserved so
 * line numbers in any future message still line up.
 */
function stripComments(source: string): string {
  type Mode = "code" | "line" | "block" | "'" | '"' | "`";
  let mode: Mode = "code";
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const pair = source.slice(i, i + 2);
    if (mode === "code") {
      if (pair === "//") {
        mode = "line";
        i += 2;
        continue;
      }
      if (pair === "/*") {
        mode = "block";
        i += 2;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") mode = char;
      out += char;
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (char === "\n") {
        mode = "code";
        out += char;
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (pair === "*/") {
        mode = "code";
        i += 2;
        continue;
      }
      if (char === "\n") out += char;
      i += 1;
      continue;
    }
    // Inside a string or template: copy through, honouring escapes, and close
    // on the matching quote.
    out += char;
    if (char === "\\" && i + 1 < source.length) {
      out += source[i + 1];
      i += 2;
      continue;
    }
    if (char === mode) mode = "code";
    i += 1;
  }
  return out;
}

test("stripComments removes prose about a call but keeps the call", () => {
  // The stripper is load-bearing for every rule below, so it gets its own
  // assertions rather than being trusted.
  assert.equal(stripComments("// requireOperator()\n").includes("requireOperator"), false);
  assert.equal(stripComments("/* requireOperator() */").includes("requireOperator"), false);
  assert.equal(stripComments("await requireOperator();").includes("requireOperator"), true);
  // A `//` inside a string is not a comment opener.
  assert.equal(
    stripComments('const u = "https://x/y"; await requireOperator();').includes("requireOperator"),
    true,
  );
  // Nor is one inside a template literal, and the literal's own text survives.
  assert.equal(stripComments("`a // b`").includes("a // b"), true);
  // An escaped quote does not end the string early.
  assert.equal(stripComments('const s = "he said \\"// hi\\""; guardOperatorRequest(r);')
    .includes("guardOperatorRequest"), true);
  // Block comments keep their newlines, so line counts are unchanged.
  assert.equal(stripComments("/*\n\n*/x").split("\n").length, 3);
});

const GUARD_CALL = /\b(requireOperator|guardOperatorRequest)\s*\(/;

/** Does this source really CALL `pattern`, as opposed to talking about it? */
function calls(pattern: RegExp, source: string): boolean {
  return pattern.test(stripComments(source));
}

test("the app has routes to check — the walk is not silently empty", () => {
  const routes = routeFiles();
  assert.ok(routes.length >= 15, `expected the real route table, found ${routes.length}`);
  // Spot-check the two routes finding 4 was about, so a broken walk cannot
  // make this whole file vacuously green.
  const paths = routes.map((r) => r.route);
  assert.ok(paths.includes("/sends/[id]"), "walk found /sends/[id]");
  assert.ok(paths.includes("/sends/[id]/evidence"), "walk found /sends/[id]/evidence");
});

test("every route in src/app is classified in surfaces.ts", () => {
  const unclassified = routeFiles().filter(
    (r) => classifyPath(r.route) === UNMATCHED,
  );
  assert.deepEqual(
    unclassified.map((r) => `${r.route} (${r.file})`),
    [],
    "add each of these to SURFACES in src/lib/auth/surfaces.ts — a route nobody " +
      "classified is how the accept token ended up on an unauthenticated page",
  );
});

test("every operator page and route handler calls the guard", () => {
  const unguarded = routeFiles()
    .filter((r) => classifyPath(r.route).kind === "operator")
    .filter((r) => !calls(GUARD_CALL, r.source));
  assert.deepEqual(
    unguarded.map((r) => `${r.route} (${r.file})`),
    [],
    "each of these renders operator data without calling requireOperator() / " +
      "guardOperatorRequest()",
  );
});

test("every server action under an operator route calls the guard", () => {
  // A server action is a POST endpoint on its page's path. Gating the screen
  // and not the action leaves the write reachable.
  const unguarded = actionFiles()
    .filter((f) => classifyPath(f.route).kind === "operator")
    .filter((f) => !calls(GUARD_CALL, f.source));
  assert.deepEqual(
    unguarded.map((f) => `${f.route} (${f.file})`),
    [],
    "each of these declares server actions on an operator route without a guard",
  );
});

test("each server action in a guarded file guards itself", () => {
  // One guard at the top of the file protects one action, not its neighbours.
  //
  // The split understands every declaration form, not just
  // `export async function` (SHA-3067) — see _actionSplit.ts for why that
  // mattered, and for why the unit is a function body rather than an exported
  // symbol.
  //
  // Anything the split cannot resolve is reported here as well, so a form
  // nobody anticipated fails loudly instead of passing vacuously. That check is
  // per *export*, not per file: a file with one recognised action and one
  // unrecognised one yields sites, so a per-file "nothing recognised" clause
  // never fires — and that is the only arrangement this repo actually has.
  const misses: string[] = [];
  for (const file of actionFiles()) {
    if (classifyPath(file.route).kind !== "operator") continue;
    const actions = findActionSites(file.source);
    const ungraded = findUngradedExports(file.source);
    for (const entry of ungraded) {
      // The lexer-desync entries already describe themselves — there is no
      // export name to quote, because the desync swallowed it.
      misses.push(
        entry.startsWith("<")
          ? `${entry} (${file.file})`
          : `<export resolved to no action: ${entry}> (${file.file})`,
      );
    }
    // The per-file backstop still covers a directive with nothing exported at
    // all, where there is no export to name. It stays quiet when the per-export
    // rule already named this file's problem, so the output says one thing.
    if (actions.length === 0 && ungraded.length === 0) {
      misses.push(`<no server action recognised> (${file.file})`);
    }
    for (const action of actions) {
      if (!calls(GUARD_CALL, action.body)) misses.push(`${action.name} (${file.file})`);
    }
  }
  assert.deepEqual(
    misses,
    [],
    "each of these server actions needs its own guard call; an " +
      "<export resolved to no action> or <no server action recognised> entry " +
      'instead means this file carries a module-level "use server" with an ' +
      "export that tests/auth/_actionSplit.ts cannot resolve to an action — " +
      "widen the matcher, or drop the directive if the file declares no action. " +
      "A <source ends inside a template literal> or <export skipped as " +
      "template interior> entry means the line-based scan lost backtick parity, " +
      "usually an unpaired backtick in a comment or string: balance it (or " +
      "escape it) so the rest of the file is checked again",
  );
});

test("the per-action split resolves an action in every operator action file", () => {
  // The companion to the vacuity rule above, asserted from the other side: a
  // file is only *checked* if the matcher resolves sites in it, so count them.
  // Under the original export-keyed matcher src/app/embed/page.tsx yielded
  // zero sites and reported zero misses — green because it checked nothing,
  // which is the failure mode this guardrail exists to rule out.
  const counts = actionFiles()
    .filter((f) => classifyPath(f.route).kind === "operator")
    .map((f) => ({ file: f.file, sites: findActionSites(f.source).length }));
  assert.ok(counts.length >= 7, `expected the operator action files, found ${counts.length}`);
  assert.deepEqual(
    counts.filter((c) => c.sites === 0).map((c) => c.file),
    [],
  );
  // embed/page.tsx is the file the export-keyed matcher could not see: its
  // only action is module-local with an inline directive and no exported name.
  const embed = counts.find((c) => c.file.endsWith(path.join("embed", "page.tsx")));
  assert.ok(embed !== undefined, "embed/page.tsx is in the operator action set");
  assert.ok(embed.sites >= 1, "embed/page.tsx contributes a checked action site");
});

// ── Public surfaces that carry server actions ───────────────────────────────
//
// The rules above only reach `operator` routes, and that is correct: a
// `public` surface has no session to require, so demanding requireOperator()
// in one would be demanding the wrong thing.
//
// But `public` does not mean unauthorised. Each of these files mutates state
// for an anonymous caller, and each has its OWN mechanism standing in for the
// session. The independent review of SHA-4455 (SHA-4458) found the failure
// this closes: deleting the gate check from src/app/setup/actions.ts left the
// whole suite green, because no rule here looked at `public` action files at
// all. So every public action file must name its mechanism, and every action
// in it must either use that mechanism or be listed as exempt with a reason.
//
// This is the surfaces.ts bargain applied one level down: the next lane
// cannot add a mutating public action without deciding — in this file, in
// writing — what authorises it.
interface PublicActionGuard {
  /** Repo-relative, POSIX separators. */
  readonly file: string;
  /** The call that authorises an action in this file. */
  readonly mechanism: RegExp;
  readonly because: string;
  /** Actions that legitimately need no mechanism, each with its reason. */
  readonly exempt?: Readonly<Record<string, string>>;
}

const PUBLIC_ACTION_GUARDS: readonly PublicActionGuard[] = [
  {
    file: "src/app/setup/actions.ts",
    mechanism: /\brequireUnclaimed\s*\(/,
    because:
      "First boot. The authorisation is that this instance has no operator yet " +
      "(src/lib/auth/gate.ts); claimOperatorPassword() re-asks the same " +
      "question, so losing this call is not sufficient to claim a claimed " +
      "instance — but losing it silently is what SHA-4458 caught, so it is " +
      "held here too.",
  },
  {
    file: "src/app/login/actions.ts",
    mechanism: /\bverifyOperatorPassword\s*\(/,
    because: "The password IS the authorisation; the throttle limits guessing.",
    exempt: {
      logoutAction:
        "Destroys authority, never grants it: it deletes the session cookie. " +
        "An unauthenticated caller signing someone out of their own browser is " +
        "not a privilege.",
    },
  },
  {
    file: "src/app/msa/[token]/actions.ts",
    mechanism: /\bisSendTokenShape\s*\(/,
    because:
      "The recipient's 256-bit send token is the authorisation " +
      "(src/lib/sends/tokens.ts). The shape check is the gate these actions " +
      "apply before the token reaches a lookup; acceptSend/declineSend resolve " +
      "it and refuse an unknown one.",
  },
];

const posix = (file: string): string => file.split(path.sep).join("/");

test("every public server-action file declares what authorises it", () => {
  const declared = new Set(PUBLIC_ACTION_GUARDS.map((g) => g.file));
  const undeclared = actionFiles()
    .filter((f) => classifyPath(f.route).kind === "public")
    .filter((f) => !declared.has(posix(f.file)));
  assert.deepEqual(
    undeclared.map((f) => `${f.route} (${posix(f.file)})`),
    [],
    "each of these declares server actions on a PUBLIC route, where no " +
      "operator session is required — add an entry to PUBLIC_ACTION_GUARDS in " +
      "this file naming the mechanism that authorises it instead, or classify " +
      "the route as operator in src/lib/auth/surfaces.ts",
  );
});

test("PUBLIC_ACTION_GUARDS has no entry for a file that is not a public action file", () => {
  // The other direction, as with the SURFACES staleness rule: a stale entry
  // would silently excuse a file that has since moved or been reclassified.
  const live = new Set(
    actionFiles()
      .filter((f) => classifyPath(f.route).kind === "public")
      .map((f) => posix(f.file)),
  );
  assert.deepEqual(
    PUBLIC_ACTION_GUARDS.map((g) => g.file).filter((f) => !live.has(f)),
    [],
    "these PUBLIC_ACTION_GUARDS entries name no public action file — the file " +
      "moved, was deleted, or its route is no longer public",
  );
});

test("every action in a public action file applies that file's mechanism", () => {
  const misses: string[] = [];
  for (const guard of PUBLIC_ACTION_GUARDS) {
    const file = actionFiles().find((f) => posix(f.file) === guard.file);
    if (file === undefined) continue; // the staleness rule above owns this case
    const actions = findActionSites(file.source);
    assert.ok(
      actions.length > 0,
      `${guard.file}: the per-action split resolved no action, so this file ` +
        "would be checked vacuously — widen tests/auth/_actionSplit.ts",
    );
    for (const action of actions) {
      if (calls(guard.mechanism, action.body)) continue;
      if (guard.exempt !== undefined && action.name in guard.exempt) continue;
      misses.push(`${action.name} (${guard.file}) needs ${String(guard.mechanism)}`);
    }
  }
  assert.deepEqual(
    misses,
    [],
    "each of these is a mutating action on a public route that does not apply " +
      "its file's declared authorisation mechanism — apply it, or add the " +
      "action to that entry's `exempt` map with the reason it needs none",
  );
});

test("no public action file is exempted wholesale", () => {
  // An `exempt` map that covers every action in a file is the same hole with
  // paperwork. At least one action must actually carry the mechanism.
  for (const guard of PUBLIC_ACTION_GUARDS) {
    const file = actionFiles().find((f) => posix(f.file) === guard.file);
    if (file === undefined) continue;
    assert.ok(
      calls(guard.mechanism, file.source),
      `${guard.file} declares ${String(guard.mechanism)} but never calls it`,
    );
  }
});

test("no operator surface is served from a client component", () => {
  // A "use client" page cannot enforce anything: the payload is already on
  // the wire by the time its code runs.
  const clientPages = routeFiles()
    .filter((r) => classifyPath(r.route).kind === "operator")
    .filter((r) => /^\s*["']use client["'];/m.test(r.source));
  assert.deepEqual(clientPages.map((r) => r.file), []);
});

test("surfaces.ts carries no entry for a route that no longer exists", () => {
  // Keeps the registry honest in the other direction: a stale public entry
  // for a deleted route is a hole waiting for a route of that name to return.
  const routes = routeFiles().map((r) => r.route);
  const unused = SURFACES.filter((surface) => {
    if (surface.pattern.endsWith("/**")) return false; // prefix entries are deliberate
    return !routes.some((route) => route === surface.pattern);
  });
  assert.deepEqual(
    unused.map((s) => s.pattern),
    [],
    "these SURFACES entries match no route in src/app — delete them or fix the pattern",
  );
});
