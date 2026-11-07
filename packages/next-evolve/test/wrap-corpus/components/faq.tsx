import type { ReactNode } from "react";

type FaqItem = { question: string; answer: ReactNode };

export default function Faq(props: { title: string; items: FaqItem[]; defaultOpen?: number }) {
  return (
    <section>
      <h2>{props.title}</h2>
      {props.items.map((item, i) => (
        <details key={item.question} open={i === props.defaultOpen}>
          <summary>{item.question}</summary>
          <div>{item.answer}</div>
        </details>
      ))}
    </section>
  );
}
