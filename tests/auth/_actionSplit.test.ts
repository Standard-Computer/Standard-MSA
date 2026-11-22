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

import { findActionSites, hasModuleDirective } from "./_actionSplit";

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
  // Bodies end at the next declaration site, not at EOF, so a guard helper at
  // the bottom of the file cannot launder the unguarded action above it.
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
