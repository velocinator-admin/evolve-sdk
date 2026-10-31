import { evolveMetadata, evolveStaticParams, Optimizable, withEvolve } from "next-evolve";
import Hero from "@/components/hero";

export const revalidate = 3600;
export const dynamicParams = true;
export const generateStaticParams = evolveStaticParams;
export const generateMetadata = evolveMetadata("/", { title: "Acme" });

function Home() {
  return (
    <Optimizable
      id="hero"
      component={Hero}
      props={{ title: "Ship faster", cta: "Start free", href: "/signup" }}
    />
  );
}

export default withEvolve(Home, { path: "/" });
