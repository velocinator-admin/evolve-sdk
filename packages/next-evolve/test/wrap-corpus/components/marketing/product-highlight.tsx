export type ProductHighlightProps = {
  name: string;
  tagline: string;
  badge?: "new" | "beta";
  price?: number;
  tags?: readonly string[];
};

export function ProductHighlight({
  name,
  tagline,
  badge,
  price,
  tags = [],
}: ProductHighlightProps) {
  return (
    <article>
      {badge ? <span>{badge}</span> : null}
      <h2>{name}</h2>
      <p>{tagline}</p>
      {price !== undefined ? <p>${price}</p> : null}
      <p>{tags.join(" · ")}</p>
    </article>
  );
}
