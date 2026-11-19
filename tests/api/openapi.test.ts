// SHA-2960: the published OpenAPI document — structural validity, every
// $ref resolvable, and the paths table pinned to the route files on disk in
// BOTH directions, so neither the spec nor the routes can drift alone.

import "../email/setup";

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { buildOpenApiDocument } from "../../src/lib/api/openapi";

const doc = buildOpenApiDocument("https://msa.example.com") as {
  openapi: string;
  servers: { url: string }[];
  paths: Record<string, Record<string, { security?: unknown[]; responses?: Record<string, unknown> }>>;
  components: { schemas: Record<string, unknown> };
};

test("document basics: version, server, JSON round-trip", () => {
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.servers[0].url, "https://msa.example.com/api/v1");
  // Whatever we serve must survive serialization losslessly.
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
});

test("every $ref in the document resolves to a component schema", () => {
  const names = new Set(Object.keys(doc.components.schemas));
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref") {
          assert.equal(typeof value, "string");
          const m = /^#\/components\/schemas\/(.+)$/.exec(value as string);
          assert.ok(m, `unexpected $ref target ${String(value)}`);
          assert.ok(names.has(m![1]), `$ref to missing schema ${m![1]}`);
        } else {
          walk(value);
        }
      }
    }
  };
  walk(doc);
});

test("every operation requires the API key and documents its error envelope", () => {
  for (const [p, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      assert.ok(op.security?.length, `${method.toUpperCase()} ${p} must declare security`);
      assert.ok(op.responses?.["401"], `${method.toUpperCase()} ${p} must document 401`);
      assert.ok(op.responses?.["429"], `${method.toUpperCase()} ${p} must document 429`);
      const success = Object.keys(op.responses ?? {}).some((s) => s.startsWith("2"));
      assert.ok(success, `${method.toUpperCase()} ${p} must document a success response`);
    }
  }
});

test("spec paths and route files pin each other, both directions", () => {
  const apiRoot = path.join(process.cwd(), "src/app/api/v1");

  // Spec path -> the route file Next would serve it from.
  const routeFileFor = (specPath: string) =>
    path.join(apiRoot, ...specPath.replace(/^\//, "").split("/").map((seg) => {
      const m = /^\{(.+)\}$/.exec(seg);
      return m ? `[${m[1]}]` : seg;
    }), "route.ts");

  // The paths walked here are derived from this repo's own spec constants,
  // not from input — the suppressions below are the embedRoutes.test.ts
  // precedent for test code reading its own tree.
  for (const [specPath, ops] of Object.entries(doc.paths)) {
    const file = routeFileFor(specPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    assert.ok(existsSync(file), `spec path ${specPath} has no route file at ${file}`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const source = readFileSync(file, "utf8");
    for (const method of Object.keys(ops)) {
      assert.ok(
        source.includes(`export const ${method.toUpperCase()}`),
        `${file} does not export ${method.toUpperCase()} but the spec documents it`,
      );
    }
  }

  // Route file -> a spec entry (openapi.json itself is the one exemption).
  const walkRoutes = (dir: string): string[] => {
    const out: string[] = [];
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      if (statSync(full).isDirectory()) out.push(...walkRoutes(full));
      else if (entry === "route.ts") out.push(full);
    }
    return out;
  };
  const specFiles = new Set(Object.keys(doc.paths).map(routeFileFor));
  for (const file of walkRoutes(apiRoot)) {
    if (file.includes("openapi.json")) continue;
    assert.ok(specFiles.has(file), `route file ${file} is not documented in the OpenAPI spec`);
  }
});
