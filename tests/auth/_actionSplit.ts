// The per-action guard split (SHA-3067).
//
// coverage.test.ts asserts that every server action calls the operator guard
// itself, because one guard at the top of a file protects one action and not
// its neighbours. Getting the split wrong is how an unguarded action hides in
// plain sight: the original matcher was
//
//   file.source.split(/^export async function /m)
//
// so only `export async function name(` was ever checked individually. An
// action written `export const fooAction = async (…) => {…}` produced no part
// at all, and the file-level test stayed green because it only needs one
// `requireOperator(` anywhere in the file — a guarded neighbour was enough to
// hide it. That is not hypothetical: `useActionState` (CreateKeyForm, PR #8)
// is the pattern that pairs with arrow actions.
//
// The unit here is a server-action *function body*, not an exported symbol.
// Keying off the export list looks equivalent and is not: src/app/embed/page.tsx
// declares `saveSettings` as a module-local `async function` carrying its own
// inline `"use server"` and passes it straight to `<form action={saveSettings}>`,
// so it is a live POST endpoint with no exported name. An export-keyed matcher
// can never see it.
//
// A declaration site is a server action when either
//
//   1. the module carries a file-level `"use server"` and the site is
//      exported — in such a module every export is an action by definition; or
//   2. the site's own body carries an inline `"use server"`, exported or not.
//
// Local helpers (`finish`, `text`, `recipientFrom` …) satisfy neither and are
// deliberately not graded — but a module-level one still bounds the body of
// the site above it, which is what keeps a guard call in a trailing helper
// from being miscredited to the action before it. Indentation is what tells
// those apart from a declaration *inside* an action, which must not bound
// anything; see ActionSite.body.
//
// Two rules keep the gap from coming back:
//
//   1. One matcher covers every declaration form, rather than one syntax each
//      time somebody notices a new one.
//   2. Every depth-0 export the matcher cannot resolve to a graded site is
//      reported by name, not silently dropped — findUngradedExports. This is
//      the rule that makes the next unanticipated syntax loud, and it has to be
//      per-export: a per-*file* "nothing recognised" clause only defends the
//      all-or-nothing case, which is the case that does not occur. Every
//      operator action file in this repo has at least one recognised site, so
//      an unrecognised `export const purgeAction: ServerAction = async () =>`
//      beside a recognised neighbour yielded one checked site and zero misses —
//      the original gap, one syntax over.
//
// Rule 2 has to cover the *lexer* as well as the matcher, which is the part
// that was missing: lines dropped as template-literal interior produced no site
// and no export, so one unpaired backtick in a comment switched the rule off
// without a word. A dropped export, and a source that ends mid-literal, are
// both reported now. See scanSource.
//
// Pure string in, array out — no fs, no DB, no server-only imports — so
// _actionSplit.test.ts can cover the forms from fixtures without mutating app
// source.

export interface ActionSite {
  /** The declared name; `default` for an anonymous default export. */
  readonly name: string;
  /** Is the declaration exported? Clause 1 above needs this. */
  readonly exported: boolean;
  /** Does the body carry its own `"use server"`? Clause 2 above needs this. */
  readonly inlineDirective: boolean;
  /**
   * The source from this declaration site up to the next site at the same or
   * shallower indentation, or to EOF for the last. The body is bounded by a
   * *site* rather than by a close brace on purpose: a brace terminator is
   * itself syntax-specific — a function declaration ends `\n}` but an arrow
   * action ends `\n};` — so brace-hunting is exactly how the next syntax
   * would slip through again. Sites are syntax-agnostic.
   *
   * Indentation is what keeps a declaration *inside* the action from ending
   * it. Every local is a site — family C matches any parenthesised
   * initialiser, so `const n = (count ?? 0) + 1;` is one — and bounding on
   * the merely-next site attributed a guard call below such a line to the
   * local instead of to the action, reporting a correctly guarded action as
   * unguarded. A nested declaration is deeper than its action and so cannot
   * bound it; a trailing module-level helper is at column 0 and still does.
   */
  readonly body: string;
}

/**
 * Every declaration form that can hold a server action, with the bound name.
 * Matched against one source line at a time, after runs of spaces and tabs
 * have been squeezed to a single space, so the patterns can be spelled with
 * literal spaces. That is not cosmetic: `(?:async\s+)?function` nests `\s+`
 * inside an optional group, which raises the star height and trips
 * `security/detect-unsafe-regex`. No quantifier here sits inside another.
 *
 * The alternatives are grammatical families, not one-per-syntax special cases:
 *
 *   A. a named function declaration — `[export [default]] [async] function N`,
 *      at any indentation, which covers the four exported forms and the
 *      module-local inline-directive form;
 *   B. an anonymous default export — `export default [async] function (` and
 *      `export default async (`;
 *   C. a function bound to a value declaration — `[export] const|let|var N =`
 *      followed by something that starts a function: `async`, `function`, an
 *      arrow parameter list, or a generic parameter list.
 *
 * Clause C's right-hand side is restricted to function starts so that the
 * non-action value exports already in the repo never become phantom sites:
 * `export const dynamic = "force-dynamic"` binds a string. `export type` and
 * `export interface` match nothing here at all — a type is erased at compile
 * time and can never be an action.
 *
 * Clause C sees an annotated binding because `squeeze` removes the annotation
 * first; see ANNOTATION for why that is a separate pass and not an optional
 * group here.
 *
 * Capture groups, in order: 1 = family A export prefix, 2 = family A name,
 * 3 = family B export prefix, 4 = family C export prefix, 5 = family C name.
 */
const SITE_PATTERN =
  /^(export default |export )?(?:async function|function) (\w+)|^(export default )(?:async function|function|async) ?\(|^(export )?(?:const|let|var) (\w+) ?= ?(?:async\b|function\b|\(|<|\w+ ?=>)/;

/**
 * A type annotation on a value declaration, rewritten away before matching.
 *
 * `export const purgeAction: ServerAction = async () => {…}` is a server
 * action, and clause C's `(\w+) ?= ?` could not see it — the annotation sits
 * between the name and the `=`. The repo already writes that shape for
 * non-actions (`export const metadata: Metadata` in layout.tsx and
 * login/page.tsx), so it is a question of when, not if.
 *
 * Normalising here rather than widening SITE_PATTERN is deliberate: the
 * natural spelling `(?:: ?[^=]*)?` nests a quantifier inside an optional
 * group, which raises the star height to 2 and trips
 * `security/detect-unsafe-regex`. This replacement is flat.
 *
 * `[^=]*` cannot cross an `=`, so a *function*-type annotation
 * (`const f: (a: A) => void = …`) is not normalised cleanly and does not
 * become a site. That shape stays caught, by findUngradedExports rather than
 * by the matcher — which is the whole reason the loudness rule is per-export.
 */
const ANNOTATION = /^((?:export )?(?:const|let|var) \w+) ?:[^=]*= ?/;

/** A `"use server"` directive, module-level or inline, as a trimmed line. */
const DIRECTIVE = /^["']use server["'];/;

interface DeclarationSite {
  readonly name: string;
  readonly exported: boolean;
  /** Offset of the start of the declaration's line in the source. */
  readonly start: number;
  /** Indentation columns before the declaration keyword. */
  readonly depth: number;
}

/** A source line that is real code, not the interior of a template literal. */
interface CodeLine {
  /** Space/tab runs squeezed to one, left-trimmed, annotation removed. */
  readonly text: string;
  /** Offset of the start of the line in the source. */
  readonly start: number;
  /** Indentation columns before the first non-space character. */
  readonly depth: number;
}

/** A depth-0 `export …` line the scan dropped as template-literal interior. */
interface DroppedExport {
  /** Squeezed text of the line, so the published name can still be read off it. */
  readonly text: string;
  /** 1-based line number, for a failure message that says where to look. */
  readonly line: number;
}

/** What one pass over the source yields: the real code, and what it dropped. */
interface SourceScan {
  readonly lines: readonly CodeLine[];
  readonly droppedExports: readonly DroppedExport[];
  /** Did the source end inside a template literal? That is always a desync. */
  readonly unterminated: boolean;
}

/** `export` used as a statement keyword — `export …` or `export{…}`. */
const EXPORT_STATEMENT = /^export[ {]/;

/**
 * Reported instead of a name when the source ends inside a template literal.
 *
 * There is no export to name in that case — the desync has swallowed the rest
 * of the file — so the file itself is what gets reported. coverage.test.ts
 * formats this entry on its own terms; see findUngradedExports.
 */
export const UNTERMINATED_TEMPLATE = "<source ends inside a template literal>";

/**
 * Collapse space/tab runs so SITE_PATTERN can use literal single spaces, and
 * drop any type annotation so clause C can reach the initialiser.
 */
function squeeze(line: string): string {
  return line.replace(/[\t ]+/g, " ").trimStart().replace(ANNOTATION, "$1 = ");
}

/**
 * One pass over `source`, separating real code from template-literal interior.
 *
 * Column-0 lines *inside* a template literal must yield neither a site nor a
 * bound. A dedented HTML or script literal is ordinary in this repo — both
 * sends/notices/actions.ts and settings/email/actions.ts send mail — and a
 * line like `const tracker = (id) => id;` in one is a clause-C site at depth 0,
 * so it ended the enclosing action's body before its guard call and reported a
 * correctly guarded action as unguarded.
 *
 * Parity is counted per line over backticks that are not backslash-escaped,
 * with one exception: outside a literal, a line whose squeezed text starts with
 * `//` is a comment and its backticks are prose. Inside a literal the very same
 * line is literal text, where a backtick may well be the closing one, so the
 * exception cannot apply there. It is not cosmetic — a backticked identifier
 * wrapped across two comment lines is ordinary writing in this repo, and it is
 * the entire live divergence on main: measured over all 131 .ts/.tsx files the
 * exception changes the classification of exactly two lines,
 * src/lib/legal/embedDocument.ts:27 and src/lib/legal/embedRoutes.ts:11, and
 * nothing else. Stripping `//` from the *middle* of a line is deliberately not
 * done, because a `https://…` URL inside a mail template is the common case
 * there and would be misread as a comment.
 *
 * A backtick in a quoted string still desyncs the count. That is an accepted
 * limit of a line-based matcher — a tokenizer is the wrong trade for a test
 * helper, and the two hand-written ones tried on this problem each had their
 * own bugs (a `"` inside a regex literal read as a string; no re-entry into
 * code state inside `${…}`). What is *not* accepted is failing quietly.
 *
 * An earlier revision of this comment claimed a desync "fails toward the old
 * behaviour (a spurious bound, i.e. a false red somebody has to look at) rather
 * than toward a silent miss". Measured, it is the reverse, and strictly worse:
 * one unpaired backtick flips `inTemplate` on and every following line is
 * dropped, which yields no site *and* no export, so findUngradedExports goes
 * blind along with the matcher and an unguarded action behind a guarded
 * neighbour reads green. That is the card's original failure mode exactly,
 * reached through the lexer instead of the matcher — and it is the one path
 * that escaped rule 2 of the header.
 *
 * So the drop is made loud rather than reasoned about:
 *
 *   - a dropped depth-0 `export …` line is kept in `droppedExports`, and
 *   - a source that ends inside a literal sets `unterminated`,
 *
 * both of which findUngradedExports reports. A desync in either direction and
 * from any cause — comment, string, block comment, something nobody here
 * thought of — is then a red somebody reads, which is the property the old
 * comment asserted without holding.
 *
 * Offsets advance over skipped lines, so a literal stays inside the body of
 * whatever declaration encloses it.
 */
function scanSource(source: string): SourceScan {
  const lines: CodeLine[] = [];
  const droppedExports: DroppedExport[] = [];
  let offset = 0;
  let inTemplate = false;
  let lineNumber = 0;
  for (const raw of source.split("\n")) {
    lineNumber += 1;
    const text = squeeze(raw);
    const depth = raw.length - raw.trimStart().length;
    if (inTemplate) {
      // Dropped, but not silently: rule 2 has to reach this path too.
      if (depth === 0 && EXPORT_STATEMENT.test(text)) {
        droppedExports.push({ text, line: lineNumber });
      }
    } else {
      lines.push({ text, start: offset, depth });
    }
    const counted = inTemplate || !text.startsWith("//") ? raw : "";
    const ticks = (counted.replace(/\\./g, "").match(/`/g) ?? []).length;
    if (ticks % 2 === 1) inTemplate = !inTemplate;
    offset += raw.length + 1; // the newline split() consumed
  }
  return { lines, droppedExports, unterminated: inTemplate };
}

/**
 * Does the module open with `"use server"`?
 *
 * This is the file-level directive that makes every export an action, so it
 * has to be the module's first statement — an *indented* `"use server"` deeper
 * in the file is an inline directive on one function and says nothing about
 * the file's exports. Leading comments and blank lines are skipped, since a
 * directive is still module-level when a licence header precedes it.
 */
export function hasModuleDirective(source: string): boolean {
  let inBlockComment = false;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    return DIRECTIVE.test(line);
  }
  return false;
}

/** Every declaration site in source order, graded or not. */
function findDeclarationSites(source: string): DeclarationSite[] {
  const sites: DeclarationSite[] = [];
  for (const line of scanSource(source).lines) {
    const match = SITE_PATTERN.exec(line.text);
    if (match === null) continue;
    // Exactly one family's groups participate in any single match; an
    // anonymous default export captures no name.
    const name = match[2] ?? match[5] ?? "";
    sites.push({
      name: name === "" ? "default" : name,
      exported: (match[1] ?? match[3] ?? match[4]) !== undefined,
      start: line.start,
      depth: line.depth,
    });
  }
  return sites;
}

/**
 * Does this declaration carry its own `"use server"`?
 *
 * Read from the span up to the next site at *any* depth, not from the
 * indentation-bounded body: the directive is a property of this declaration
 * alone, and an inline-directive action nested in a component would otherwise
 * make its enclosing function look like an action too. A directive is always
 * the first statement of the function it applies to, so the narrow span
 * always contains it. The site's own first line is skipped so a signature can
 * never be mistaken for a directive.
 */
function carriesInlineDirective(span: string): boolean {
  const [, ...rest] = span.split("\n");
  return rest.some((line) => DIRECTIVE.test(line.trim()));
}

/**
 * Every server action declared in `source`, in source order.
 *
 * `SITE_PATTERN` carries no `/g` flag and is driven line by line, so it holds
 * no `lastIndex` between calls — coverage.test.ts calls this once per file.
 */
export function findActionSites(source: string): readonly ActionSite[] {
  const moduleDirective = hasModuleDirective(source);
  const sites = findDeclarationSites(source);
  return sites
    .map((site, i) => {
      // Guard attribution reaches to the next site that is not nested inside
      // this one; the directive is read from the narrow span. See ActionSite
      // and carriesInlineDirective for why the two bounds differ.
      const encloser = sites.slice(i + 1).find((next) => next.depth <= site.depth);
      const body = source.slice(site.start, encloser?.start ?? source.length);
      return {
        name: site.name,
        exported: site.exported,
        inlineDirective: carriesInlineDirective(
          source.slice(site.start, sites[i + 1]?.start ?? source.length),
        ),
        body,
      };
    })
    .filter((site) => (site.exported && moduleDirective) || site.inlineDirective);
}

/** `export type|interface|enum` — erased at compile time, never an action. */
const EXPORTED_TYPE = /^export (?:type|interface|enum)\b/;

/** `export * from "…"` / `export * as ns from "…"`. */
const EXPORT_ALL = /^export \*/;

/** `export { a, b as c }`, with or without a `from` clause. */
const EXPORT_CLAUSE = /^export ?\{([^}]*)\}/;

/** `export const|let|var { a, b } = …` — a destructured binding list. */
const DESTRUCTURED_BINDING = /^export (?:const|let|var) \{([^}]*)\}/;

/** `export [default] [async] function NAME`. */
const EXPORTED_FUNCTION = /^export (?:default )?(?:async )?function (\w+)/;

/** The `export const|let|var ` head of a value declaration, without its names. */
const VALUE_DECLARATION = /^export (?:const|let|var) /;

/**
 * An initialiser that is a plain value rather than anything callable.
 *
 * This is what keeps the Next route segment options and the annotated object
 * literals already on main quiet: `export const dynamic = "force-dynamic"`,
 * `export const metadata: Metadata = {…}`. A string, number, boolean, `null`,
 * `undefined`, object or array literal cannot be a server action.
 */
const PLAIN_LITERAL = /^(?:["'`]|-?\d|true\b|false\b|null\b|undefined\b|\{|\[)/;

/**
 * The initialiser of a value declaration: everything past the assignment `=`.
 *
 * The first `=` that is not the head of an arrow `=>` is the assignment, which
 * is what makes this work on an annotation the ANNOTATION pass could not
 * rewrite — `const f: (a: A) => void = fn` yields `fn`, not `> void = fn`.
 */
function initialiserOf(text: string): string {
  const assignment = /=(?!>)/.exec(text);
  return assignment === null ? "" : text.slice(assignment.index + 1).trim();
}

/** One declarator of a value declaration: the name it binds and its value. */
interface Declarator {
  readonly name: string;
  readonly initialiser: string;
}

/**
 * Split on the commas of `text` that are at bracket depth 0 and unquoted.
 *
 * Written as a scan rather than a regex because the thing being matched is
 * nesting, which a regex cannot count. `<` and `>` are deliberately *not*
 * treated as brackets: in TypeScript they are ambiguous between type arguments
 * and the head of an arrow `=>`, so counting them drifts. Depth is clamped at
 * zero for the same reason — a stray closer must not make the rest of the line
 * look like it is at a negative depth, which would hide a real comma.
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== "") {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.filter((part) => part.trim() !== "");
}

/**
 * Every declarator of a value declaration, given the text after its keyword.
 *
 * A single `export const` statement can bind more than one name, and the
 * PLAIN_LITERAL skip below has to be applied per *declarator* rather than per
 * line. Per line it was a second silent miss, in the same class as the lexer
 * desync above:
 *
 *   export const LIMIT = 1,
 *     purgeAction = async () => { await prisma.send.deleteMany(); };
 *
 * The first declarator's initialiser is a plain literal, so the whole line was
 * skipped — taking its sibling with it — while the sibling's own line sits at
 * depth 2 where the depth-0 loop never looks. One unguarded action, reported as
 * nothing at all. Splitting the statement means `LIMIT` stays quiet on its own
 * merits and `purgeAction` is reported on its own merits.
 */
function declaratorsOf(declaration: string): Declarator[] {
  return splitTopLevel(declaration).map((part) => ({
    name: /^\w+/.exec(part.trim())?.[0] ?? "",
    initialiser: initialiserOf(part),
  }));
}

/** The names a single depth-0 `export …` statement publishes, in source order. */
function exportedNames(text: string): string[] {
  if (!EXPORT_STATEMENT.test(text) || EXPORTED_TYPE.test(text)) return [];
  if (EXPORT_ALL.test(text)) return ["*"];
  // `x as y` publishes y but the declaration to fix is x, so name the local.
  // A `type` entry — `export { type Row, saveAction }` — is erased, as above.
  const clause = EXPORT_CLAUSE.exec(text) ?? DESTRUCTURED_BINDING.exec(text);
  if (clause !== undefined && clause !== null) {
    return clause[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => !entry.startsWith("type "))
      .map((entry) => entry.split(" ")[0] ?? "")
      .filter((name) => /^\w+$/.test(name));
  }
  const named = EXPORTED_FUNCTION.exec(text);
  if (named !== null) return [named[1] ?? ""];
  const declaration = VALUE_DECLARATION.exec(text);
  if (declaration !== null) {
    // Per declarator, not per line: a plain-literal sibling must not silence a
    // callable one. See declaratorsOf.
    return declaratorsOf(text.slice(declaration[0].length))
      .filter((bound) => !PLAIN_LITERAL.test(bound.initialiser))
      .map((bound) => bound.name)
      .filter((name) => name !== "");
  }
  // `export default <expression>`, and anonymous `export default function (`.
  return text.startsWith("export default") ? ["default"] : [];
}

/**
 * Does this `export …` statement publish nothing that could hide an action?
 *
 * Only needed to tell the two reasons exportedNames returns nothing apart: a
 * type-only export and an all-plain-literal declaration genuinely publish no
 * callable, whereas a statement this helper does not understand publishes
 * something unknown. On the dropped-line path that difference decides between
 * staying quiet and reporting the line, so it cannot be left to emptiness.
 */
function publishesNothing(text: string): boolean {
  if (EXPORTED_TYPE.test(text)) return true;
  const declaration = VALUE_DECLARATION.exec(text);
  if (declaration === null) return false;
  const bound = declaratorsOf(text.slice(declaration[0].length));
  return bound.length > 0 && bound.every((one) => PLAIN_LITERAL.test(one.initialiser));
}

/**
 * Does this depth-0 statement run onto the next line carrying a name with it?
 *
 * Two statements here can. Prettier breaks a long `export { … }` list over
 * several lines, and a multi-declarator value declaration puts each declarator
 * on its own line. Either way the continuation is indented, so the depth-0 loop
 * never visits it by itself, and the name it carries would be a silent miss of
 * exactly the kind this rule exists to stop. A trailing comma is what marks a
 * value declaration as unfinished: a declaration that ends `[` or `{` is a
 * multi-line literal, whose interior binds nothing.
 */
function statementContinues(text: string): boolean {
  if (/^export ?\{/.test(text) && !text.includes("}")) return true;
  return VALUE_DECLARATION.test(text) && text.trimEnd().endsWith(",");
}

/**
 * Depth-0 exports of a `"use server"` module that resolve to no graded action.
 *
 * Rule 2 of the header, and the durable half of this guardrail. The matcher
 * above recognises declaration *forms*; this recognises the fact of an export,
 * which no new syntax can hide. An `export const purgeAction = withLogging(…)`
 * or a `const purgeAction = …; export { purgeAction };` is not a function
 * declaration form and is deliberately not chased with another alternative in
 * SITE_PATTERN — it is reported here instead, and so is whatever shape comes
 * next.
 *
 * Two conditions keep it off everything legitimately ungraded on main:
 *
 *   1. Only modules with a file-level directive. embed/page.tsx carries an
 *      inline `"use server"` on one local function, so its exported page
 *      component is a render path and correctly not an action — demanding a
 *      guard from it is a false red on a real file.
 *   2. Plain literal initialisers and type-only exports are not values that
 *      could be an action. See PLAIN_LITERAL.
 *
 * Reported names are deduplicated: a name is one problem however many lines
 * mention it.
 *
 * Three causes are reported, not one. Besides an export the matcher cannot
 * resolve, a depth-0 export the *scan* dropped as template-literal interior is
 * reported, and a source that ends inside a literal is reported as the file.
 * Those two are the lexer's share of rule 2: without them one unpaired backtick
 * switches this whole function off silently. See scanSource.
 */
export function findUngradedExports(source: string): readonly string[] {
  if (!hasModuleDirective(source)) return [];
  const graded = new Set(findActionSites(source).map((site) => site.name));
  const scan = scanSource(source);
  const loud: string[] = [];
  const report = (name: string): void => {
    if (!graded.has(name) && !loud.includes(name)) loud.push(name);
  };
  const lines = scan.lines;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || line.depth !== 0) continue;
    let text = line.text;
    while (i + 1 < lines.length && statementContinues(text)) {
      i += 1;
      text += ` ${lines[i]?.text ?? ""}`;
    }
    for (const name of exportedNames(text)) report(name);
  }
  // A dropped line still names what it published, so report the name where
  // there is one and the line where there is not.
  for (const dropped of scan.droppedExports) {
    const names = exportedNames(dropped.text);
    for (const name of names) report(name);
    if (names.length === 0 && !publishesNothing(dropped.text)) {
      loud.push(`<export skipped as template interior: line ${dropped.line}>`);
    }
  }
  if (scan.unterminated) loud.push(UNTERMINATED_TEMPLATE);
  return loud;
}
