import { logRateLimited } from "../core/log";
import { isServerless, type Sql } from "./client";

type Json = Record<string, unknown>;

export type ExposureRow = {
  experiment_id: string;
  anon_id: string;
  variant_id: string;
  path: string;
  /** When the beacon arrived (same clock as event `ts`), not when the batch is written. */
  first_at: Date;
};
export type EventRow = {
  ts: Date;
  name: string;
  anon_id: string | null;
  user_id: string | null;
  value: number | null;
  goal_values: Json | null;
  props: Json | null;
  source: string;
  path: string | null;
  dedupe_key: string | null;
};
export type IdentityRow = { anon_id: string; user_id: string };

export type WriterOptions = {
  sql: () => Sql | null;
  /** node: flush on a timer / row count and keep rows while the DB is down. serverless: flush per request. */
  mode?: "node" | "serverless";
  flushMs?: number;
  flushRows?: number;
  maxBuffer?: number;
};

export type Writer = {
  readonly mode: "node" | "serverless";
  exposures(rows: ExposureRow[]): void;
  events(rows: EventRow[]): void;
  identities(rows: IdentityRow[]): void;
  /** Adds tested page views to a UTC day (`YYYY-MM-DD`). */
  usage(day: string, pageviews: number): void;
  /** Rows waiting to be written. */
  pending(): number;
  /** Writes everything queued so far: one insert per table (chunked at 1,000 rows). */
  flush(): Promise<void>;
};

const CHUNK = 1000;
const MAX_BACKOFF_MS = 30_000;

export function createWriter(opts: WriterOptions): Writer {
  const mode = opts.mode ?? (isServerless() ? "serverless" : "node");
  const flushMs = opts.flushMs ?? 1000;
  const flushRows = opts.flushRows ?? 100;
  const maxBuffer = opts.maxBuffer ?? 10_000;

  let exposures: ExposureRow[] = [];
  let events: EventRow[] = [];
  let identities: IdentityRow[] = [];
  let usage = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let backoffMs = 0;
  let running: Promise<void> = Promise.resolve();

  const pending = () => exposures.length + events.length + identities.length + usage.size;

  function schedule(delay: number) {
    if (mode !== "node" || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
    timer.unref?.();
  }

  function added() {
    if (mode !== "node") return;
    trim();
    if (pending() >= flushRows && backoffMs === 0) void flush();
    else schedule(backoffMs || flushMs);
  }

  /** Keeps the buffer bounded while the DB is down: the oldest rows go first. */
  function trim() {
    let over = pending() - maxBuffer;
    if (over <= 0) return;
    logRateLimited("writer:drop", `customer DB unavailable; dropping ${over} buffered rows`);
    for (const list of [events, exposures, identities]) {
      const n = Math.min(over, list.length);
      list.splice(0, n);
      over -= n;
    }
  }

  async function write(sql: Sql, batch: Batch) {
    for (const rows of chunks(batch.exposures)) {
      await sql`insert into evolve.exposures ${sql(rows, "experiment_id", "anon_id", "variant_id", "path", "first_at")}
        on conflict do nothing`;
    }
    for (const rows of chunks(batch.events)) {
      const vals = rows.map((r) => ({
        ...r,
        goal_values: r.goal_values && sql.json(r.goal_values as never),
        props: r.props && sql.json(r.props as never),
      }));
      await sql`insert into evolve.events ${sql(vals, EVENT_COLS)}
        on conflict (dedupe_key) where dedupe_key is not null do nothing`;
    }
    for (const rows of chunks(batch.identities)) {
      await sql`insert into evolve.identities ${sql(rows, "anon_id", "user_id")} on conflict do nothing`;
    }
    const days = [...batch.usage].map(([day, n]) => ({ day, tested_pageviews: n }));
    if (days.length) {
      await sql`insert into evolve.usage_daily ${sql(days, "day", "tested_pageviews")}
        on conflict (day) do update
        set tested_pageviews = evolve.usage_daily.tested_pageviews + excluded.tested_pageviews`;
    }
  }

  function take(): Batch {
    const b = { exposures, events, identities, usage };
    exposures = [];
    events = [];
    identities = [];
    usage = new Map();
    return b;
  }

  function restore(b: Batch) {
    exposures = [...b.exposures, ...exposures];
    events = [...b.events, ...events];
    identities = [...b.identities, ...identities];
    for (const [d, n] of b.usage) usage.set(d, (usage.get(d) ?? 0) + n);
  }

  async function flushOnce() {
    if (pending() === 0) return;
    const sql = opts.sql();
    if (!sql) {
      logRateLimited("writer:nodb", "EVOLVE_DATABASE_URL is not set; events are not stored");
      take();
      return;
    }
    const batch = take();
    try {
      await write(sql, batch);
      backoffMs = 0;
    } catch (e) {
      if (mode === "serverless") {
        try {
          await write(sql, batch);
          return;
        } catch (e2) {
          logRateLimited("writer:dropped", "customer DB write failed; batch dropped", e2);
          return;
        }
      }
      logRateLimited("writer:retry", "customer DB write failed; will retry", e);
      restore(batch);
      trim();
      backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs ? backoffMs * 2 : flushMs);
      schedule(backoffMs);
    }
  }

  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    running = running.then(flushOnce, flushOnce);
    return running;
  }

  return {
    mode,
    exposures(rows) {
      if (!rows.length) return;
      exposures.push(...rows);
      added();
    },
    events(rows) {
      if (!rows.length) return;
      events.push(...rows);
      added();
    },
    identities(rows) {
      if (!rows.length) return;
      identities.push(...rows);
      added();
    },
    usage(day, n) {
      if (n <= 0) return;
      usage.set(day, (usage.get(day) ?? 0) + n);
      added();
    },
    pending,
    flush,
  };
}

type Batch = {
  exposures: ExposureRow[];
  events: EventRow[];
  identities: IdentityRow[];
  usage: Map<string, number>;
};

const EVENT_COLS = [
  "ts",
  "name",
  "anon_id",
  "user_id",
  "value",
  "goal_values",
  "props",
  "source",
  "path",
  "dedupe_key",
] as const;

function* chunks<T>(rows: T[]): Generator<T[]> {
  for (let i = 0; i < rows.length; i += CHUNK) yield rows.slice(i, i + CHUNK);
}

const WRITERS = Symbol.for("next-evolve.writers");

/**
 * The process-wide writer for a DB URL variable. On long-running Node it also
 * flushes on SIGTERM so a graceful shutdown doesn't lose buffered rows.
 */
export function getWriter(sql: () => Sql | null, key = "EVOLVE_DATABASE_URL"): Writer {
  const g = globalThis as { [WRITERS]?: Map<string, Writer> };
  g[WRITERS] ??= new Map();
  let w = g[WRITERS].get(key);
  if (!w) {
    const writer = createWriter({ sql });
    w = writer;
    g[WRITERS].set(key, writer);
    if (!isServerless() && typeof process !== "undefined" && process.once) {
      process.once("SIGTERM", () => {
        void writer.flush().finally(() => {
          // We were the only handler: keep the default behavior (exit).
          if (process.listenerCount("SIGTERM") === 0) process.exit(0);
        });
      });
    }
  }
  return w;
}
