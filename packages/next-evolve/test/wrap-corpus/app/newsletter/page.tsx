import NewsletterSignup from "../../components/newsletter-signup";
import { StatsStrip } from "../../components/stats-strip";

export default function NewsletterPage() {
  return (
    <main>
      <NewsletterSignup
        headline="Get one growth experiment a week"
        placeholder="you@company.com"
        submitLabel="Subscribe"
      />
      <StatsStrip
        title={null}
        caption="Numbers from the last 30 days"
        stats={[
          { value: "12k", label: "readers" },
          { value: "48%", label: "open rate" },
        ]}
      />
    </main>
  );
}
