import { createSql, type Sql } from "../src/db/client";
import { migrate } from "../src/db/migrate";

export const TEST_DB_URL =
  process.env.EVOLVE_DATABASE_URL ?? "postgres://evolve:evolve@localhost:54329/customer";

export function testSql(url = TEST_DB_URL): Sql {
  return createSql(url, { max: 4 });
}

/** Drops the evolve schema and re-applies all migrations. */
export async function freshSchema(sql: Sql): Promise<void> {
  await sql`drop schema if exists evolve cascade`;
  await migrate(sql);
}
