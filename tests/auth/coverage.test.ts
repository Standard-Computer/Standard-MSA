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

test("each exported action in a guarded file guards itself", () => {
  // One guard at the top of the file protects one action, not its neighbours.
  const misses: string[] = [];
  for (const file of actionFiles()) {
    if (classifyPath(file.route).kind !== "operator") continue;
    // Split on exported function declarations and check each body.
    const parts = file.source.split(/^export async function /m).slice(1);
    for (const part of parts) {
      const name = part.slice(0, part.indexOf("(")).trim();
      // The body runs to the next top-level close brace.
      const end = part.indexOf("\n}");
      const body = end === -1 ? part : part.slice(0, end);
      if (!GUARD_CALL.test(body)) misses.push(`${name} (${file.file})`);
    }
  }
  assert.deepEqual(misses, [], "each of these exported actions needs its own guard call");
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
