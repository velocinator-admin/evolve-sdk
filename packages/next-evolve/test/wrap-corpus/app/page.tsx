import { Hero } from "../components/hero";
import { LogoCloud } from "../components/logo-cloud";
import { SiteFooter } from "../components/site-footer";
import { Testimonial, type TestimonialProps } from "../components/testimonial";

const more: TestimonialProps[] = [
  { quote: "Setup took ten minutes.", author: "Sam", rating: 5 },
  { quote: "Our signups went up.", author: "Ana", jobTitle: "Founder", rating: 4 },
];

export default function Home() {
  return (
    <main>
      <Hero
        title="Ship experiments without the flicker"
        subtitle="Server-side variants for Next.js, measured in your own Postgres."
        ctaLabel="Start free"
        ctaHref="/signup"
        className="hero"
      />
      <LogoCloud heading="Trusted by teams at" logos={["Acme", "Globex", "Initech"]} grayscale />
      <Testimonial
        quote="We stopped arguing about copy and started testing it."
        author="Dana Lee"
        jobTitle="Head of Growth"
        rating={5}
        avatarUrl="/dana.png"
      />
      {more.map((t) => (
        <Testimonial key={t.author} {...t} />
      ))}
      <SiteFooter />
    </main>
  );
}
