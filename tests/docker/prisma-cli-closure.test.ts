// SHA-4378: the runtime image runs `prisma migrate deploy` before the server
// starts, and the Prisma CLI is a dev dependency the Next standalone bundle
// does not carry. The Dockerfile used to hand-copy `node_modules/prisma` and
// `node_modules/@prisma`, which silently omitted the top-level-hoisted
// dependencies of `@prisma/config`: `require('effect')` threw
// MODULE_NOT_FOUND, docker-entrypoint.sh exited under `set -e`, server.js
// never ran, and Railway crash-looped the replica (deploy 23443b88).
//
// Nothing in CI could have caught that — lint, typecheck, test and build
// never assemble the run stage. These tests assemble the CLI tree exactly as
// the Dockerfile does and prove it resolves on its own.
//
// The tree is collected OUTSIDE the checkout on purpose: Node walks parent
// directories looking for `node_modules`, so a copy anywhere under the repo
// would fall back to the repo's own install tree and pass while the image
// still crash-looped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectPrismaCli } from "../../scripts/collect-prisma-cli";

const repoRoot = process.cwd();

// The paths below are built from this repo's own tree and from package.json
// dependency names, not from request input — the tests/api/openapi.test.ts
// precedent for test code reading its own tree.
const readJson = (file: string): Record<string, unknown> =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

/** Every package directory in the collected tree, scopes expanded. */
const packageDirsIn = (modules: string): string[] => {
  const dirs: string[] = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      for (const scoped of readdirSync(path.join(modules, entry))) {
        dirs.push(path.join(modules, entry, scoped));
      }
      continue;
    }
    dirs.push(path.join(modules, entry));
  }
  return dirs;
};

test("Prisma CLI tree staged into the runtime image", async (t) => {
  const out = mkdtempSync(path.join(os.tmpdir(), "prisma-cli-closure-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const { collected } = collectPrismaCli({ root: repoRoot, out });
  const modules = path.join(out, "node_modules");
  assert.ok(collected.includes("prisma"), "the CLI itself was not collected");

  await t.test("resolves the require chain that crash-looped", () => {
    // The exact chain from the crash stack: prisma/build/index.js ->
    // @prisma/config -> effect. cwd inside the collected tree, so resolution
    // has nowhere else to look.
    const probe =
      "require.resolve('prisma/build/index.js');" +
      "require('@prisma/config');" +
      "console.log('resolved')";
    const stdout = execFileSync(process.execPath, ["-e", probe], {
      cwd: out,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
    });
    assert.equal(stdout.trim(), "resolved");
  });

  await t.test("is a complete dependency closure", () => {
    const dirs = packageDirsIn(modules);
    assert.ok(dirs.length > 0, "collector produced an empty tree");
    for (const dir of dirs) {
      const manifest = readJson(path.join(dir, "package.json"));
      const deps = Object.keys(
        (manifest.dependencies ?? {}) as Record<string, string>,
      );
      for (const dep of deps) {
        assert.ok(
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          existsSync(path.join(dir, "node_modules", dep)) ||
            // eslint-disable-next-line security/detect-non-literal-fs-filename
            existsSync(path.join(modules, dep)),
          `${String(manifest.name)} requires "${dep}", which the runtime ` +
            `image would not have — the CLI fails at container start`,
        );
      }
    }
  });

  await t.test("carries the hoisted packages the hand-copy missed", () => {
    // @prisma/config's four dependencies; `effect` is the one the crash named.
    for (const name of ["effect", "c12", "deepmerge-ts", "empathic"]) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      assert.ok(existsSync(path.join(modules, name)), `${name} is missing`);
    }
  });

  await t.test("carries a schema engine binary for migrate deploy", () => {
    // `migrate deploy` shells out to the schema engine, which arrives via the
    // @prisma/engines postinstall. An --ignore-scripts install leaves the
    // package present and the binary absent — a runtime-only failure.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const engines = readdirSync(path.join(modules, "@prisma", "engines"));
    assert.ok(
      engines.some((entry) => entry.startsWith("schema-engine-")),
      `@prisma/engines ships no schema engine (has: ${engines.join(", ")})`,
    );
  });
});

test("Dockerfile and entrypoint agree on where the CLI tree lives", () => {
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const entrypoint = readFileSync(
    path.join(repoRoot, "docker-entrypoint.sh"),
    "utf8",
  );

  // The run stage stages the collected closure, and never hand-picks Prisma
  // paths out of the build stage's node_modules again.
  assert.match(dockerfile, /collect-prisma-cli\.ts \/prisma-cli/);
  assert.match(
    dockerfile,
    /COPY --from=build \/prisma-cli\/node_modules \.\/prisma-cli\/node_modules/,
  );
  assert.doesNotMatch(
    dockerfile,
    /COPY --from=build \/app\/node_modules\/@?prisma/,
    "run stage hand-copies Prisma paths again — use the collected closure",
  );

  // ...and the entrypoint invokes the CLI from exactly that tree.
  assert.match(
    entrypoint,
    /node prisma-cli\/node_modules\/prisma\/build\/index\.js migrate deploy/,
  );
});
