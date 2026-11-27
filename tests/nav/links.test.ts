// The nav link map, held against the file system (SHA-4496, GH #17 AC 7).
//
// GH #17 is not really "add a menu". It is "/embed and /settings/email were
// built, worked, and were unreachable from the console, and nothing failed".
// Adding links fixes those two. This file is what stops the third: it walks
// src/app for operator SCREENS and fails when one is neither in the nav nor a
// sub-screen of something that is.
//
// Everything here is pure data and a directory walk — no React, no DOM — so
// it runs under the repo's `node --test` suite, which only collects
// tests/**/*.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { classifyPath } from "../../src/lib/auth/surfaces";
import {
  activeNavHref,
  isActiveNavHref,
  MODULE_CARDS,
  NAV_LINKS,
  shouldRenderOperatorNav,
} from "../../src/lib/nav/operatorNav";
import {
  NAV_COLLAPSED_CLASS,
  NAV_COLLAPSED_VALUE,
  NAV_COLLAPSE_BOOTSTRAP,
  NAV_COLLAPSE_STORAGE_KEY,
} from "../../src/lib/nav/collapse";

const APP_DIR = path.join(process.cwd(), "src", "app");

// Walking a directory tree means non-literal paths by definition; every path
// below is APP_DIR plus names this repo's own src/app yields. Same stance,
// and the same disable, as tests/auth/coverage.test.ts.
/* eslint-disable security/detect-non-literal-fs-filename */
const listDir = (dir: string): string[] => readdirSync(dir);
const isDir = (full: string): boolean => statSync(full).isDirectory();
/* eslint-enable security/detect-non-literal-fs-filename */

/** Route groups `(name)` and private folders `_name` are not URL segments. */
function isUrlSegment(dir: string): boolean {
  return !(dir.startsWith("(") && dir.endsWith(")")) && !dir.startsWith("_");
}

/**
 * Every SCREEN in the app, as a URL path.
 *
 * `page.tsx` / `page.ts` only. A `route.ts` is a request handler — a CSV, a
 * redirect, a webhook — and no layout renders for it, so it has no nav to be
 * missing from.
 */
function screenRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string, segments: string[]): void => {
    for (const entry of listDir(dir)) {
      const full = path.join(dir, entry);
      if (isDir(full)) {
        walk(full, isUrlSegment(entry) ? [...segments, entry] : segments);
        continue;
      }
      if (entry !== "page.tsx" && entry !== "page.ts") continue;
      out.push(`/${segments.join("/")}`);
    }
  };
  walk(APP_DIR, []);
  return out;
}

/**
 * Operator screens that deliberately have no nav link of their own, each with
 * the reason. Empty today, on purpose: every operator screen on main is
 * either in the nav or lives under a screen that is.
 *
 * This exists so the next lane has a sanctioned way to say "this screen is
 * reached from inside another one" — in writing, in a diff a reviewer reads —
 * rather than by weakening the rule below.
 */
const NAV_EXEMPT_SCREENS: Readonly<Record<string, string>> = {};

const navHrefs = (): string[] => NAV_LINKS.map((l) => l.href);

/** Is `route` the nav's own destination, or a screen underneath one? */
function reachableFromNav(route: string): boolean {
  return navHrefs().some((href) => isActiveNavHref(href, route));
}

test("the walk finds the real route table", () => {
  // Non-vacuity. Every rule below is a filter over this list, so an empty or
  // broken walk would make the whole file green while checking nothing.
  const routes = screenRoutes();
  assert.ok(routes.length >= 12, `expected the real screens, found ${routes.length}`);
  // The two screens this lane exists because of.
  assert.ok(routes.includes("/embed"), "walk found /embed");
  assert.ok(routes.includes("/settings/email"), "walk found /settings/email");
});

test("every operator screen is reachable from the nav", () => {
  // THE rule (AC 7). Before this lane /embed and /settings/email both failed
  // it and nothing noticed, because nothing asked.
  const unreachable = screenRoutes()
    .filter((route) => {
      const surface = classifyPath(route);
      return surface.kind === "operator" && surface.refusal === "redirect";
    })
    .filter((route) => !reachableFromNav(route))
    .filter((route) => !(route in NAV_EXEMPT_SCREENS));
  assert.deepEqual(
    unreachable,
    [],
    "each of these is an operator screen a user cannot get to from the menu — " +
      "add it to NAV_LINKS in src/lib/nav/operatorNav.ts, or, if it is only " +
      "ever reached from inside another screen, add it to NAV_EXEMPT_SCREENS " +
      "in this file with the reason",
  );
});

test("NAV_EXEMPT_SCREENS names no route that does not exist", () => {
  // The staleness direction: an exemption for a deleted or renamed screen
  // would silently excuse a future screen that takes its path.
  const routes = new Set(screenRoutes());
  assert.deepEqual(
    Object.keys(NAV_EXEMPT_SCREENS).filter((route) => !routes.has(route)),
    [],
    "these exemptions match no screen in src/app — delete them",
  );
});

test("the nav lists every module GH #17 asked for", () => {
  const byHref = new Map(NAV_LINKS.map((l) => [l.href, l]));
  // Label text is quoted from AC 2, so a rename that loses a module shows up
  // here rather than as a surprise in review.
  const required: ReadonlyArray<readonly [string, string]> = [
    ["/onboarding", "Onboarding"],
    ["/embed", "Legal"],
    ["/visits", "Visitor log"],
    ["/legal", "Public /legal site"],
    ["/settings/email", "Email delivery"],
    ["/documents", "Documents"],
    ["/sends", "MSA sends"],
    ["/settings/api", "API"],
    ["/settings/identity", "Settings / Identity"],
  ];
  for (const [href, label] of required) {
    const link = byHref.get(href);
    assert.ok(link !== undefined, `the nav links ${href}`);
    assert.equal(link.label, label, `${href} is labelled for a human`);
  }
});

test("every nav link is an operator screen, bar the one public exception", () => {
  for (const link of NAV_LINKS) {
    assert.ok(link.href.startsWith("/"), `${link.label} is an absolute path`);
    assert.ok(!link.href.startsWith("//"), `${link.label} is not protocol-relative`);
    assert.ok(link.hint.length > 0, `${link.label} has a hint`);
    const surface = classifyPath(link.href);
    if (link.publicSite) {
      // The MSP's own live legal index (AC 2). Asserted to BE public, so this
      // exception cannot quietly become the cover for an unclassified path.
      assert.equal(surface.kind, "public", `${link.href} is the public site`);
      continue;
    }
    assert.equal(surface.kind, "operator", `${link.href} is an operator surface`);
    assert.equal(surface.refusal, "redirect", `${link.href} is a screen, not a download`);
  }
  // Exactly one public link, so "add publicSite: true" is not a way to slip a
  // second outbound link into the operator menu without a test noticing.
  assert.equal(NAV_LINKS.filter((l) => l.publicSite).length, 1);
});

test("no nav link is duplicated", () => {
  assert.equal(new Set(navHrefs()).size, NAV_LINKS.length, "hrefs are unique");
  assert.equal(
    new Set(NAV_LINKS.map((l) => l.label)).size,
    NAV_LINKS.length,
    "labels are unique",
  );
});

test("a nav child is nested under a top-level link, never first", () => {
  assert.notEqual(NAV_LINKS[0].child, true, "the first link is top-level");
  const children = NAV_LINKS.filter((l) => l.child === true);
  assert.ok(children.length >= 2, "the Legal group has children");
});

test("the nav does not grow on a public or machine surface", () => {
  // AC 1, from the other side of the gate. The public legal site and the
  // recipient's own agreement must not carry the MSP's internal menu, and
  // the login screen must not advertise the console's shape.
  for (const pathname of [
    "/legal",
    "/legal/msa",
    "/legal/msa/2",
    "/legal/embed.js",
    "/legal/embed/frame",
    "/msa/abc",
    "/msa/" + "x".repeat(43),
    "/login",
    "/setup",
    "/api/health",
    "/api/v1/sends",
    "/api/cron/email",
    // Operator, but a download: a route handler renders no layout.
    "/visits/export",
    "/sends/1/evidence",
  ]) {
    assert.equal(shouldRenderOperatorNav(pathname), false, `${pathname} gets no nav`);
  }
});

test("the nav renders on every operator screen", () => {
  for (const pathname of [
    "/",
    "/onboarding",
    "/embed",
    "/visits",
    "/documents",
    "/documents/new",
    "/documents/msa",
    "/documents/msa/draft",
    "/sends",
    "/sends/new",
    "/sends/notices",
    "/sends/12",
    "/settings/email",
    "/settings/api",
    "/settings/identity",
    // Classified by UNMATCHED: an unknown console path keeps its chrome.
    "/not-a-screen",
  ]) {
    assert.equal(shouldRenderOperatorNav(pathname), true, `${pathname} gets the nav`);
  }
});

test("the current section is the most specific match", () => {
  // AC 5. The pairs that would actually go wrong: a prefix stealing the mark,
  // and "/" matching everything.
  assert.equal(activeNavHref("/"), "/");
  assert.equal(activeNavHref("/documents"), "/documents");
  assert.equal(activeNavHref("/documents/msa/draft"), "/documents");
  assert.equal(activeNavHref("/sends/12"), "/sends");
  assert.equal(activeNavHref("/sends/notices"), "/sends");
  assert.equal(activeNavHref("/settings/email"), "/settings/email");
  assert.equal(activeNavHref("/settings/api"), "/settings/api");
  assert.equal(activeNavHref("/settings/identity"), "/settings/identity");
  assert.equal(activeNavHref("/visits"), "/visits");
  assert.equal(activeNavHref("/embed"), "/embed");
  // Off-menu: no link is marked rather than the wrong one.
  assert.equal(activeNavHref("/not-a-screen"), null);
  // Segment-wise, so a path that merely starts with the same TEXT misses.
  assert.equal(isActiveNavHref("/settings/email", "/settings/email-digest"), false);
  assert.equal(isActiveNavHref("/sends", "/sendsx"), false);
  assert.equal(isActiveNavHref("/", "/documents"), false);
});

test("every home dashboard card links to a nav destination", () => {
  // AC 5: no card may be a dead label again. The type already forbids null;
  // this forbids a link to somewhere the menu does not know about.
  const hrefs = new Set(navHrefs());
  for (const card of MODULE_CARDS) {
    assert.ok(card.href.startsWith("/"), `${card.title} links to an app path`);
    assert.ok(hrefs.has(card.href), `${card.title} -> ${card.href} is in the nav`);
    assert.equal(classifyPath(card.href).kind, "operator", `${card.title} is operator-only`);
  }
  // The six modules the v0 home page showed are all still there — two of them
  // (/legal site, Email delivery) are the ones that had href: null.
  assert.equal(MODULE_CARDS.length, 6);
  const titles = MODULE_CARDS.map((c) => c.title);
  assert.ok(titles.includes("/legal site"));
  assert.ok(titles.includes("Email delivery"));
});

test("the home page renders MODULE_CARDS rather than its own list", () => {
  // The card list and the nav are only one fact if the page reads the table.
  // A page that rebuilt its own array would pass every rule above.
  const source = readFileSync(path.join(APP_DIR, "page.tsx"), "utf8");
  assert.match(source, /MODULE_CARDS/, "src/app/page.tsx imports the shared table");
  assert.doesNotMatch(source, /href:\s*null/, "no card may carry href: null again");
});

test("the collapse bootstrap is a safe inline script built from the constants", () => {
  // It reaches the page through dangerouslySetInnerHTML, so the properties
  // that make that safe get asserted rather than assumed.
  assert.ok(
    NAV_COLLAPSE_BOOTSTRAP.includes(JSON.stringify(NAV_COLLAPSE_STORAGE_KEY)),
    "reads the same storage key the toggle writes",
  );
  assert.ok(
    NAV_COLLAPSE_BOOTSTRAP.includes(JSON.stringify(NAV_COLLAPSED_VALUE)),
    "compares against the same stored value",
  );
  assert.ok(
    NAV_COLLAPSE_BOOTSTRAP.includes(JSON.stringify(NAV_COLLAPSED_CLASS)),
    "applies the same class globals.css styles",
  );
  // No angle bracket can appear, so the literal cannot close its own <script>
  // element or open another tag.
  assert.doesNotMatch(NAV_COLLAPSE_BOOTSTRAP, /[<>]/);
  // Nothing interpolated at render: the whole thing is a module constant.
  assert.doesNotMatch(NAV_COLLAPSE_BOOTSTRAP, /\$\{/);
  // A storage failure must not throw on a page load.
  assert.match(NAV_COLLAPSE_BOOTSTRAP, /^try\{/);
  assert.match(NAV_COLLAPSE_BOOTSTRAP, /catch\(e\)\{\}$/);
  assert.ok(
    NAV_COLLAPSE_STORAGE_KEY.startsWith("standard-msa:"),
    "the key is namespaced to this app",
  );
});

test("the root layout injects the bootstrap and the shell", () => {
  const source = readFileSync(path.join(APP_DIR, "layout.tsx"), "utf8");
  assert.match(source, /NAV_COLLAPSE_BOOTSTRAP/, "the pre-paint script is injected");
  assert.match(source, /<OperatorShell>/, "every screen is wrapped in the shell");
  // The layout wraps public surfaces too; the shell is what excludes them, so
  // it must not be a client component boundary that the layout opts out of.
  assert.doesNotMatch(source, /^\s*["']use client["'];/m, "the root layout stays a server component");
});
