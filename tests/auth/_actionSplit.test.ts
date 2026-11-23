// Fixtures for the per-action guard split (SHA-3067).
//
// coverage.test.ts proves the split against the real app, which means it can
// only ever cover the forms the app happens to use today — every exported
// action in the repo is `export async function`, so the arrow-action gap was
// invisible there. These fixtures cover each form directly, as permanent
// regression cover that does not require mutating app source to demonstrate.
//
// Pure string in, array out: no fs, no DB, no server-only imports.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  findActionSites,
  findUngradedExports,
  hasModuleDirective,
  UNTERMINATED_TEMPLATE,
} from "./_actionSplit";

/** The same guard matcher coverage.test.ts applies to each body. */
const GUARD_CALL = /\b(requireOperator|guardOperatorRequest)\s*\(/;

/** Names of the actions `source` declares, in source order. */
function names(source: string): string[] {
  return findActionSites(source).map((action) => action.name);
}

/** Names of the actions in `source` whose body carries no guard call. */
function unguarded(source: string): string[] {
  return findActionSites(source)
    .filter((action) => !GUARD_CALL.test(action.body))
    .map((action) => action.name);
}

/**
 * Everything coverage.test.ts would report for `source`, either way round.
 *
 * An unrecognised export is reported by findUngradedExports and a recognised
 * but unguarded one by the body check, and which route a given syntax takes is
 * an implementation detail — what the guardrail promises is that the name comes
 * out. Asserting on the union is what makes these fixtures survive the matcher
 * learning a form that is currently only loud.
 */
function reported(source: string): string[] {
  return [...findUngradedExports(source), ...unguarded(source)].sort();
}

/** A file-level `"use server"` module: every export in it is an action. */
const PREAMBLE = `"use server";\n\nimport { requireOperator } from "@/lib/auth/page";\n\n`;

test("a guarded `export async function` action passes", () => {
  const source = `${PREAMBLE}export async function createAction(formData: FormData): Promise<void> {
  await requireOperator("/sends");
  await prisma.send.create({ data: { recipientId: 1 } });
}
`;
  assert.deepEqual(names(source), ["createAction"]);
  assert.deepEqual(unguarded(source), []);
});

test("an unguarded `export const … = async (…) =>` arrow action is caught", () => {
  // The form the reviewer proved on PR #9: invisible to the old matcher, and
  // hidden from the file-level test by its guarded neighbour above it.
  const source = `${PREAMBLE}export async function createAction(formData: FormData): Promise<void> {
  await requireOperator("/sends");
  await prisma.send.create({ data: { recipientId: 1 } });
}

export const probeAction = async (formData: FormData): Promise<void> => {
  await prisma.send.deleteMany({ where: { id: Number(formData.get("id")) } });
};
`;
  assert.deepEqual(names(source), ["createAction", "probeAction"]);
  assert.deepEqual(unguarded(source), ["probeAction"]);
});

test("an unguarded `export function` action is caught", () => {
  const source = `${PREAMBLE}export function syncAction(formData: FormData): void {
  queueWrite(formData);
}
`;
  assert.deepEqual(unguarded(source), ["syncAction"]);
});

test("an unguarded `export const … = async function` action is caught", () => {
  const source = `${PREAMBLE}export const legacyAction = async function (formData: FormData): Promise<void> {
  await prisma.send.deleteMany({ where: { id: 1 } });
};
`;
  assert.deepEqual(unguarded(source), ["legacyAction"]);
});

test("`let` and `var` bindings are split too", () => {
  const source = `${PREAMBLE}export let letAction = async () => {
  await prisma.send.deleteMany();
};

export var varAction = async () => {
  await prisma.send.deleteMany();
};
`;
  assert.deepEqual(unguarded(source), ["letAction", "varAction"]);
});

test("an unguarded default-exported action is caught", () => {
  const source = `${PREAMBLE}export default async function handlerAction(formData: FormData): Promise<void> {
  await prisma.send.deleteMany({ where: { id: 1 } });
}
`;
  assert.deepEqual(unguarded(source), ["handlerAction"]);
});

test("an anonymous default export is named `default`", () => {
  const source = `${PREAMBLE}export default async function (formData: FormData): Promise<void> {
  await prisma.send.deleteMany({ where: { id: 1 } });
}
`;
  assert.deepEqual(unguarded(source), ["default"]);

  const arrow = `${PREAMBLE}export default async (formData: FormData): Promise<void> => {
  await prisma.send.deleteMany({ where: { id: 1 } });
};
`;
  assert.deepEqual(unguarded(arrow), ["default"]);
});

test("a module-local action with an inline `\"use server\"` is graded", () => {
  // src/app/embed/page.tsx: `saveSettings` is a real POST endpoint passed to
  // <form action={…}> with no exported name at all, so an export-keyed
  // matcher can never see it. Clause 2 is what catches this shape.
  const source = `import { requireOperator } from "@/lib/auth/page";

async function saveSettings(formData: FormData) {
  "use server";
  await prisma.legalSettings.update({ data: { embedEnabled: true } });
}
`;
  assert.equal(hasModuleDirective(source), false);
  assert.deepEqual(names(source), ["saveSettings"]);
  assert.deepEqual(unguarded(source), ["saveSettings"]);
});

test("an inline directive is found at any indentation and in either quote style", () => {
  const source = `const wrapper = {
  run: 1,
};

  async function deepAction(formData: FormData) {
    'use server';
    await prisma.send.deleteMany();
  }
`;
  assert.deepEqual(unguarded(source), ["deepAction"]);
});

test("the page component of a file with no module directive is not an action", () => {
  // embed/page.tsx in miniature. Its `"use server"` is inline on one function,
  // so it says nothing about the file's exports: the default-exported page is
  // a render path, covered by the operator-page test, not an action. Grading
  // it here would be grading every page component in the app.
  const source = `import { requireOperator } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

async function saveSettings(formData: FormData) {
  "use server";
  await requireOperator("/embed");
  await prisma.legalSettings.update({ data: { embedEnabled: true } });
}

export default async function EmbedAdminPage() {
  await requireOperator("/embed");
  return null;
}
`;
  assert.deepEqual(names(source), ["saveSettings"]);
  assert.deepEqual(unguarded(source), []);
});

test("a module-local helper with no inline directive is not graded", () => {
  // `finish`, `text` and `recipientFrom` are live in the repo's action files.
  // They are not actions, and reporting them would be a false red on four
  // files at once.
  const source = `${PREAMBLE}function finish(path: string, ok: boolean): never {
  redirect(path);
}

async function requestIdentity(): Promise<string | null> {
  return (await headers()).get("x-forwarded-for");
}

export async function acceptAction(formData: FormData): Promise<void> {
  await requireOperator("/sends");
  await prisma.send.create({ data: {} });
}
`;
  assert.deepEqual(names(source), ["acceptAction"]);
  assert.deepEqual(unguarded(source), []);
});

test("a guard in one action does not cover the next one", () => {
  // The whole point of splitting: the file-level test is satisfied by the
  // guard in `firstAction`, so only a per-action body check sees `secondAction`.
  const source = `${PREAMBLE}export async function firstAction(): Promise<void> {
  await requireOperator("/sends");
  await prisma.send.create({ data: {} });
}

export async function secondAction(): Promise<void> {
  await prisma.send.deleteMany();
}
`;
  assert.ok(GUARD_CALL.test(source), "the file-level check passes on this source");
  assert.deepEqual(unguarded(source), ["secondAction"]);
});

test("a guard in a trailing helper is not miscredited to the action above it", () => {
  // Bodies end at the next module-level declaration site, not at EOF, so a
  // guard helper at the bottom of the file cannot launder the unguarded
  // action above it. The depth bound keeps this true: both are at column 0.
  const source = `${PREAMBLE}export async function unguardedAction(): Promise<void> {
  await prisma.send.deleteMany();
}

async function ensureOperator(): Promise<void> {
  await requireOperator("/sends");
}
`;
  assert.deepEqual(unguarded(source), ["unguardedAction"]);
});

test("a body runs to the next site, not to the first close brace", () => {
  // An arrow action ends `};`, and a guard that sits after a nested block
  // still belongs to its action. A brace terminator truncates both.
  const source = `${PREAMBLE}export const guardedArrow = async (formData: FormData): Promise<void> => {
  if (!formData.get("id")) {
    return;
  }
  await requireOperator("/sends");
  await prisma.send.deleteMany();
};
`;
  assert.deepEqual(unguarded(source), []);
});

test("a local declaration before the guard call does not truncate the body", () => {
  // Every local is a declaration site, because family C matches any
  // parenthesised initialiser — `const n = (count ?? 0) + 1;` is one. Bounding
  // a body on the merely-next site therefore ended the action at its own first
  // local and credited the guard below it to that local, reporting six shapes
  // of ordinary, correctly guarded code as unguarded. Indentation is the fix:
  // a nested site is deeper than its action and cannot bound it.
  const locals = [
    "const n = (count ?? 0) + 1;",
    "const base = (await requestBaseUrl()).toString();",
    "const helper = async () => 1;",
    "const fn = function () {};",
    "const map = (x: number) => x;",
    "function inner() {}",
    'const s = "lit";',
    "const { id } = await payload();",
    "const arr = [1, 2];",
  ];
  for (const local of locals) {
    const source = `${PREAMBLE}export async function fooAction(count: number): Promise<void> {
  ${local}
  await requireOperator("/sends");
  await prisma.send.create({ data: {} });
}
`;
    assert.deepEqual(names(source), ["fooAction"], local);
    assert.deepEqual(unguarded(source), [], local);
  }
});

test("a nested inline-directive action does not make its encloser an action", () => {
  // The companion to the depth bound. Widening the body so a nested
  // declaration cannot end it also puts the nested action's `"use server"`
  // inside its encloser's span, which would grade the render path as an action
  // again — the thing the inline-directive clause deliberately stopped doing.
  // So the directive is read from the narrow span and the guard from the wide
  // one: only `save` is an action here.
  const source = `import { requireOperator } from "@/lib/auth/page";

export default async function Page() {
  const rows = await prisma.send.findMany();
  async function save(formData: FormData) {
    "use server";
    await requireOperator("/sends");
    await prisma.send.update({ where: { id: 1 }, data: {} });
  }
  return rows.length + Number(save !== undefined);
}
`;
  assert.deepEqual(names(source), ["save"]);
  assert.deepEqual(unguarded(source), []);
});

test("an unguarded nested inline-directive action is still caught", () => {
  // The other side of the test above: scoping the directive to the narrow span
  // must not make a nested action invisible, only its encloser ungraded.
  const source = `import { prisma } from "@/lib/db";

export default async function Page() {
  const rows = await prisma.send.findMany();
  async function purge(formData: FormData) {
    "use server";
    await prisma.send.deleteMany({});
  }
  return rows.length + Number(purge !== undefined);
}
`;
  assert.deepEqual(unguarded(source), ["purge"]);
});

test("no non-action export in the repo becomes a phantom site", () => {
  // The four live shapes a naive `^export ` split would report as unguarded
  // actions: three type-only exports and a Next route segment option. Each is
  // named here because each exists on main today — login/actions.ts:21,
  // onboarding/actions.ts:23, settings/api/actions.ts:17, embed/page.tsx:22.
  const source = `${PREAMBLE}export type LoginError = "unconfigured" | "invalid";

export type SaveIdentityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface CreateKeyState {
  readonly status: "idle" | "error";
}

export const dynamic = "force-dynamic";

export async function loginAction(): Promise<void> {
  await requireOperator("/login");
}
`;
  assert.deepEqual(names(source), ["loginAction"]);
  assert.deepEqual(unguarded(source), []);
});

/** A correctly guarded neighbour, which is what hides an unreported export. */
const GUARDED_NEIGHBOUR = `export async function okAction(): Promise<void> {
  await requireOperator("/sends");
  await prisma.send.create({ data: {} });
}
`;

test("an unguarded annotated arrow action is caught", () => {
  // `export const purgeAction: ServerAction = async () => {…}`. The annotation
  // sits between the name and the `=`, so clause C could not see the site at
  // all: one checked site, zero misses, green. The repo already writes the
  // shape for non-actions — `export const metadata: Metadata` in layout.tsx
  // and login/page.tsx — so it is a question of when, not if.
  const source = `${PREAMBLE}${GUARDED_NEIGHBOUR}
export const purgeAction: ServerAction = async (formData: FormData): Promise<void> => {
  await prisma.send.deleteMany({ where: { id: Number(formData.get("id")) } });
};
`;
  assert.deepEqual(reported(source), ["purgeAction"]);
  assert.deepEqual(names(source), ["okAction", "purgeAction"]);
});

test("an annotated arrow action that does guard itself passes", () => {
  // The other side of the test above: tolerating the annotation must not make
  // every annotated binding a red.
  const source = `${PREAMBLE}export const purgeAction: ServerAction = async (): Promise<void> => {
  await requireOperator("/sends");
  await prisma.send.deleteMany();
};
`;
  assert.deepEqual(names(source), ["purgeAction"]);
  assert.deepEqual(reported(source), []);
});

test("an unguarded action behind a higher-order wrapper is caught", () => {
  // `export const purgeAction = withLogging(async () => {…})` is not a
  // function *declaration* form, and is deliberately not chased with another
  // SITE_PATTERN alternative. The per-export rule reports it, which is the
  // arrangement that makes the form after this one loud too.
  const source = `${PREAMBLE}${GUARDED_NEIGHBOUR}
export const purgeAction = withLogging(async (): Promise<void> => {
  await prisma.send.deleteMany();
});
`;
  assert.deepEqual(reported(source), ["purgeAction"]);
});

test("an unguarded action published by an `export {}` list is caught", () => {
  // Same class: the declaration is module-local and unexported, so clause C
  // grades nothing, and the export is a separate statement entirely.
  const source = `${PREAMBLE}${GUARDED_NEIGHBOUR}
const purgeAction = async (): Promise<void> => {
  await prisma.send.deleteMany();
};

export { purgeAction };
`;
  assert.deepEqual(reported(source), ["purgeAction"]);
});

test("an unguarded action behind a function-type annotation is caught", () => {
  // `[^=]*` in ANNOTATION cannot cross the `=` of a `=>`, so this annotation is
  // not rewritten and the site is not graded. It is still reported, by the
  // per-export rule — the point of having both.
  const source = `${PREAMBLE}${GUARDED_NEIGHBOUR}
export const purgeAction: (formData: FormData) => Promise<void> = async () => {
  await prisma.send.deleteMany();
};
`;
  assert.deepEqual(reported(source), ["purgeAction"]);
});

test("a re-export that could publish an action is reported by name", () => {
  // `export * from` has no name to report, so it is reported as `*`; a named
  // re-export names the local declaration somebody has to go and guard.
  const starred = `${PREAMBLE}${GUARDED_NEIGHBOUR}\nexport * from "./_probe";\n`;
  assert.deepEqual(reported(starred), ["*"]);

  const named = `${PREAMBLE}${GUARDED_NEIGHBOUR}\nexport { probeAction } from "./_probe";\n`;
  assert.deepEqual(reported(named), ["probeAction"]);
});

test("an `export {}` list broken over several lines is still reported", () => {
  // Prettier breaks a long name list, and an export clause is the one
  // statement here whose names can span lines — so a one-line-at-a-time rule
  // missed it silently, which is the exact failure mode it exists to stop.
  const source = `${PREAMBLE}${GUARDED_NEIGHBOUR}
const purgeAction = async (): Promise<void> => {
  await prisma.send.deleteMany();
};

export {
  okAction,
  purgeAction,
};
`;
  assert.deepEqual(reported(source), ["purgeAction"]);
});

test("a dedented template literal does not truncate the body above the guard", () => {
  // This repo sends HTML mail from sends/notices/actions.ts and
  // settings/email/actions.ts, and a column-0 line inside the literal is a
  // clause-C site at depth 0 — so the indentation bound ended the action
  // before its guard call and reported correct code as unguarded.
  const assignment = `${PREAMBLE}export async function sendMailAction(): Promise<void> {
  const html = \`
const tracker = (id) => id;
\`;
  await requireOperator("/sends");
  await sendMail(html);
}
`;
  assert.deepEqual(names(assignment), ["sendMailAction"]);
  assert.deepEqual(reported(assignment), []);

  const declaration = `${PREAMBLE}export async function sendMailAction(): Promise<void> {
  const script = \`
function onclick() {}
\`;
  await requireOperator("/sends");
  await sendMail(script);
}
`;
  assert.deepEqual(names(declaration), ["sendMailAction"]);
  assert.deepEqual(reported(declaration), []);

  // And skipping the literal must not swallow a real miss in the same action.
  const unguardedMail = `${PREAMBLE}export async function sendMailAction(): Promise<void> {
  const html = \`
const tracker = (id) => id;
\`;
  await sendMail(html);
}
`;
  assert.deepEqual(reported(unguardedMail), ["sendMailAction"]);
});

test("an unpaired backtick in a comment does not blind the split", () => {
  // A backticked identifier wrapped across two comment lines leaves a lone
  // backtick on a line. Two files on main are exactly this shape —
  // src/lib/legal/embedDocument.ts:27 and src/lib/legal/embedRoutes.ts:11 —
  // so it is ordinary writing here, not an exotic corner.
  //
  // Counted, that backtick flipped the scan into "template interior" for the
  // rest of the file, and a dropped line yields no site *and* no export: the
  // unguarded action below was invisible to both halves of the guardrail while
  // the guarded neighbour above held the file-level test up. Green, on the
  // card's original failure mode, reached through the lexer.
  //
  // Outside a literal a line that starts `//` is a comment, so its backticks
  // are prose and are not counted.
  const source = `${PREAMBLE}${GUARDED_NEIGHBOUR}
//     frame-ancestors\` (computed from a settings row) and a cache policy
export async function purgeAction(): Promise<void> {
  await prisma.send.deleteMany();
}
`;
  assert.deepEqual(names(source), ["okAction", "purgeAction"]);
  assert.deepEqual(reported(source), ["purgeAction"]);
});

test("a template-interior line starting with `//` still closes its literal", () => {
  // The other side of that amendment, and why it is scoped to lines *outside* a
  // literal. Inside one, a line beginning `//` is literal text — a
  // protocol-relative URL in mail HTML — and may carry the closing backtick, so
  // its backticks have to keep counting. Skipping them would leave every file
  // with such a line permanently unterminated.
  const source = `${PREAMBLE}export async function sendMailAction(): Promise<void> {
  const html = \`
//cdn.example.com/pixel.png\`;
  await requireOperator("/sends");
  await sendMail(html);
}
`;
  assert.deepEqual(names(source), ["sendMailAction"]);
  assert.deepEqual(reported(source), []);
});

test("an unpaired backtick outside a comment is reported, not silently dropped", () => {
  // A backtick in a quoted string still desyncs the line-based count — an
  // accepted limit, since a tokenizer is the wrong trade for a test helper. What
  // is not accepted is failing quietly, so the desync is loud from both ends:
  // the dropped export is named, and the file is named for ending mid-literal.
  const source = `${PREAMBLE}${GUARDED_NEIGHBOUR}
const TICK = "\`";
export async function purgeAction(): Promise<void> {
  await prisma.send.deleteMany();
}
`;
  assert.deepEqual(findUngradedExports(source), ["purgeAction", UNTERMINATED_TEMPLATE]);
});

test("a source that ends inside a template literal is reported as the file", () => {
  // The end-of-source half of the same rule. There may be no export left to
  // name — the desync swallows whatever follows it — so the file itself is what
  // gets reported, which is enough for somebody to go and balance the backtick.
  const unterminated = `${PREAMBLE}${GUARDED_NEIGHBOUR}
const html = \`<p>hello</p>
export async function purgeAction(): Promise<void> {
  await prisma.send.deleteMany();
}
`;
  assert.deepEqual(findUngradedExports(unterminated), ["purgeAction", UNTERMINATED_TEMPLATE]);

  // With nothing after the desync at all, the file is the whole report.
  const nothingAfter = `${PREAMBLE}${GUARDED_NEIGHBOUR}\nconst html = \`<p>hello</p>\n`;
  assert.deepEqual(findUngradedExports(nothingAfter), [UNTERMINATED_TEMPLATE]);
});

test("a plain-literal declarator does not silence its sibling", () => {
  // One `export const` statement can bind more than one name, so the
  // PLAIN_LITERAL skip has to be per declarator. Per *line* it was a second
  // silent miss: `LIMIT`'s initialiser is a plain literal, so the whole line was
  // skipped and took its sibling with it — and the sibling's own line is at
  // depth 2, where the depth-0 loop never looks. One unguarded action, reported
  // as nothing at all.
  const source = `${PREAMBLE}${GUARDED_NEIGHBOUR}
export const LIMIT = 1,
  purgeAction = async (): Promise<void> => {
    await prisma.send.deleteMany();
  };
`;
  assert.deepEqual(reported(source), ["purgeAction"]);
});

test("multi-line and multi-declarator non-action exports stay quiet", () => {
  // The false-red guard on the two changes above: joining a continuation line
  // and splitting declarators must not start reporting the value exports the
  // repo already writes. A rule that false-reds is worse than no rule.
  const source = `${PREAMBLE}export const metadata: Metadata = {
  title: "Sends",
  description: "Operator sends",
};

export const TABS = [
  "sends",
  "documents",
];

export const dynamic = "force-dynamic",
  revalidate = 0;

${GUARDED_NEIGHBOUR}`;
  assert.deepEqual(findUngradedExports(source), []);
  assert.deepEqual(reported(source), []);
});

test("a template literal quoting an export does not false-red a graded action", () => {
  // The cost of reporting dropped export lines, stated honestly: a *correctly
  // paired* literal whose interior starts a line with `export` is reported too.
  // Nothing on main does that — measured over all 131 .ts/.tsx files, zero
  // depth-0 `export` lines sit inside a literal — and where the quoted name is
  // a real action in the same file the graded check absorbs it, as here. The
  // trade is deliberate: a false red gets looked at, a silent miss does not.
  const source = `${PREAMBLE}export async function docsAction(): Promise<void> {
  await requireOperator("/documents");
  const sample = \`
export async function docsAction() {}
\`;
  await render(sample);
}
`;
  assert.deepEqual(names(source), ["docsAction"]);
  assert.deepEqual(reported(source), []);
});

test("the non-action exports on main are not reported by the per-export rule", () => {
  // The companion to "no non-action export becomes a phantom site": the
  // loudness rule has to stay off the same four live shapes, plus the annotated
  // object literal that motivated the annotation pass. A rule that false-reds
  // is worse than no rule.
  const source = `${PREAMBLE}export type LoginError = "unconfigured" | "invalid";

export interface CreateKeyState {
  readonly status: "idle" | "error";
}

export enum Phase {
  Draft = "draft",
}

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { title: "Sends" };
export const TABS = ["sends", "documents"];
export { type LoginError as PublicLoginError };

${GUARDED_NEIGHBOUR}`;
  assert.deepEqual(findUngradedExports(source), []);
  assert.deepEqual(reported(source), []);
});

test("the per-export rule stays off files with no module directive", () => {
  // embed/page.tsx: its `"use server"` is inline on one local function, so the
  // exported page component is a render path and correctly not an action.
  // Demanding a guard from it is a false red on a real file.
  const source = `import { requireOperator } from "@/lib/auth/page";

export const dynamic = "force-dynamic";

async function saveSettings(formData: FormData) {
  "use server";
  await requireOperator("/embed");
  await prisma.legalSettings.update({ data: { embedEnabled: true } });
}

export default async function EmbedAdminPage() {
  await requireOperator("/embed");
  return null;
}
`;
  assert.equal(hasModuleDirective(source), false);
  assert.deepEqual(findUngradedExports(source), []);
});

test("a `\"use server\"` file yielding no recognised action is vacuity", () => {
  // The rule that stops the next form reopening the gap: nothing recognised is
  // the signal coverage.test.ts reports with the file named, rather than a
  // silent pass. A re-export is the concrete case — it can publish an action
  // this matcher never sees.
  const source = `${PREAMBLE}export { probeAction } from "./_probe";\n`;
  assert.deepEqual(findActionSites(source), []);
});

test("hasModuleDirective separates a file-level directive from an inline one", () => {
  assert.equal(hasModuleDirective(`"use server";\n\nexport async function a() {}\n`), true);
  assert.equal(hasModuleDirective(`'use server';\nexport async function a() {}\n`), true);
  // A licence or AUTH header before the directive is still module-level.
  assert.equal(
    hasModuleDirective(`// AUTH (SHA-3047): operator only.\n\n/* block\n   comment */\n"use server";\n`),
    true,
  );
  // An indented directive deeper in the file is one function's, not the file's.
  assert.equal(
    hasModuleDirective(`import { prisma } from "@/lib/db";\n\nasync function a() {\n  "use server";\n}\n`),
    false,
  );
  assert.equal(hasModuleDirective(`export async function a() {}\n`), false);
});

test("the matcher holds no state between calls", () => {
  // A module-level /g regex driven by exec() would skip sites on the second
  // call; coverage.test.ts calls this once per action file.
  const source = `${PREAMBLE}export const probeAction = async () => {
  await prisma.send.deleteMany();
};
`;
  assert.deepEqual(unguarded(source), ["probeAction"]);
  assert.deepEqual(unguarded(source), ["probeAction"]);
});
