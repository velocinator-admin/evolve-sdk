import { optimizable } from "next-evolve";
import { z } from "zod";

// Fixture-only (T17.4): a hero whose large image (the page's LCP element) the
// server delays by `slowImageMs`, so one arm is measurably slower than control.
export const slowHeroSchema = z.object({
  title: z.string().min(3).max(60).meta({ label: "Headline" }),
  slowImageMs: z.number().int().min(0).max(5000).default(0),
});

function SlowHero(props: z.infer<typeof slowHeroSchema>) {
  return (
    <section>
      <p data-testid="slow-title" style={{ fontSize: 12 }}>
        {props.title}
      </p>
      {/* biome-ignore lint/performance/noImgElement: a plain <img> is the point (LCP under test) */}
      <img
        data-testid="slow-image"
        src={`/slow-image?ms=${props.slowImageMs}`}
        width={960}
        height={480}
        alt=""
      />
    </section>
  );
}

export default optimizable(SlowHero, slowHeroSchema);
