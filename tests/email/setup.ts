// Imported FIRST by every email test file: modules under test pull in
// @/lib/db (PrismaClient), which needs DATABASE_URL at initialization.
// Unit tests never run queries against it.
process.env.DATABASE_URL ??= "file:./data/test.db";
