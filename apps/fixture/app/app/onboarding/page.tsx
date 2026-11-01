import { redirect } from "next/navigation";
import { evolve } from "next-evolve/server";

// Server-side identify + track (spec §18 scenario 7): a server action links the
// visitor's evolve_id cookie to a user id and records an event in the customer DB.
async function finish(form: FormData) {
  "use server";
  const email = String(form.get("email") ?? "");
  await evolve.identify(`user:${email}`);
  await evolve.track("onboarding_done");
  redirect("/app/onboarding?done=1");
}

export default async function Onboarding({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  const { done } = await searchParams;
  return (
    <>
      <h1>Onboarding</h1>
      <form action={finish}>
        <input name="email" type="email" placeholder="you@company.com" required />
        <button type="submit">Finish onboarding</button>
      </form>
      {done ? <p data-testid="onboarding-done">All set</p> : null}
    </>
  );
}
