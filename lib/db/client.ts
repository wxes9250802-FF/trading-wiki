import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/lib/env";
import * as schema from "./schema/index";

/**
 * Lazy Drizzle client — the connection is not established at import time.
 * postgres-js uses a connection pool internally; the first query triggers the handshake.
 *
 * DATABASE_URL is sourced from validated env (lib/env/index.ts). Importing this
 * module also triggers t3-env validation, which ensures DATABASE_URL conforms
 * to the expected postgresql://... format before any query runs.
 *
 * In production, Supabase enforces SSL. The sslmode=require param in DATABASE_URL
 * is sufficient — no extra TLS config needed here.
 */
function createClient() {
  const sql = postgres(env.DATABASE_URL, {
    // Limit connections in serverless environments.
    max: 1,
    // Disable prefetch as it is not supported for transaction mode.
    prepare: false,
  });

  return drizzle(sql, { schema });
}

// Module-level singleton — created once per server process (or warm lambda).
// The actual TCP connection is deferred until the first query.
let _client: ReturnType<typeof createClient> | undefined;

export function getDb() {
  if (!_client) {
    _client = createClient();
  }
  return _client;
}

/**
 * Convenience re-export so callers can do:
 *   import { db } from "@/lib/db/client";
 *
 * This is a getter-style export — the client is not instantiated until first access
 * via a Proxy, keeping import side-effects to zero.
 */
export const db = new Proxy({} as ReturnType<typeof createClient>, {
  get(_target, prop) {
    return Reflect.get(getDb(), prop);
  },
});
