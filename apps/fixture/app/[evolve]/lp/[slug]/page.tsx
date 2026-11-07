import { evolveMetadata, evolveStaticParams, Optimizable, withEvolve } from "next-evolve";
import Hero from "@/components/hero";

export const revalidate = 3600;
export const dynamicParams = true;
export const generateStaticParams = evolveStaticParams;
export const generateMetadata = evolveMetadata("/lp/:slug", { title: "Landing · Acme" });

async function Landing({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <section>
      <p data-testid="slug">{slug}</p>
      <Optimizable
        id="lp-hero"
        component={Hero}
        props={{ title: `Landing ${slug}`, cta: "Start" }}
      />
    </section>
  );
}

export default withEvolve(Landing, { path: "/lp/:slug" });
