import type { ComponentProps } from "react";

type PricingCardProps = ComponentProps<"section"> & {
  plan: string;
  price: number;
  currency: "USD" | "EUR";
  features: string[];
  popular?: boolean;
};

export function PricingCard({
  plan,
  price,
  currency,
  features,
  popular,
  ...rest
}: PricingCardProps) {
  return (
    <section {...rest} data-popular={popular || undefined}>
      <h3>{plan}</h3>
      <p>
        {currency === "USD" ? "$" : "€"}
        {price}/mo
      </p>
      <ul>
        {features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </section>
  );
}
