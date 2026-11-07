import type { ReactNode } from "react";

export function FeatureGrid({
  heading,
  features,
  columns = 3,
  icons,
}: {
  heading: string;
  features: string[];
  columns?: 2 | 3 | 4;
  icons?: Record<string, ReactNode>;
}) {
  return (
    <section>
      <h2>{heading}</h2>
      <ul style={{ display: "grid", gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {features.map((f) => (
          <li key={f}>
            {icons?.[f]}
            {f}
          </li>
        ))}
      </ul>
    </section>
  );
}
