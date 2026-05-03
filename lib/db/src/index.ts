import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const poolMaxRaw = process.env.PG_POOL_MAX;
const poolMax = poolMaxRaw ? Math.max(1, Number.parseInt(poolMaxRaw, 10)) : 10;
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 10,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
export * from "./doa-config";
export * from "./s2p-helpers";
export * from "./hard-savings";
