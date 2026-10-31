import { optimizable } from "next-evolve";
import { z } from "zod";

export const heroSchema = z.object({
  title: z.string().min(3).max(60).meta({ label: "Headline" }),
  subtitle: z.string().max(140).optional(),
  cta: z.string().min(2).max(24).meta({ label: "Button text" }),
  layout: z.enum(["left", "center"]).default("left"),
});

function Hero(props: z.infer<typeof heroSchema> & { href?: string }) {
  return (
    <section style={{ textAlign: props.layout === "center" ? "center" : "left" }}>
      <h1 data-testid="hero-title">{props.title}</h1>
      {props.subtitle ? <p data-testid="hero-subtitle">{props.subtitle}</p> : null}
      <a href={props.href ?? "/signup"} data-testid="hero-cta" data-evolve-goal="cta_click">
        {props.cta}
      </a>
    </section>
  );
}

export default optimizable(Hero, heroSchema);
