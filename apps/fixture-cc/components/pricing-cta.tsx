import { optimizable } from "next-evolve";
import { z } from "zod";

export const pricingCtaSchema = z.object({
  label: z.string().min(2).max(32).meta({ label: "Button label" }),
});

function PricingCta(props: z.infer<typeof pricingCtaSchema>) {
  return (
    <a href="/signup" data-testid="pricing-cta" data-evolve-goal="pricing_cta">
      {props.label}
    </a>
  );
}

export default optimizable(PricingCta, pricingCtaSchema);
