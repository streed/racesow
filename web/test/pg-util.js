// Test helper: ephemeral PostgreSQL databases, one per test, so tests stay
// independent and order-free (the moral equivalent of the old fresh-SQLite-
// file-per-test). Point TEST_PG_URL at any throwaway Postgres owner
// connection; the default matches the dev container:
//
//   docker run -d --name racesow-pg-test -p 5433:5432 \
//     -e POSTGRES_USER=racesow -e POSTGRES_PASSWORD=racesow -e POSTGRES_DB=racesow \
//     postgres:16-alpine
import crypto from "node:crypto";
import pg from "pg";

export const ADMIN_URL =
  process.env.TEST_PG_URL || "postgres://racesow:racesow@127.0.0.1:5433/racesow";

export async function adminQuery(sql) {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

// Create a throwaway database; returns { url, drop }. The caller owns
// teardown ordering: close your pool FIRST, then await drop() — a DROP ...
// WITH (FORCE) would otherwise kill the pool's live connections mid-test.
export async function createTestDb() {
  const name = "test_" + crypto.randomBytes(6).toString("hex");
  await adminQuery(`CREATE DATABASE ${name}`);
  return {
    url: ADMIN_URL.replace(/\/[^/]*$/, `/${name}`),
    drop: () => adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}
