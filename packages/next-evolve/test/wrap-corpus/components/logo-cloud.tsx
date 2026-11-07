export function LogoCloud({
  heading,
  logos,
  grayscale,
}: {
  heading: string;
  logos: string[];
  grayscale: boolean;
}) {
  return (
    <section style={{ filter: grayscale ? "grayscale(1)" : undefined }}>
      <h2>{heading}</h2>
      <ul>
        {logos.map((name) => (
          <li key={name}>{name}</li>
        ))}
      </ul>
    </section>
  );
}
