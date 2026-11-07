type Stat = { value: string; label: string };

export function StatsStrip({
  title,
  caption,
  stats,
}: {
  title: string | null;
  caption?: string;
  stats: readonly Stat[];
}) {
  return (
    <section>
      {title ? <h2>{title}</h2> : null}
      <dl>
        {stats.map((s) => (
          <div key={s.label}>
            <dt>{s.label}</dt>
            <dd>{s.value}</dd>
          </div>
        ))}
      </dl>
      {caption ? <p>{caption}</p> : null}
    </section>
  );
}
