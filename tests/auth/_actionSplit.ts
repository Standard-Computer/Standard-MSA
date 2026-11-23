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
//   2. A file that reaches this check and yields *no* recognised action is a
//      failure naming the file, not a silent pass. That is what makes the next
//      unanticipated syntax loud instead of invisible — and it is not
//      hypothetical either: under an export-keyed matcher embed/page.tsx was
//      already contributing zero checked sites while reporting zero misses.
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
 * Capture groups, in order: 1 = family A export prefix, 2 = family A name,
 * 3 = family B export prefix, 4 = family C export prefix, 5 = family C name.
 */
const SITE_PATTERN =
  /^(export default |export )?(?:async function|function) (\w+)|^(export default )(?:async function|function|async) ?\(|^(export )?(?:const|let|var) (\w+) ?= ?(?:async\b|function\b|\(|<|\w+ ?=>)/;

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

/** Collapse space/tab runs so SITE_PATTERN can use literal single spaces. */
function squeeze(line: string): string {
  return line.replace(/[\t ]+/g, " ").trimStart();
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
  let offset = 0;
  for (const raw of source.split("\n")) {
    const match = SITE_PATTERN.exec(squeeze(raw));
    if (match !== null) {
      // Exactly one family's groups participate in any single match; an
      // anonymous default export captures no name.
      const name = match[2] ?? match[5] ?? "";
      sites.push({
        name: name === "" ? "default" : name,
        exported: (match[1] ?? match[3] ?? match[4]) !== undefined,
        start: offset,
        depth: raw.length - raw.trimStart().length,
      });
    }
    offset += raw.length + 1; // the newline split() consumed
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
