import type { Metadata } from "next";
import Faq from "../../components/faq";
import { PricingCard } from "../../components/pricing-card";
import PricingTable from "../../components/pricing-table";

export const metadata: Metadata = { title: "Pricing" };

const plans = [
  { id: "basic" as const, name: "Basic", price: 0, features: ["1 site"] },
  { id: "pro" as const, name: "Pro", price: 29, features: ["5 sites", "AI variants"] },
];

const cardExtras = { "aria-label": "Team plan", title: "Team" };

export default function PricingPage() {
  return (
    <main>
      <PricingTable heading="Simple pricing" plans={plans} highlight="pro" billing="monthly" />
      <PricingCard
        plan="Team"
        price={99}
        currency="USD"
        features={["Unlimited sites", "SSO"]}
        popular
        className="card"
        {...cardExtras}
      />
      <Faq
        title="Questions"
        items={[
          { question: "Is there a free plan?", answer: "Yes." },
          { question: "Can I cancel?", answer: <strong>Any time.</strong> },
        ]}
        defaultOpen={0}
      />
    </main>
  );
}
