import { Optimizable } from "next-evolve";
import Hero from "@/components/hero";

// Dynamic mode: the page stays where it is; the proxy passes the variant code
// in a request header and <Optimizable> reads it.
export default function Features() {
  return (
    <>
      <Optimizable
        id="features-hero"
        component={Hero}
        props={{ title: "Everything you need", cta: "See plans", href: "/pricing" }}
      />
      <ul>
        <li>Server-side variants</li>
        <li>No flicker</li>
      </ul>
    </>
  );
}
