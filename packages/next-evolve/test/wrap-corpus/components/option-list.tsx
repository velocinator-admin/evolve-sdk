export function OptionList<T extends string>({ title, options }: { title: string; options: T[] }) {
  return (
    <section>
      <h2>{title}</h2>
      <ul>
        {options.map((o) => (
          <li key={o}>{o}</li>
        ))}
      </ul>
    </section>
  );
}
