"use client";

import { type FormEvent, useState } from "react";

export default function NewsletterSignup({
  headline,
  placeholder,
  submitLabel,
  successMessage = "Thanks! Check your inbox.",
}: {
  headline: string;
  placeholder: string;
  submitLabel: string;
  successMessage?: string;
}) {
  const [done, setDone] = useState(false);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setDone(true);
  };
  if (done) return <p>{successMessage}</p>;
  return (
    <form onSubmit={onSubmit}>
      <h2>{headline}</h2>
      <input type="email" name="email" placeholder={placeholder} aria-label="Email" />
      <button type="submit">{submitLabel}</button>
    </form>
  );
}
