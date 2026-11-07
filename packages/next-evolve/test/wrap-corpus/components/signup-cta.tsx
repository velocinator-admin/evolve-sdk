import type { FC } from "react";

type SignupCtaProps = { label: string; href: string; size?: "sm" | "md" | "lg" };

export const SignupCta: FC<SignupCtaProps> = ({ label, href, size = "md" }) => (
  <a href={href} data-size={size}>
    {label}
  </a>
);
