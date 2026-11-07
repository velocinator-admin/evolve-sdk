"use client";

import { useState } from "react";

type CtaBannerProps = {
  message: string;
  buttonText: string;
  href: string;
  tone?: "info" | "warning" | "success";
};

export const CtaBanner = ({ message, buttonText, href, tone = "info" }: CtaBannerProps) => {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <aside data-tone={tone}>
      <p>{message}</p>
      <a href={href}>{buttonText}</a>
      <button type="button" onClick={() => setOpen(false)}>
        Dismiss
      </button>
    </aside>
  );
};
