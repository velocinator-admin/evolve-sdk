-- next-evolve 0.5: Core Web Vitals histograms (Phase 2 spec §9.5). Additive only:
-- one new table, no change to existing tables or rows, so it is safe on a live DB.
-- Counts per experiment × variant × metric × UTC day × bin (protocol VITALS_BINS);
-- no visitor id is stored with vitals.
create table if not exists evolve.vitals_daily (
  experiment_id text not null,
  variant_id text not null,
  metric text not null,
  day date not null,
  bin smallint not null,
  count bigint not null default 0,
  primary key (experiment_id, variant_id, metric, day, bin)
);
