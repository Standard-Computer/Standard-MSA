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
 * This asks the TypeScript parser where the comments are instead of scanning
 * for them by hand. The scanner that used to live here took four rounds to not
 * quite work, each one adding a shape to an exclusion list:
 *
 *   1. `/["]/` — an unpaired quote in a character class — flipped it into
 *      string mode, and every comment after it in the file leaked through as
 *      code (SHA-4469). That line is real: src/lib/legal/html.ts:15.
 *   2. Teaching it regex literals made `</div>` and `<Foo />` open regex mode,
 *      where `//` is not a comment opener, so a trailing comment on a JSX line
 *      leaked instead.
 *   3. Excluding those two JSX shapes made a regex that *starts* with `>` —
 *      `/>/g`, the idiomatic sibling of that html.ts line — refuse its own
 *      opener and leak (SHA-4472).
 *   4. The prototype for 3 still leaked on `if (a < b) v.replace(/>/g, "x");`,
 *      because a `<` anywhere earlier on the line looks like an open tag.
 *
 * The cause was the same every round: whether a `/` opens a regex or divides
 * depends on a parse the scanner was not doing. The parser does that parse, so
 * the class is gone rather than enumerated, and `typescript` is already a
 * devDependency so this costs no new install. The invariant that replaces the
 * old terminal-mode sweep is below: stripping must not change a single token
 * the parser can see.
 *
 * Comments are blanked to spaces rather than removed, so offsets and line
 * numbers still line up for any future failure message, and two identifiers
 * separated by a block comment cannot merge into one token.
 *
 * Strings, template literals and regex literals keep their contents, since a
 * call is a call. So do JSX children, where a `//` is ordinary text.
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
 * Every comment range in `source`, and nothing else.
 *
 * A comment is leading trivia of the token after it, or trailing trivia of the
 * token before it when it sits on that token's line, so both are collected at
 * every token. Inside JSX children a `//` is text rather than a comment, so
 * ranges landing in a JsxText span are dropped.
 */
function commentRanges(source: string): readonly ts.CommentRange[] {
  const sf = parseSource(source);
  const found = new Map<number, ts.CommentRange>();
  const jsxText: Array<readonly [number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.getStart(sf), node.getEnd()]);
    for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
      found.set(range.pos, range);
    }
    for (const range of ts.getTrailingCommentRanges(source, node.getEnd()) ?? []) {
      found.set(range.pos, range);
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return [...found.values()].filter(
    (range) => !jsxText.some(([start, end]) => range.pos >= start && range.pos < end),
  );
}

function stripComments(source: string): string {
  let out = source;
  for (const range of commentRanges(source)) {
    const blanked = source.slice(range.pos, range.end).replace(/[^\n]/gu, " ");
    out = out.slice(0, range.pos) + blanked + out.slice(range.end);
  }
  return out;
}

/**
 * Every token the parser can see — which is all the rules below are entitled
 * to read.
 *
 * JSDoc nodes are skipped whole: the parser materialises them as children of
 * the declaration they document, and they are exactly what stripping removes.
 */
function significantTokens(source: string): readonly string[] {
  const sf = parseSource(source);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isJsDoc(node)) return;
    const children = node.getChildren(sf);
    if (children.length === 0 && node.getEnd() > node.getStart(sf)) {
      out.push(`${node.kind}:${node.getText(sf)}`);
    }
    for (const child of children) visit(child);
  };
  visit(sf);
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

test("stripComments knows a regex literal from a comment and from division", () => {
  // SHA-4469. An unpaired quote inside a character class used to flip the
  // stripper into string mode for the rest of the file, so prose after it
  // satisfied the mechanism rules. The exact shape, and the real line that
  // carries it (src/lib/legal/html.ts:15):
  assert.equal(
    stripComments('const re = /["]/g;\n// requireOperator()\n').includes("requireOperator"),
    false,
  );
  assert.equal(
    stripComments('value.replace(/[&<>"\']/g, f);\n/* requireOperator() */\n')
      .includes("requireOperator"),
    false,
  );
  // A `/` inside a character class is not the terminator.
  assert.equal(
    stripComments("const re = /[/]/;\n// requireOperator()\n").includes("requireOperator"),
    false,
  );
  // An escaped slash is not the terminator either.
  assert.equal(
    stripComments("const re = /a\\/b/;\n// requireOperator()\n").includes("requireOperator"),
    false,
  );
  // Division must NOT be read as a regex opener, or the code after it is eaten.
  assert.equal(stripComments("const n = a / b; await requireOperator();")
    .includes("requireOperator"), true);
  assert.equal(stripComments("const n = (a + b) / 2; await requireOperator();")
    .includes("requireOperator"), true);
  assert.equal(stripComments("const n = xs[0] / 2; await requireOperator();")
    .includes("requireOperator"), true);
  // A regex after a keyword is still a regex.
  assert.equal(stripComments('return /["]/.test(s);\n// requireOperator()\n')
    .includes("requireOperator"), false);
  // The call survives when it follows a regex literal — the point of the mode
  // is to resume code, not to swallow what comes next.
  assert.equal(stripComments('if (/["]/.test(s)) await requireOperator();')
    .includes("requireOperator"), true);
  // A comment opener inside a regex is not a comment.
  assert.equal(stripComments("const re = /\\/\\//; await requireOperator();")
    .includes("requireOperator"), true);
});

test("a trailing comment is stripped whatever the line puts in front of it", () => {
  // Every entry here leaked through as code at some point in this guardrail's
  // history, and a leak is what lets prose satisfy a mechanism rule. They are
  // kept as a table because the lesson of SHA-4469 and SHA-4472 is that the
  // next shape is not the last one — adding it should be one line.
  const leaks: ReadonlyArray<readonly [string, string]> = [
    ["JSX closing tag", "<p>hi</p> // requireUnclaimed()\nconst a = 1;\n"],
    ["JSX self-closing tag", "<Foo a={x} /> // requireUnclaimed()\nconst a = 1;\n"],
    ["JSX closer, block comment", "<p>hi</p> /* requireUnclaimed() */\nconst a = 1;\n"],
    ["JSX closer after a call", "<p>{f()}</p> // requireUnclaimed()\n"],
    ["JSX expression container", "<p>{/* requireUnclaimed() */}</p>\n"],
    // SHA-4472: a regex whose first character is `>` has the `<Foo />` shape.
    ["regex starting with >", 'v.replace(/>/g, "&gt;"); // requireUnclaimed()\n'],
    ["regex starting with >=", 'if (/>=/.test(s)) f(s); // requireUnclaimed()\n'],
    // ...and a `<` earlier on the line does not make the one after it a tag.
    ["< compare, then that regex", 'if (a < b) v.replace(/>/g, "x"); // requireUnclaimed()\n'],
    ["generic call, then that regex", 'f<string>(x); v.replace(/>/g, "y"); // requireUnclaimed()\n'],
    // A property named with a keyword is not a keyword, so this is division.
    ["keyword-named property", "const r = row.in / 2; // requireUnclaimed()\n"],
    ["another one", "const r = counts.delete / 2; // requireUnclaimed()\n"],
    ["quote in a character class", 'const re = /["]/g;\n// requireUnclaimed()\n'],
  ];
  for (const [label, source] of leaks) {
    assert.equal(stripComments(source).includes("requireUnclaimed"), false, label);
  }
  // The paired controls: none of the above may cost a real call. A stripper
  // that eats code fails these, and a rule that stops seeing its call is just
  // as broken as one a comment can satisfy.
  const keeps: ReadonlyArray<readonly [string, string]> = [
    ["after a JSX self-closing tag", "<Foo a={x} /> // prose\nawait requireOperator();\n"],
    ["after a JSX closing tag", "<p>hi</p> // prose\nawait requireOperator();\n"],
    ["inside a JSX prop", "<Foo onX={() => requireOperator()} />\n"],
    ["after a >-leading regex", 'v.replace(/>/g, "x"); await requireOperator();\n'],
    ["after a keyword-named property", "const n = row.in / 2; await requireOperator();\n"],
  ];
  for (const [label, source] of keeps) {
    assert.equal(stripComments(source).includes("requireOperator"), true, label);
  }
});

test("stripping a real source file changes no token the parser can see", () => {
  // The class-level assertion, and the one the old hand-rolled scanner could
  // not carry (SHA-4469, SHA-4472).
  //
  // Every rule in this file matches against stripped source, so two things can
  // go wrong: a comment survives and satisfies a rule as though it were code,
  // or real code is eaten and a rule silently stops seeing the call it checks.
  // Both change the token stream. Comparing each file's tokens against the
  // tokens of its stripped self therefore catches either one, for any shape,
  // rather than for the inputs somebody thought to try — which is how all four
  // leaks in this guardrail's history got in.
  //
  // Checked over the whole of src/, not just the src/app files the rules walk
  // today: the files that broke the old scanner (src/lib/legal/html.ts,
  // src/lib/auth/) sit outside src/app, and a rule here only has to widen its
  // scope once for that to matter.
  const offenders: string[] = [];
  let checked = 0;
  const visit = (dir: string): void => {
    for (const entry of listDir(dir)) {
      const full = path.join(dir, entry);
      if (isDir(full)) {
        visit(full);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      const source = readSource(full);
      checked += 1;
      const before = significantTokens(source).join("\n");
      const after = significantTokens(stripComments(source)).join("\n");
      if (before !== after) offenders.push(path.relative(process.cwd(), full));
    }
  };
  visit(path.join(process.cwd(), "src"));
  assert.deepEqual(
    offenders,
    [],
    "tests/auth/coverage.test.ts stripComments() changed the code of each of " +
      "these files, so every rule here that reads them is unreliable — it " +
      "either leaked a comment as code or ate code as a comment",
  );
  // Non-vacuity: an empty walk would pass the assertion above while proving
  // nothing, which is the trap `the app has routes to check` exists to close.
  assert.ok(checked > 100, `expected the real tree, checked ${checked} files`);
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
