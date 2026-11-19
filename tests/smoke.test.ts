import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Scaffold smoke tests: the schema stays SQLite (self-host requirement) and
// .env.example never grows a real-looking value.
test("prisma datasource is sqlite with env-provided url", () => {
  const schema = readFileSync(
    path.join(process.cwd(), "prisma", "schema.prisma"),
    "utf8",
  );
  assert.match(schema, /provider\s*=\s*"sqlite"/);
  assert.match(schema, /url\s*=\s*env\("DATABASE_URL"\)/);
});

test(".env.example contains placeholders only", () => {
  const env = readFileSync(path.join(process.cwd(), ".env.example"), "utf8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, name, raw] = m;
    const value = raw.replace(/^"|"$/g, "");
    if (["DATABASE_URL", "APP_BASE_URL", "SMTP_PORT", "SMTP_SECURE"].includes(name)) continue;
    assert.equal(value, "", `${name} must ship empty in .env.example`);
  }
});
