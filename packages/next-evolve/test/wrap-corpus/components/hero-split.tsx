import Image from "next/image";

type HeroSplitProps = {
  title: string;
  description: string;
  image: { src: string; alt: string };
  reverse?: boolean;
};

async function loadBadge(): Promise<string> {
  return "New";
}

export default async function HeroSplit({ title, description, image, reverse }: HeroSplitProps) {
  const badge = await loadBadge();
  return (
    <section style={{ flexDirection: reverse ? "row-reverse" : "row" }}>
      <div>
        <span>{badge}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <Image src={image.src} alt={image.alt} width={640} height={480} />
    </section>
  );
}
