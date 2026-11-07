import { OptionList } from "../../components/option-list";
import { PromoButton } from "../../components/promo-button";
import QuoteCard from "../../components/quote-card";

const showPromo = process.env.SHOW_PROMO !== "0";

export default function ExtrasPage() {
  return (
    <main>
      <QuoteCard
        quote="The best test is the one you actually run."
        source="Every growth team"
        icon={<span aria-hidden>“</span>}
      />
      {showPromo && <PromoButton label="Claim 20% off" variant="ghost" aria-label="Claim offer" />}
      <OptionList title="Plans" options={["basic", "pro"]} />
    </main>
  );
}
