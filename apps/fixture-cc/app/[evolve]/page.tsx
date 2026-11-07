import { cacheLife } from "next/cache";
import {
  type EvolvePageProps,
  evolveMetadata,
  evolveStaticParams,
  Optimizable,
  withEvolve,
} from "next-evolve";
import Hero from "@/components/hero";

// Static mode with cacheComponents: no segment config (Next rejects it); the
// page is cached once per variant code by "use cache", keyed on params.
export const generateStaticParams = evolveStaticParams;
export const generateMetadata = evolveMetadata("/", { title: "Acme CC" });

function Home() {
  return (
    <>
      <Optimizable
        id="hero"
        component={Hero}
        props={{ title: "Ship faster", cta: "Start free", href: "/pricing" }}
      />
      {/* Fixture-only: when this render was cached (e2e proves one entry per code). */}
      <p data-testid="rendered-at">{Date.now()}</p>
    </>
  );
}

const EvolveHome = withEvolve(Home, { path: "/" });

export default async function Page({ params }: EvolvePageProps) {
  "use cache";
  cacheLife("hours");
  return <EvolveHome params={params} />;
}
