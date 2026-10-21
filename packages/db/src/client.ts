import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export function createDb(url: string, options: { max?: number; connectTimeout?: number } = {}) {
  const sql = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
    // Never prepared by name (#411): behind a transaction pooler without prepared-statement
    // support, a name prepared on one server connection runs another client's statement there,
    // and answers with the wrong rows. Unnamed statements cost a little time and cannot.
    prepare: false,
    ...(options.connectTimeout ? { connect_timeout: options.connectTimeout } : {}),
  });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

export type Database = ReturnType<typeof createDb>["db"];
