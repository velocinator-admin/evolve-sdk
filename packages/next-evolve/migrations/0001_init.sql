-- next-evolve customer schema (spec §8.3). Raw events stay in this database.
-- Applied by `npx next-evolve migrate`; the migrator creates `evolve.migrations`.

-- One row per unit per experiment (first exposure).
create table evolve.exposures (
  experiment_id text not null,
  anon_id text not null,
  variant_id text not null,
  first_at timestamptz not null default now(),
  path text not null,
  segment text, -- null = main; Phase 3: UTM rule id
  primary key (experiment_id, anon_id)
);
create index exposures_exp_first on evolve.exposures (experiment_id, first_at);

create table evolve.events (
  id bigint generated always as identity primary key,
  ts timestamptz not null,
  received_at timestamptz not null default now(),
  name text not null,
  anon_id text,
  user_id text,
  value double precision,
  goal_values jsonb,
  props jsonb,
  source text not null,
  path text,
  dedupe_key text
);
create index events_name_ts on evolve.events (name, ts);
create index events_anon_name on evolve.events (anon_id, name, ts) where anon_id is not null;
create index events_user_name on evolve.events (user_id, name, ts) where user_id is not null;
create unique index events_dedupe on evolve.events (dedupe_key) where dedupe_key is not null;

create table evolve.identities (
  anon_id text primary key,
  user_id text not null,
  linked_at timestamptz not null default now()
);
create index identities_user on evolve.identities (user_id);

create table evolve.usage_daily (
  day date primary key,
  tested_pageviews bigint not null default 0
);

-- Idempotency cache + audit of what aggregate requests returned (kept 24 h).
create table evolve.aggregate_runs (
  request_id text primary key,
  received_at timestamptz not null,
  mode text not null,
  status text not null,
  duration_ms int,
  response_hash text,
  response jsonb
);
