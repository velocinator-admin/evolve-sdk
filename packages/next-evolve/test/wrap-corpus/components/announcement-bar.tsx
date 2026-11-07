import type { ReactNode } from "react";

export enum BarTheme {
  Light = "light",
  Dark = "dark",
}

type AnnouncementBarProps = {
  children: ReactNode;
  variant?: "neutral" | "promo";
  dismissible?: boolean;
  theme?: BarTheme;
};

export function AnnouncementBar({ children, variant = "neutral", theme }: AnnouncementBarProps) {
  return (
    <div role="status" data-variant={variant} data-theme={theme}>
      {children}
    </div>
  );
}
