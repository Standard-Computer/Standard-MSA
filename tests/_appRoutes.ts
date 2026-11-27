// The real route table of src/app, read off the file system.
//
// Extracted from tests/auth/coverage.test.ts (SHA-3047) when SHA-4503 added a
// second guardrail that has to agree with the first about what the routes ARE.
// Two walkers would be two answers to that question, and the one that drifts
// is the one that stops holding anything.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const APP_DIR = path.join(process.cwd(), "src", "app");

// Walking a directory tree means non-literal paths by definition. Every path
// below is built from APP_DIR plus names this repo's own src/app yields —
// nothing here reads request input.
/* eslint-disable security/detect-non-literal-fs-filename */
export const listDir = (dir: string): string[] => readdirSync(dir);
export const isDir = (full: string): boolean => statSync(full).isDirectory();
export const readSource = (full: string): string => readFileSync(full, "utf8");
/* eslint-enable security/detect-non-literal-fs-filename */

export interface RouteFile {
  /** The URL path Next derives from the directory, e.g. `/sends/[id]`. */
  readonly route: string;
  /** Repo-relative file path, for a failure message that says where to look. */
  readonly file: string;
  readonly source: string;
  /** `page.tsx` / `page.ts` / `route.ts` — a screen vs. a handler. */
  readonly entry: string;
}

/** Route groups `(name)` and private folders `_name` are not URL segments. */
export function isUrlSegment(dir: string): boolean {
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
      entry,
    });
  }
}

/** Every page and route handler in the app, with its URL path. */
export function routeFiles(): RouteFile[] {
  const out: RouteFile[] = [];
  walk(APP_DIR, [], out);
  return out;
}

/** Just the screens: a `page` file renders HTML, a `route.ts` does not. */
export function pageFiles(): RouteFile[] {
  return routeFiles().filter((r) => r.entry !== "route.ts");
}

/** Files that declare server actions, with the route they sit under. */
export function actionFiles(): RouteFile[] {
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
      out.push({
        route: `/${segments.join("/")}`,
        file: path.relative(process.cwd(), full),
        source,
        entry,
      });
    }
  };
  visit(APP_DIR, []);
  return out;
}
