import { Optimizable } from "next-evolve";
import SlowHero from "@/components/slow-hero";

// Fixture-only (T17.4): experiment s1ow01's slow arm delays the hero image, the LCP element.
export default function Slow() {
  return (
    <Optimizable
      id="slow-hero"
      component={SlowHero}
      props={{ title: "Fixture: Core Web Vitals", slowImageMs: 0 }}
    />
  );
}
