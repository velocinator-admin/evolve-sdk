import { evolveMetadata, evolveStaticParams, Optimizable, withEvolve } from "next-evolve";
import Hero from "@/components/hero";

// TPL-1 (T29.1/T29.2): a person page under a regex-constrained route. The
// proxy serves it for /Christopher-G but not /pricing; variant copy uses
// `{name}` (the route param) and `{fullName}` (the vars prop, like CMS data).
const PERSON_ROUTE = "/:name([A-Z][A-Za-z]*-[A-Za-z-]+)";

export const revalidate = 3600;
export const dynamicParams = true;
export const generateStaticParams = evolveStaticParams;
export const generateMetadata = evolveMetadata(PERSON_ROUTE, { title: "Agent · Acme" });

async function Person({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  // "No-Profile" stands in for a page whose CMS record lacks the field: the
  // variant needs {fullName}, so that page renders control, uncounted.
  const fullName = name === "No-Profile" ? undefined : name.replace(/-/g, " ");
  return (
    <section>
      <p data-testid="person">{name}</p>
      <Optimizable
        id="person-hero"
        component={Hero}
        props={{ title: `Meet ${name}`, cta: "Contact" }}
        vars={{ fullName }}
      />
    </section>
  );
}

export default withEvolve(Person, { path: PERSON_ROUTE });
