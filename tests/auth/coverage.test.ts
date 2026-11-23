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

const GUARD_CALL = /\b(requireOperator|guardOperatorRequest)\s*\(/;

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
    .filter((r) => !GUARD_CALL.test(r.source));
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
    .filter((f) => !GUARD_CALL.test(f.source));
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
      if (!GUARD_CALL.test(action.body)) misses.push(`${action.name} (${file.file})`);
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
