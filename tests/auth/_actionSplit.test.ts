// Fixtures for the per-action guard split (SHA-3067).
//
// coverage.test.ts proves the split against the real app, which means it can
// only ever cover the export forms the app happens to use today — every action
// in the repo is `export async function`, so the arrow-action gap was invisible
// there. These fixtures cover each form directly, as permanent regression
// cover that does not require mutating app source to demonstrate.
//
// Pure string in, array out: no fs, no DB, no server-only imports.

import { test } from "node:test";
import assert from "node:assert/strict";

import { declaresExport, splitActionExports } from "./_actionSplit";

/** The same guard matcher coverage.test.ts applies to each body. */
const GUARD_CALL = /\b(requireOperator|guardOperatorRequest)\s*\(/;

/** Names of the actions in `source` whose body carries no guard call. */
function unguarded(source: string): string[] {
  return splitActionExports(source)
    .filter((action) => !GUARD_CALL.test(action.body))
    .map((action) => action.name);
}

const PREAMBLE = `"use server";\n\nimport { requireOperator } from "@/lib/auth/page";\n\n`;

test("a guarded `export async function` action passes", () => {
  const source = `${PREAMBLE}export async function createAction(formData: FormData): Promise<void> {
  await requireOperator("/sends");
  await prisma.send.create({ data: { recipientId: 1 } });
}
`;
  assert.deepEqual(splitActionExports(source).map((a) => a.name), ["createAction"]);
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
  assert.deepEqual(
    splitActionExports(source).map((a) => a.name),
    ["createAction", "probeAction"],
  );
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
  // src/app/embed/page.tsx is an operator route holding an inline
  // `"use server"`, and its only value exports are `export const dynamic` and
  // a default export — so the matcher has to understand `export default` or
  // that file reaches the vacuity check and reports a false miss.
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

test("a body runs to the next export site, not to the first close brace", () => {
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

test("type-only exports are neither actions nor evidence of one", () => {
  // onboarding/actions.ts and settings/api/actions.ts both lead with an
  // `export type`. It must not be split as an action, and a file holding only
  // type exports must not trip the vacuity check.
  const source = `${PREAMBLE}export type CreateKeyState =
  | { readonly status: "idle" }
  | { readonly status: "error"; readonly message: string };

export async function createApiKeyAction(): Promise<void> {
  await requireOperator("/settings/api");
}
`;
  assert.deepEqual(
    splitActionExports(source).map((a) => a.name),
    ["createApiKeyAction"],
  );
  assert.equal(declaresExport(`${PREAMBLE}export type Only = string;\n`), false);
});

test("a non-async value export is not treated as an action", () => {
  // `export const dynamic = "force-dynamic"` is a Next route segment option,
  // not a server action; flagging it would be a false red on every page that
  // sets one.
  const source = `${PREAMBLE}export const dynamic = "force-dynamic";

export async function saveAction(): Promise<void> {
  await requireOperator("/embed");
}
`;
  assert.deepEqual(splitActionExports(source).map((a) => a.name), ["saveAction"]);
  assert.deepEqual(unguarded(source), []);
});

test("exports in no recognised form are vacuity, not a pass", () => {
  // The rule that stops a fifth syntax reopening the gap: nothing recognised
  // plus exports present is the signal coverage.test.ts reports with the file
  // named. A re-export is the concrete case — it can publish an action this
  // matcher never sees.
  const source = `${PREAMBLE}export { probeAction } from "./_probe";\n`;
  assert.deepEqual(splitActionExports(source), []);
  assert.equal(declaresExport(source), true);
});

test("a file with no exports at all is not vacuity", () => {
  // Helper modules under an action directory have nothing to check, and must
  // not be reported as an unrecognised syntax.
  const source = `${PREAMBLE}async function helper(): Promise<void> {
  await prisma.send.findMany();
}
`;
  assert.deepEqual(splitActionExports(source), []);
  assert.equal(declaresExport(source), false);
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
