import type { Metadata } from "next";
import HeroSplit from "../../../components/hero-split";

export const metadata: Metadata = { title: "Our story" };

function StoryIntro({ heading, body }: { heading: string; body: string }) {
  return (
    <section>
      <h2>{heading}</h2>
      <p>{body}</p>
    </section>
  );
}

export default async function StoryPage() {
  return (
    <main>
      <HeroSplit
        title="Built by people who ran too many A/B tests by hand"
        description="Evolve started as a script on one landing page."
        image={{ src: "/team.jpg", alt: "The team" }}
      />
      <StoryIntro
        heading="Why we built it"
        body="Every test needed a developer, a deploy and a spreadsheet. We wanted none of that."
      />
    </main>
  );
}
