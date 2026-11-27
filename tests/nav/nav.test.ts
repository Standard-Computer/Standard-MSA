// The nav guardrail (SHA-4503, GH #17).
//
// The bug this exists to make unrepeatable: `/embed` and `/settings/email`
// were built, merged and then unreachable, because the home page carried them
// as cards with `href: null` and nothing anywhere asserted that a module the
// app contains is a module the operator can get to.
//
// So this walks the real route tree (tests/_appRoutes.ts — the same walk the
// auth guardrail uses) and fails when an operator SCREEN is neither a nav
// destination nor named below as a sub-screen of one. Adding a module means
// linking it, or writing down here why it needs no link of its own.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import ts from "typescript";

import { classifyPath } from "../../src/lib/auth/surfaces";
import {
  NAV_COLLAPSED_COOKIE,
  navCollapsedCookie,
  parseNavCollapsed,
} from "../../src/lib/nav/collapse";
import { NAV_ICON_PATHS } from "../../src/lib/nav/icons";
import {
  activeItemId,
  dashboardCards,
  NAV,
  navItems,
  showsOperatorNav,
} from "../../src/lib/nav/nav";
import { pageFiles, readSource, routeFiles } from "../_appRoutes";

/** Parse a repo-relative source file, comments and all, as TSX. */
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readSource(path.join(process.cwd(), file)),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

function isJsDoc(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

/**
 * Operator screens that are deliberately NOT their own nav entry, each with
 * the entry they are reached from.
 *
 * `owns` patterns on a nav item are for the current-section highlight only and
 * deliberately do not satisfy reachability: `/documents/**` covering every
 * future screen under `/documents` would let the next one ship with no route
 * in from anywhere, which is this file's whole subject. So each sub-screen is
 * listed, by name, once.
 */
const NAV_SUB_SCREENS: Readonly<Record<string, string>> = {
  "/": "The dashboard itself. The shell's brand mark is the link to it.",
  "/documents/new": "Reached from the Documents list.",
  "/documents/[slug]": "Reached from the Documents list.",
  "/documents/[slug]/draft": "Reached from a document's own page.",
  "/sends/new": "Reached from the MSA sends list.",
  "/sends/notices": "Reached from the MSA sends list.",
  "/sends/[id]": "Reached from the MSA sends list.",
};

/** Operator screens, from the file system. */
function operatorScreens(): string[] {
  return pageFiles()
    .filter((r) => {
      const surface = classifyPath(r.route);
      return surface.kind === "operator" && surface.refusal === "redirect";
    })
    .map((r) => r.route);
}

test("the route walk and the nav are both non-empty", () => {
  // Non-vacuity first: every rule below is an "each of these is empty"
  // assertion, and an empty walk or an empty nav would satisfy all of them
  // while proving nothing.
  assert.ok(routeFiles().length >= 40, `found ${routeFiles().length} route files`);
  assert.ok(operatorScreens().length >= 12, `found ${operatorScreens().length} screens`);
  assert.ok(NAV.length >= 3, `found ${NAV.length} nav sections`);
  assert.ok(navItems().length >= 9, `found ${navItems().length} nav items`);
});

test("every operator screen is a nav destination or a named sub-screen", () => {
  const destinations = new Set(navItems().map((i) => i.href));
  const unreachable = operatorScreens().filter(
    (route) => !destinations.has(route) && !(route in NAV_SUB_SCREENS),
  );
  assert.deepEqual(
    unreachable,
    [],
    "each of these operator screens has no way in: add it to NAV in " +
      "src/lib/nav/nav.ts, or add it to NAV_SUB_SCREENS in this file naming " +
      "the screen it is reached from. /embed and /settings/email shipped " +
      "unreachable for exactly this reason",
  );
});

test("NAV_SUB_SCREENS names no screen that is not one", () => {
  // The staleness direction, as SURFACES has: an entry for a route that has
  // moved or been reclassified silently excuses whatever takes its name next.
  const screens = new Set(operatorScreens());
  assert.deepEqual(
    Object.keys(NAV_SUB_SCREENS).filter((route) => !screens.has(route)),
    [],
    "these NAV_SUB_SCREENS entries match no operator screen in src/app",
  );
});

test("every nav href is a real route in src/app", () => {
  // The other half of reachability: a link to a route that does not exist is
  // as unreachable as no link, and lands the operator on a 404.
  const routes = new Set(routeFiles().map((r) => r.route));
  assert.deepEqual(
    navItems()
      .filter((i) => !routes.has(i.href))
      .map((i) => `${i.label} -> ${i.href}`),
    [],
    "these nav items point at no route under src/app",
  );
});

test("every name Sean asked for is in the nav", () => {
  // Acceptance criterion 2, as a list rather than as a reading of the nav.
  // A rename that drops one of these is a regression against the request.
  const labels = new Set<string>([
    ...NAV.map((s) => s.label).filter((l): l is string => l !== null),
    ...navItems().map((i) => i.label),
  ]);
  const wanted = [
    "Onboarding",
    "Legal",
    "Email delivery",
    "Documents",
    "MSA sends",
    "API",
    "Settings",
    "Identity",
  ];
  assert.deepEqual(
    wanted.filter((w) => !labels.has(w)),
    [],
    "the nav lost one of the names the issue asked for",
  );
});

test("Onboarding and Identity are both present, and are distinct screens", () => {
  const byId = new Map(navItems().map((i) => [i.id, i]));
  assert.equal(byId.get("onboarding")?.href, "/onboarding");
  assert.equal(byId.get("settings-identity")?.href, "/settings/identity");
});

test("the Legal group reaches the embed generator, the visitor log and the public site", () => {
  const legal = NAV.find((s) => s.id === "legal");
  assert.ok(legal !== undefined, "there is a Legal section");
  assert.deepEqual(
    legal.items.map((i) => i.href),
    ["/embed", "/visits", "/legal"],
  );
  // The public site is the one destination outside the console, so it is the
  // one that must open in a new tab — the chrome does not follow it there.
  assert.equal(legal.items.find((i) => i.href === "/legal")?.newTab, true);
  assert.deepEqual(
    navItems().filter((i) => i.newTab).map((i) => i.href),
    ["/legal"],
  );
});

test("every dashboard card has a real link, and the two that were null are linked", () => {
  const cards = dashboardCards();
  assert.equal(cards.length, 6, "the six home-page modules each have a card");
  assert.deepEqual(
    cards.filter((c) => c.href.length === 0 || !c.href.startsWith("/")).map((c) => c.card.title),
    [],
    "a dashboard card with no usable href is the `href: null` bug returning",
  );
  // Named, because these two are the actual regression: cards that existed
  // with no link at all.
  const byTitle = new Map(cards.map((c) => [c.card.title, c.href]));
  assert.equal(byTitle.get("/legal site"), "/embed");
  assert.equal(byTitle.get("Email delivery"), "/settings/email");
  // And the other four kept theirs.
  assert.deepEqual(
    [...byTitle.keys()].sort(),
    ["/legal site", "API", "Documents", "Email delivery", "MSA sends", "Onboarding"].sort(),
  );
});

test("the home page renders the cards from the nav table, not from a list of its own", () => {
  // Deriving the cards is what removes the unlinked-card state; a second
  // hard-coded list in page.tsx would bring it straight back.
  //
  // Asked of the parser, not of the text, twice over.
  //
  //   1. The first draft was a regex for `href: null`, and it failed on the
  //      very commit that fixed the bug, because the comment in page.tsx
  //      explaining the fix names the shape it removed. That is the carrier
  //      class tests/auth/coverage.test.ts documents across five rounds.
  //   2. The second draft asked for a `PropertyAssignment` named `href` whose
  //      initializer was the `null` keyword — and a planted
  //      `href: null as unknown as string` walked straight past it, because
  //      that initializer is an `AsExpression`. Chasing initializer shapes is
  //      the same losing game.
  //
  // So the rule is the invariant instead of the symptom: the cards come from
  // the nav table, therefore page.tsx READS `m.href` and never DECLARES an
  // `href` of its own. A JSX `href={...}` attribute is a `JsxAttribute`, a
  // different node, so the real `<Link href={m.href}>` is untouched; any
  // hand-built card object, with any initializer at all, is not.
  const sf = parse(path.join("src", "app", "page.tsx"));
  let callsDashboardCards = false;
  const declared: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isJsDoc(node)) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "dashboardCards"
    ) {
      callsDashboardCards = true;
    }
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === "href"
    ) {
      declared.push(`line ${sf.getLineAndCharacterOfPosition(node.name.pos).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  assert.ok(callsDashboardCards, "src/app/page.tsx calls dashboardCards()");
  assert.deepEqual(
    declared,
    [],
    "src/app/page.tsx declares an href of its own, so it is building cards " +
      "rather than reading them from NAV — which is where `href: null` came from",
  );
});

test("no public or machine surface shows the operator nav", () => {
  // Acceptance criterion 1, asserted over the whole real route tree rather
  // than over the handful of paths the issue lists.
  const leaking = routeFiles()
    .filter((r) => classifyPath(r.route).kind !== "operator")
    .filter((r) => showsOperatorNav(r.route.replace(/\[[^\]]+\]/g, "x")))
    .map((r) => r.route);
  assert.deepEqual(leaking, [], "these non-operator surfaces would grow the nav");

  // The six the issue names, by hand, with a concrete token/slug substituted.
  for (const bare of [
    "/legal",
    "/legal/msa",
    "/legal/msa/3",
    "/legal/embed.js",
    "/legal/embed/frame",
    "/msa/0123456789abcdef",
    "/login",
    "/setup",
  ]) {
    assert.equal(showsOperatorNav(bare), false, bare);
  }

  // Paired control: the operator screens must all say true, or this rule is
  // passing because showsOperatorNav() answers false to everything.
  for (const screen of operatorScreens()) {
    assert.equal(showsOperatorNav(screen.replace(/\[[^\]]+\]/g, "x")), true, screen);
  }
});

test("an operator download is not a screen and gets no chrome", () => {
  // `/visits/export` and `/sends/[id]/evidence` are operator-gated, but they
  // answer with a file. Wrapping one in a sidebar would corrupt the download.
  assert.equal(showsOperatorNav("/visits/export"), false);
  assert.equal(showsOperatorNav("/sends/41/evidence"), false);
});

test("the current section follows the path, including into sub-screens", () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ["/onboarding", "onboarding"],
    ["/documents", "documents"],
    ["/documents/msa", "documents"],
    ["/documents/msa/draft", "documents"],
    ["/sends", "sends"],
    ["/sends/41", "sends"],
    ["/sends/new", "sends"],
    ["/sends/notices", "sends"],
    ["/embed", "legal-embed"],
    ["/visits", "legal-visits"],
    ["/visits/export", "legal-visits"],
    ["/settings/identity", "settings-identity"],
    ["/settings/email", "settings-email"],
    ["/settings/api", "settings-api"],
    // Query and trailing slash are not part of the section.
    ["/sends/", "sends"],
    ["/visits?slug=msa", "legal-visits"],
    // The dashboard is the brand link, not a nav item; and the public site
    // never highlights, because it is not where the operator still is.
    ["/", null],
    ["/legal", null],
    ["/nope", null],
  ];
  for (const [pathname, expected] of cases) {
    assert.equal(activeItemId(pathname), expected, pathname);
  }
});

test("nav ids are unique and every one has an icon", () => {
  const ids = navItems().map((i) => i.id);
  assert.deepEqual([...new Set(ids)], ids, "two nav items share an id");
  assert.deepEqual(
    ids.filter((id) => NAV_ICON_PATHS[id] === undefined),
    [],
    "the collapsed rail is icons only, so every item needs one in src/lib/nav/icons.ts",
  );
  assert.deepEqual(
    Object.keys(NAV_ICON_PATHS).filter((id) => !ids.includes(id)),
    [],
    "these icons belong to no nav item",
  );
  const sectionIds = NAV.map((s) => s.id);
  assert.deepEqual([...new Set(sectionIds)], sectionIds, "two sections share an id");
});

test("the collapse preference round-trips, and defaults to expanded", () => {
  assert.equal(parseNavCollapsed(undefined), false, "no cookie = expanded");
  assert.equal(parseNavCollapsed(""), false, "empty cookie = expanded");
  assert.equal(parseNavCollapsed("yes"), false, "junk cookie = expanded");
  assert.equal(parseNavCollapsed("0"), false);
  assert.equal(parseNavCollapsed("1"), true);
  for (const collapsed of [true, false]) {
    const header = navCollapsedCookie(collapsed, false);
    assert.equal(parseNavCollapsed(header.split(";")[0].split("=")[1]), collapsed);
    assert.ok(header.startsWith(`${NAV_COLLAPSED_COOKIE}=`), header);
    assert.ok(header.includes("Path=/"), header);
    assert.ok(header.includes("SameSite=Lax"), header);
    // A year, so the preference outlives the session that set it (AC4).
    assert.match(header, /Max-Age=31536000\b/);
    // No `Secure` on plain HTTP, or the browser drops it and persistence
    // silently stops working on a self-host without TLS.
    assert.ok(!header.includes("Secure"), header);
    assert.ok(navCollapsedCookie(collapsed, true).includes("; Secure"));
  }
});

test("the shell is actually mounted in the root layout", () => {
  // A nav nobody renders passes every rule above. Asked of the parser rather
  // than of the text, for the reason tests/auth/coverage.test.ts spells out at
  // length: a JSX element is a node, and prose naming one is not.
  const sf = parse(path.join("src", "app", "layout.tsx"));
  let mounted = false;
  const visit = (node: ts.Node): void => {
    if (mounted) return;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (ts.isIdentifier(node.tagName) && node.tagName.text === "OperatorShell") {
        mounted = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  assert.ok(mounted, "src/app/layout.tsx does not render <OperatorShell>");
});

test("nothing server-only reaches the client nav", () => {
  // Client-bundle discipline: the shell is a client component, so every module
  // it pulls in ships to the browser. `src/lib/auth/surfaces.ts` is pure by
  // design and that is why the shell may ask it which surfaces are operator —
  // but `src/lib/auth/page.ts` next door is `server-only`, so a stray import
  // here would be a build break at best and a leak at worst.
  const files = [
    path.join("src", "components", "nav", "OperatorShell.tsx"),
    path.join("src", "lib", "nav", "nav.ts"),
    path.join("src", "lib", "nav", "icons.ts"),
    path.join("src", "lib", "nav", "collapse.ts"),
    path.join("src", "lib", "auth", "surfaces.ts"),
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const sf = parse(file);
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const spec = statement.moduleSpecifier.text;
      if (
        spec === "server-only" ||
        spec === "next/headers" ||
        /(^|\/)(db|auth\/page|auth\/gate|auth\/session|auth\/guard)$/.test(spec)
      ) {
        offenders.push(`${file} imports ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "a server-only module reached the client nav");
});
