// The per-action guard split (SHA-3067).
//
// coverage.test.ts asserts that every *exported* server action calls the
// operator guard itself, because one guard at the top of a file protects one
// action and not its neighbours. Getting the split wrong is how an unguarded
// action hides in plain sight: the original matcher was
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
// Two rules keep it from coming back:
//
//   1. One matcher covers every export form, rather than one syntax each
//      time somebody notices a new one.
//   2. A file with exports where this matcher recognises *nothing* is a
//      failure naming the file, not a silent pass. That is what makes the
//      next unanticipated syntax loud instead of invisible.
//
// Pure string in, array out — no fs, no DB, no server-only imports — so
// _actionSplit.test.ts can cover the forms from fixtures without mutating app
// source.

export interface ActionExport {
  /** The exported binding's name; `default` for a default export. */
  readonly name: string;
  /**
   * The source from this export site up to the next one, or to EOF for the
   * last. The body is bounded by the next *site* rather than by a close brace
   * on purpose: a brace terminator is itself syntax-specific — a function
   * declaration ends `\n}` but an arrow action ends `\n};` — so brace-hunting
   * is exactly how a fourth syntax would slip through again. Sites are
   * syntax-agnostic.
   */
  readonly body: string;
}

/**
 * Every export form that can declare a server action, with the bound name:
 *
 *   1. `export async function N(…)` and `export function N(…)`
 *   2. `export const|let|var N = async (…) => {…}` / `= async function (…) {…}`
 *   3. `export default [async] function [N](…)` and `export default async (…) =>`
 *
 * Deliberately *not* matched, because they cannot be a server action:
 * `export type` / `export interface` (erased at compile time) and non-async
 * value exports such as `export const dynamic = "force-dynamic"`.
 *
 * `async function` is spelled as an alternation rather than the shorter
 * `(?:async\s+)?function`, which puts `\s+` inside an optional group and so
 * trips `security/detect-unsafe-regex` on star height. Capture groups, in
 * order: 1 = declaration name, 2 = `const`/`let`/`var` name, 3 = default
 * export name (empty when anonymous).
 */
const EXPORT_SITE =
  /^export\s+(?:async\s+function|function)\s+(\w+)|^export\s+(?:const|let|var)\s+(\w+)\s*=\s*async\b|^export\s+default\s+(?:(?:async\s+function|function)\s*(\w*)|async\s*\()/gm;

/** `export type` / `export interface` — a type-only export is never an action. */
const TYPE_ONLY_EXPORT = /^export\s+(?:type|interface)\b/;

/**
 * Split `source` into one entry per exported action, in source order.
 *
 * `matchAll` is used rather than `exec` in a loop so the module-level `/g`
 * regex keeps its `lastIndex` at 0 between calls.
 */
export function splitActionExports(source: string): readonly ActionExport[] {
  const sites = [...source.matchAll(EXPORT_SITE)].map((match) => {
    // Exactly one alternative's group participates in any single match; an
    // anonymous `export default function (…)` captures the empty string.
    const captured = match[1] ?? match[2] ?? match[3] ?? "";
    return { name: captured === "" ? "default" : captured, start: match.index };
  });

  return sites.map((site, i) => ({
    name: site.name,
    body: source.slice(site.start, sites[i + 1]?.start ?? source.length),
  }));
}

/**
 * Does `source` export anything that could have been an action?
 *
 * Pairs with {@link splitActionExports}: exports present but no site
 * recognised means this matcher does not understand the syntax in use, which
 * has to fail loudly rather than pass vacuously. Type-only exports are
 * excluded so a file whose only export is an `export type` is not reported as
 * an unrecognised action.
 */
export function declaresExport(source: string): boolean {
  return source
    .split("\n")
    .some((line) => /^export\b/.test(line) && !TYPE_ONLY_EXPORT.test(line));
}
