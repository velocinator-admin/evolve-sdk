import type { ReactNode } from "react";

export default ({ quote, source, icon }: { quote: string; source: string; icon?: ReactNode }) => (
  <blockquote>
    {icon}
    <p>{quote}</p>
    <cite>{source}</cite>
  </blockquote>
);
