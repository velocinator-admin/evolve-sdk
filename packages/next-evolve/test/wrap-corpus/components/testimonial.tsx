import Image from "next/image";

export type TestimonialProps = {
  quote: string;
  author: string;
  jobTitle?: string;
  rating: number;
  avatarUrl?: string;
};

export function Testimonial({ quote, author, jobTitle, rating, avatarUrl }: TestimonialProps) {
  return (
    <figure>
      {avatarUrl ? <Image src={avatarUrl} alt={author} width={48} height={48} /> : null}
      <blockquote>{quote}</blockquote>
      <figcaption>
        {author}
        {jobTitle ? `, ${jobTitle}` : ""} · {"★".repeat(rating)}
      </figcaption>
    </figure>
  );
}
