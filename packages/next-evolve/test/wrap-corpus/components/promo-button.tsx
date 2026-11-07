"use client";

import { type ButtonHTMLAttributes, forwardRef } from "react";

type PromoButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  variant?: "primary" | "ghost";
};

export const PromoButton = forwardRef<HTMLButtonElement, PromoButtonProps>(
  ({ label, variant = "primary", ...rest }, ref) => (
    <button ref={ref} type="button" data-variant={variant} {...rest}>
      {label}
    </button>
  ),
);
PromoButton.displayName = "PromoButton";
