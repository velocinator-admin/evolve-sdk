-- next-evolve 0.7: local retention (`retentionDays`, OPS-1). Additive only: two
-- small new tables, no change to existing tables or rows, safe on a live DB.

-- Experiments the cloud still aggregates (seen in aggregate requests), so the
-- daily cleanup never deletes data a running or paused experiment needs.
create table if not exists evolve.experiment_activity (
  experiment_id text primary key,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- One row per UTC day the cleanup ran (finished_at null = not done yet).
create table if not exists evolve.cleanup_runs (
  day date primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  deleted jsonb not null default '{}'
);
