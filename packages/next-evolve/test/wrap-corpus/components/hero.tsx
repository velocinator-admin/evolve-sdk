import Link from "next/link";

export interface HeroProps {
  title: string;
  subtitle?: string;
  ctaLabel: string;
  ctaHref: string;
  align?: "left" | "center";
  className?: string;
}

export function Hero({ title, subtitle, ctaLabel, ctaHref, align = "left", className }: HeroProps) {
  return (
    <section className={className} style={{ textAlign: align }}>
      <h1>{title}</h1>
      {subtitle ? <p>{subtitle}</p> : null}
      <Link href={ctaHref}>{ctaLabel}</Link>
    </section>
  );
}
