import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL?.trim();
let pool;
let ready = false;
let lastError = connectionString ? null : "DATABASE_URL is not configured";

export async function initializeDatabase() {
  if (!connectionString) return false;

  try {
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes("sslmode=disable")
        ? false
        : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    const schemaPath = fileURLToPath(
      new URL("./database/schema.sql", import.meta.url),
    );
    const schema = await readFile(schemaPath, "utf8");
    await pool.query(schema);
    ready = true;
    lastError = null;
    return true;
  } catch (error) {
    ready = false;
    lastError =
      error instanceof Error ? error.message : "Database initialization failed";
    console.error("[database] initialization failed:", lastError);
    return false;
  }
}

export async function databaseHealth() {
  if (!pool || !ready)
    return {
      ok: false,
      configured: Boolean(connectionString),
      error: lastError,
    };
  try {
    await pool.query("SELECT 1");
    return { ok: true, configured: true };
  } catch (error) {
    ready = false;
    lastError =
      error instanceof Error ? error.message : "Database health check failed";
    return { ok: false, configured: true, error: lastError };
  }
}

export async function query(text, values = []) {
  if (!pool || !ready) throw new Error("Database is unavailable");
  return pool.query(text, values);
}

export async function transaction(work) {
  if (!pool || !ready) throw new Error("Database is unavailable");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function closeDatabase() {
  if (pool) await pool.end();
}
