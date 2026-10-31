import { readdir, readFile } from "node:fs/promises";
import type { Sql } from "./client";

/** Shipped with the package: `next-evolve/migrations/*.sql`. */
export const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);

// Any constant works; it only has to be the same for every migrator.
const LOCK_KEY = 0x65766f6c; // "evol"

export type Migration = { id: string; sql: string };
export type MigrateResult = { applied: string[]; skipped: string[] };

export async function loadMigrations(dir: URL = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (f) => ({
      id: f.replace(/\.sql$/, ""),
      sql: await readFile(new URL(f, dir), "utf8"),
    })),
  );
}

/**
 * Applies pending migrations in order, all in one transaction under an
 * advisory lock, so concurrent runs (several instances booting) are safe and
 * a failure leaves nothing half-applied. Idempotent.
 */
export async function migrate(sql: Sql, migrations?: Migration[]): Promise<MigrateResult> {
  const list = migrations ?? (await loadMigrations());
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
    await tx`create schema if not exists evolve`;
    await tx`create table if not exists evolve.migrations (
      id text primary key, applied_at timestamptz not null default now())`;
    const done = new Set(
      (await tx<{ id: string }[]>`select id from evolve.migrations`).map((r) => r.id),
    );
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const m of list) {
      if (done.has(m.id)) {
        skipped.push(m.id);
        continue;
      }
      await tx.unsafe(m.sql);
      await tx`insert into evolve.migrations (id) values (${m.id})`;
      applied.push(m.id);
    }
    return { applied, skipped };
  }) as Promise<MigrateResult>;
}
