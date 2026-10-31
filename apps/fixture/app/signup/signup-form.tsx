"use client";

import { identify } from "next-evolve/client";
import { useState } from "react";

export function SignupForm() {
  const [done, setDone] = useState(false);
  return (
    <form
      data-evolve-goal="signup_submit"
      onSubmit={(e) => {
        e.preventDefault();
        const email = new FormData(e.currentTarget).get("email");
        identify(`user:${String(email)}`);
        setDone(true);
      }}
    >
      <input name="email" type="email" placeholder="you@example.com" required />
      <button type="submit">Create account</button>
      {done ? <p data-testid="signup-done">Welcome!</p> : null}
    </form>
  );
}
