/**
 * Collect the Prisma CLI plus its complete dependency closure out of a full
 * (dev) install tree into a self-contained `node_modules`, for the runtime
 * image to run `prisma migrate deploy` at container start.
 *
 * Why this exists (SHA-4378): the runtime image is a Next standalone bundle,
 * which traces only what the *server* imports — the CLI is a dev dependency
 * and is not in it. The Dockerfile used to hand-copy two paths,
 * `node_modules/prisma` and `node_modules/@prisma`, which looks complete and
 * is not: npm hoists `@prisma/config`'s dependencies (`effect`, `c12`,
 * `deepmerge-ts`, `empathic`) to the *top level*, so they were left behind.
 * `require('effect')` threw MODULE_NOT_FOUND, the entrypoint exited non-zero
 * under `set -e`, `server.js` never started, and Railway crash-looped the
 * replica (deploy 23443b88).
 *
 * Computing the closure instead of listing it means a Prisma bump needs no
 * Dockerfile edit, and `tests/docker/prisma-cli-closure.test.ts` asserts the
 * output really is self-contained — the check the hand-written list never had.
 */
import fs from "node:fs";
import path from "node:path";

/** Package whose closure the runtime image needs. */
export const PRISMA_CLI_PACKAGE = "prisma";

export interface CollectOptions {
  /** Install tree to read from: the directory *containing* `node_modules`. */
  root: string;
  /** Destination tree; packages land under `<out>/node_modules/...`. */
  out: string;
  /** Entry packages whose closures are collected. Defaults to the Prisma CLI. */
  packages?: string[];
}

export interface CollectResult {
  /** Package names copied, sorted. */
  collected: string[];
  /** Entries resolvable in neither the tree nor the closure (optional/peer only). */
  skipped: string[];
}

// The paths walked in this file are derived from package.json dependency
// names in this repo's own install tree, not from request input — the
// suppressions below follow the tests/api/openapi.test.ts precedent for build
// tooling reading its own tree.
const isDirectory = (candidate: string): boolean => {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Resolve `name` the way Node does — nearest `node_modules` first, then up
 * the tree — but never above `root`, so a gap in the install tree surfaces as
 * an error instead of silently picking up a package from outside it.
 */
const resolvePackageDir = (
  name: string,
  fromDir: string,
  root: string,
): string | null => {
  const stop = path.resolve(root);
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (isDirectory(candidate)) return candidate;
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

const readPackageJson = (dir: string): Record<string, unknown> => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
};

const namesOf = (value: unknown): string[] =>
  value && typeof value === "object" ? Object.keys(value as object) : [];

/** Peers npm installs by default: everything not flagged optional. */
const requiredPeers = (manifest: Record<string, unknown>): string[] => {
  const meta = (manifest.peerDependenciesMeta ?? {}) as Record<
    string,
    { optional?: boolean } | undefined
  >;
  return namesOf(manifest.peerDependencies).filter(
    (name) => !meta[name]?.optional,
  );
};

export const collectPrismaCli = ({
  root,
  out,
  packages = [PRISMA_CLI_PACKAGE],
}: CollectOptions): CollectResult => {
  const collected = new Set<string>();
  const skipped = new Set<string>();
  const visited = new Set<string>();
  // `required` entries fail the build when missing; the rest are best-effort
  // (an absent optional dep or a peer the app itself provides is normal).
  const queue: { name: string; from: string; required: boolean }[] =
    packages.map((name) => ({ name, from: root, required: true }));

  while (queue.length > 0) {
    const { name, from, required } = queue.shift()!;
    const src = resolvePackageDir(name, from, root);
    if (src === null) {
      if (required) {
        throw new Error(
          `cannot resolve "${name}" from ${from} within ${root} — ` +
            `is the install tree complete (npm ci)?`,
        );
      }
      skipped.add(name);
      continue;
    }
    if (visited.has(src)) continue;
    visited.add(src);

    // Mirror the source layout relative to `root`, so a hoisted package lands
    // top level and a nested one stays nested — i.e. the resolution order the
    // CLI was installed with is preserved exactly.
    const dest = path.join(out, path.relative(root, src));
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.existsSync(dest)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, {
        recursive: true,
        force: true,
        dereference: true,
        preserveTimestamps: true,
      });
    }
    collected.add(name);

    const manifest = readPackageJson(src);
    for (const dep of namesOf(manifest.dependencies)) {
      queue.push({ name: dep, from: src, required: true });
    }
    for (const dep of [
      ...namesOf(manifest.optionalDependencies),
      ...requiredPeers(manifest),
    ]) {
      queue.push({ name: dep, from: src, required: false });
    }
  }

  return {
    collected: [...collected].sort(),
    skipped: [...skipped].sort().filter((name) => !collected.has(name)),
  };
};

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]).startsWith("collect-prisma-cli");

if (invokedDirectly) {
  const out = process.argv[2];
  if (out === undefined) {
    process.stderr.write(
      "usage: collect-prisma-cli.ts <out-dir> [install-root]\n",
    );
    process.exit(2);
  }
  const root = process.argv[3] ?? process.cwd();
  const { collected, skipped } = collectPrismaCli({ root, out });
  process.stdout.write(
    `collect-prisma-cli: ${collected.length} packages -> ` +
      `${path.join(out, "node_modules")}\n`,
  );
  if (skipped.length > 0) {
    process.stdout.write(
      `collect-prisma-cli: not installed, skipped: ${skipped.join(", ")}\n`,
    );
  }
}
