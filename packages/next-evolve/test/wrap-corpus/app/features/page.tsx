import { FeatureGrid } from "../../components/feature-grid";
import { ProductHighlight } from "../../components/marketing";
import { SignupCta } from "../../components/signup-cta";

const features = ["No flicker", "Your own Postgres", "Bandits", "AI variants"];

export default function FeaturesPage() {
  return (
    <main>
      <ProductHighlight
        name="Evolve Autopilot"
        tagline="Retires losers and starts the next round for you"
        badge="beta"
        price={49}
        tags={["bandits", "ai"]}
      />
      <FeatureGrid heading="Everything in the box" features={features} columns={2} />
      <SignupCta label="Create your site" href="/signup" size="lg" />
    </main>
  );
}
