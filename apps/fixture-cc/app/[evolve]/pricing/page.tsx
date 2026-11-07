import { cacheLife } from "next/cache";
import {
  type EvolvePageProps,
  evolveMetadata,
  evolveStaticParams,
  Optimizable,
  withEvolve,
} from "next-evolve";
import PricingCta from "@/components/pricing-cta";

export const generateStaticParams = evolveStaticParams;
export const generateMetadata = evolveMetadata("/pricing", { title: "Pricing · Acme CC" });

function Pricing() {
  return (
    <section>
      <h1>Pricing</h1>
      <Optimizable id="pricing-cta" component={PricingCta} props={{ label: "Get started" }} />
      <p data-testid="rendered-at">{Date.now()}</p>
    </section>
  );
}

const EvolvePricing = withEvolve(Pricing, { path: "/pricing" });

export default async function Page({ params }: EvolvePageProps) {
  "use cache";
  cacheLife("hours");
  return <EvolvePricing params={params} />;
}
