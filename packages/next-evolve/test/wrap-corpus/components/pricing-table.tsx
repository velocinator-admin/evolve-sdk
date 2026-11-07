type Plan = { id: "basic" | "pro" | "team"; name: string; price: number; features: string[] };

type PricingTableProps = {
  heading: string;
  plans: Plan[];
  highlight?: Plan["id"];
  billing: "monthly" | "yearly";
  showAnnualToggle?: boolean;
};

export default function PricingTable({
  heading,
  plans,
  highlight,
  billing,
  showAnnualToggle,
}: PricingTableProps) {
  return (
    <section>
      <h2>{heading}</h2>
      {showAnnualToggle ? <p>Billed {billing}</p> : null}
      <ul>
        {plans.map((p) => (
          <li key={p.id} data-highlight={p.id === highlight || undefined}>
            <h3>{p.name}</h3>
            <p>${billing === "yearly" ? p.price * 10 : p.price}</p>
            <ul>
              {p.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
