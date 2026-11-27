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
import ts from "typescript";

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
 * How the rules below decide a source really CALLS a guard.
 *
 * They ask the parser for `CallExpression` nodes. They used to match a regex
 * against text, and five rounds of review established that no amount of
 * pre-processing makes a regex able to tell a call from prose about a call:
 *
 *   1. SHA-4458. The first public-action rule passed with the gate check
 *      deleted from src/app/setup/actions.ts, because the comment above that
 *      line names `requireUnclaimed()` — parentheses included — and the regex
 *      matched the comment. A guardrail a comment can satisfy is not one.
 *   2. So the rules ran on source with comments blanked out, by a scanner
 *      written here. `/["]/` — an unpaired quote in a character class, real at
 *      src/lib/legal/html.ts:15 — flipped it into string mode, and every
 *      comment after it in the file leaked through as code (SHA-4469).
 *   3. Teaching it regex literals made `</div>` and `<Foo />` open regex mode,
 *      where `//` is not a comment opener, so a trailing comment on a JSX line
 *      leaked instead.
 *   4. Excluding those two JSX shapes made a regex that *starts* with `>` —
 *      `/>/g`, the idiomatic sibling of that html.ts line — refuse its own
 *      opener and leak (SHA-4472).
 *   5. Asking the parser for the comment ranges closed that whole class, and
 *      the carrier simply moved: the stripper deliberately keeps strings,
 *      template literals and JSX children, so `<p>requireOperator()</p>`,
 *      `"requireOperator()"` and `` `requireUnclaimed()` `` each satisfied a
 *      mechanism rule with the real call deleted (SHA-4484).
 *
 * Round 5 is the one that does not generalise to a sixth: a `CallExpression`
 * is what the parser emits for a call and nothing else. Prose cannot produce
 * one, in a comment or anywhere else; neither can the text of a string, a
 * template literal or a JSX child. There is no carrier left to move to, so
 * this is a closed class rather than an exclusion list — which is why the
 * stripper, and the token-equivalence sweep that existed to police it, are
 * both gone. (The sweep could not have caught round 5 either: a comment that
 * survives stripping is still a comment in the stripped text, comments emit no
 * tokens, so the two streams match. It only ever closed the eats-code
 * direction. Measured on this tree: a stripper that drops every `/**` range
 * passes it on all 136 files.)
 *
 * `typescript` is already a devDependency, so this costs no new install, and
 * nothing in `src/` changes.
 */
function parseSource(source: string): ts.SourceFile {
  // Parsed as .tsx throughout: it is what most of this repo is, the parser is
  // error-tolerant so the action-body fragments the rules below pass in parse
  // too, and every .ts file under src/ yields an identical comment set under
  // either script kind (measured across all 136 of them).
  return ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function isJsDoc(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;
}

/**
 * The name being called, for the callee forms a guard can be invoked through.
 *
 * `requireOperator()` is an Identifier; `auth.requireOperator()` through a
 * namespace import is a PropertyAccessExpression, and the parentheses and `!`
 * forms are unwrapped because they change nothing about which function runs.
 * Anything else — a call through a variable, an element access, a call whose
 * callee is itself a call — is deliberately not a match: the rules below want
 * the guard named at the call site, which is also all the old regex could see.
 */
function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isParenthesizedExpression(expr)) return calleeName(expr.expression);
  if (ts.isNonNullExpression(expr)) return calleeName(expr.expression);
  return undefined;
}

/**
 * Does this source really CALL one of `names`, as opposed to talking about it?
 *
 * A `CallExpression` is the only node the parser emits for a call, so prose
 * cannot satisfy this however it is carried — see the note above `parseSource`
 * for the five rounds that establishes. JSDoc subtrees are skipped outright
 * rather than relied on to contain no call node.
 *
 * `false` is the fail-closed answer: every rule below reports a miss when this
 * returns false, so a fragment that will not parse fails loudly instead of
 * passing vacuously.
 */
function calls(names: readonly string[], source: string): boolean {
  const sf = parseSource(source);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || isJsDoc(node)) return;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name !== undefined && names.includes(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

const GUARD_CALLS = ["requireOperator", "guardOperatorRequest"] as const;

test("calls() sees a call and nothing that merely names one", () => {
  // The predicate is load-bearing for every rule below, so it gets its own
  // assertions rather than being trusted. The four carriers are the four that
  // have actually satisfied a rule in this guardrail's history: a comment
  // (SHA-4458), then JSX children, a string and a template literal (SHA-4484),
  // once comments stopped being the easy one.
  const prose: ReadonlyArray<readonly [string, string]> = [
    ["line comment", "// requireOperator()\n"],
    ["block comment", "/* requireOperator() */\n"],
    ["JSDoc", "/** requireOperator() */\nexport const x = 1;\n"],
    ["JSX child text", "export const C = () => <p>requireOperator()</p>;\n"],
    ["JSX child, multi-line", "export const C = () => (\n  <p>\n    requireOperator()\n  </p>\n);\n"],
    ["string literal", 'const s = "requireOperator()";\n'],
    ["template literal text", "const s = `requireOperator()`;\n"],
    ["JSX attribute string", 'export const C = () => <p title="requireOperator()" />;\n'],
    // The shapes the old scanner got wrong are still worth a line each, since
    // they are the inputs most likely to break a parse-based reading too.
    ["trailing comment after JSX", "<p>hi</p> // requireOperator()\nconst a = 1;\n"],
    ["trailing comment after a >-regex", 'v.replace(/>/g, "x"); // requireOperator()\n'],
    ["quote in a character class", 'const re = /["]/g;\n// requireOperator()\n'],
    ["comment inside a JSX container", "export const C = () => <p>{/* requireOperator() */}</p>;\n"],
    // A declaration is not a call. The five files that declare these functions
    // are never queried by a rule below, so this costs nothing and keeps the
    // predicate honest about what it answers.
    ["its own declaration", "export async function requireOperator(): Promise<void> {}\n"],
  ];
  for (const [label, source] of prose) {
    assert.equal(calls(GUARD_CALLS, source), false, label);
  }
  // The paired controls: none of the above may cost a real call. A predicate
  // that stops seeing its call is as broken as one prose can satisfy.
  const real: ReadonlyArray<readonly [string, string]> = [
    ["awaited call", "await requireOperator();\n"],
    ["the other name", "guardOperatorRequest(request);\n"],
    ["after a trailing comment", "<p>hi</p> // prose\nawait requireOperator();\n"],
    ["inside a JSX prop", "export const C = () => <Foo onX={() => requireOperator()} />;\n"],
    ["in a template substitution", "const s = `${await requireOperator()}`;\n"],
    ["through a namespace import", "await auth.requireOperator();\n"],
    // In a function body, so `await` is the operator rather than — as it is at
    // the top level of a script — an identifier being called with the guard as
    // its argument, which is a different program and correctly not a match.
    ["parenthesised callee", "async function f() { await (requireOperator)(); }\n"],
    ["next to prose naming it", "// requireOperator()\nawait requireOperator();\n"],
    ["beside a string naming it", 'const s = "requireOperator()"; await requireOperator();\n'],
    ["after a >-leading regex", 'v.replace(/>/g, "x"); await requireOperator();\n'],
    ["after a keyword-named property", "const n = row.in / 2; await requireOperator();\n"],
  ];
  for (const [label, source] of real) {
    assert.equal(calls(GUARD_CALLS, source), true, label);
  }
});

test("no prose carrier changes the verdict on any real source file", () => {
  // The class-level assertion, run over the whole of src/ rather than over the
  // inputs somebody thought to try — which is how every leak in this
  // guardrail's history got in. It is deliberately in the LEAK direction, the
  // one the old token-equivalence sweep could not see at all: adding prose
  // that names a guard, in each carrier that has ever satisfied a rule here,
  // must not turn a file's verdict from false to true.
  //
  // Checked beyond the src/app files the rules walk today: the files that broke
  // the old scanner (src/lib/legal/html.ts, src/lib/auth/) sit outside src/app,
  // and a rule here only has to widen its scope once for that to matter.
  const CARRIERS: ReadonlyArray<readonly [string, string]> = [
    ["line comment", "// requireOperator()\n"],
    ["block comment", "/* guardOperatorRequest() */\n"],
    ["JSDoc", "/** requireOperator() */\nexport const __prose = 1;\n"],
    ["string", 'export const __proseStr = "requireOperator()";\n'],
    ["template literal", "export const __proseTpl = `guardOperatorRequest()`;\n"],
    ["JSX child", "export const __ProseC = () => <p>requireOperator()</p>;\n"],
  ];
  const leaked: string[] = [];
  const blind: string[] = [];
  let checked = 0;
  const visit = (dir: string): void => {
    for (const entry of listDir(dir)) {
      const full = path.join(dir, entry);
      if (isDir(full)) {
        visit(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      const source = `${readSource(full)}\n`;
      const file = path.relative(process.cwd(), full);
      checked += 1;
      const before = calls(GUARD_CALLS, source);
      for (const [label, prose] of CARRIERS) {
        if (calls(GUARD_CALLS, source + prose) !== before) leaked.push(`${file} (${label})`);
      }
      // Paired control: a real appended call must flip every file that did not
      // already call a guard, or this sweep is passing because the predicate
      // answers false to everything.
      if (!calls(GUARD_CALLS, `${source}function __real(): void { requireOperator(); }\n`)) {
        blind.push(file);
      }
    }
  };
  visit(path.join(process.cwd(), "src"));
  assert.deepEqual(
    leaked,
    [],
    "adding prose that merely names a guard changed calls()' verdict on each " +
      "of these, so prose can satisfy the mechanism rules below",
  );
  assert.deepEqual(blind, [], "calls() did not see a real appended call in each of these");
  // Non-vacuity: an empty walk would pass both assertions while proving
  // nothing, which is the trap `the app has routes to check` exists to close.
  assert.ok(checked > 100, `expected the real tree, checked ${checked} files`);
});

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
    .filter((r) => !calls(GUARD_CALLS, r.source));
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
    .filter((f) => !calls(GUARD_CALLS, f.source));
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
      if (!calls(GUARD_CALLS, action.body)) misses.push(`${action.name} (${file.file})`);
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
  /** The name of the call that authorises an action in this file. */
  readonly mechanism: string;
  readonly because: string;
  /** Actions that legitimately need no mechanism, each with its reason. */
  readonly exempt?: Readonly<Record<string, string>>;
}

const PUBLIC_ACTION_GUARDS: readonly PublicActionGuard[] = [
  {
    file: "src/app/setup/actions.ts",
    mechanism: "requireUnclaimed",
    because:
      "First boot. The authorisation is that this instance has no operator yet " +
      "(src/lib/auth/gate.ts); claimOperatorPassword() re-asks the same " +
      "question, so losing this call is not sufficient to claim a claimed " +
      "instance — but losing it silently is what SHA-4458 caught, so it is " +
      "held here too.",
  },
  {
    file: "src/app/login/actions.ts",
    mechanism: "verifyOperatorPassword",
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
    mechanism: "isSendTokenShape",
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
      if (calls([guard.mechanism], action.body)) continue;
      if (guard.exempt !== undefined && action.name in guard.exempt) continue;
      misses.push(`${action.name} (${guard.file}) needs ${guard.mechanism}()`);
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
      calls([guard.mechanism], file.source),
      `${guard.file} declares ${guard.mechanism}() but never calls it`,
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
