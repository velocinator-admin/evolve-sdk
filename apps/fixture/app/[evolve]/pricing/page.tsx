import { evolveMetadata, evolveStaticParams, Optimizable, withEvolve } from "next-evolve";
import PricingCta from "@/components/pricing-cta";

export const revalidate = 3600;
export const dynamicParams = true;
export const generateStaticParams = evolveStaticParams;
export const generateMetadata = evolveMetadata("/pricing", { title: "Pricing · Acme" });

function Pricing() {
  return (
    <section>
      <h1>Pricing</h1>
      <p>Pro: $49/month</p>
      <Optimizable id="pricing-cta" component={PricingCta} props={{ label: "Get started" }} />
    </section>
  );
}

export default withEvolve(Pricing, { path: "/pricing" });
