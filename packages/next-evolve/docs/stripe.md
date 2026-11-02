# Stripe recipe: count paid subscriptions as a goal

Goal: "did the visitor who saw this variant start paying within 30 days, and how much?" Evolve doesn't connect to Stripe. You record the payment as an event from your own Stripe webhook handler, and link the Stripe customer to the visitor with `identify`.

## 1. Link the visitor to your user

When the visitor signs up (or signs in), link their browser to your user id. In a server action or route handler:

```ts
import { evolve } from "next-evolve/server";

await evolve.identify(user.id);
```

## 2. Put your user id on the Stripe objects

When you create the Checkout Session, carry your user id through to the subscription and its invoices:

```ts
await stripe.checkout.sessions.create({
  mode: "subscription",
  client_reference_id: user.id,
  subscription_data: { metadata: { userId: user.id } },
  // line_items, success_url, …
});
```

## 3. Record the payment in your webhook handler

After you verify the signature, call `evolve.track` with the user id. Use the Stripe event id as `dedupeKey`: Stripe retries deliveries, and Evolve stores each key once.

```ts
// app/api/stripe/route.ts
import Stripe from "stripe";
import { evolve } from "next-evolve/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  const event = stripe.webhooks.constructEvent(
    await req.text(),
    req.headers.get("stripe-signature")!,
    process.env.STRIPE_WEBHOOK_SECRET!,
  );

  if (event.type === "invoice.paid") {
    const invoice = event.data.object;
    const userId = invoice.parent?.subscription_details?.metadata?.userId;
    if (userId && invoice.billing_reason === "subscription_create") {
      await evolve.track("subscription_started", {
        userId,
        source: "stripe",
        props: { amount: invoice.amount_paid / 100, currency: invoice.currency },
        dedupeKey: event.id,
      });
    }
  }
  return new Response(null, { status: 200 });
}
```

Where the metadata sits on the invoice depends on your Stripe API version; check one `invoice.paid` payload in the Stripe dashboard. `billing_reason === "subscription_create"` counts the first payment only; drop it to count renewals too.

The webhook request has no Evolve cookie, so `userId` is what connects the payment to the visitor (through step 1).

## 4. Define the goal

```ts
// evolve.goals.ts
import { defineGoals } from "next-evolve/config";

export default defineGoals({
  paid: {
    event: "subscription_started",
    source: "stripe",
    window: "30d",
    value: "amount", // revenue per visitor; omit for conversion rate
  },
});
```

`value` can also be a function, e.g. to convert currencies: `value: (e) => toUsd(e.props.amount as number, e.props.currency as string)`. It runs in your app when the event is written.

Restart the app (or run `npx next-evolve push`) so the cloud sees the new goal, then pick `paid` as the primary or a secondary goal when you create an experiment.

## Notes

- Use `unit: "user"` if people often sign up on one device and pay on another.
- Payments are attributed to the variant the visitor first saw, if they happen within 30 days of that first exposure.
- Nothing about the payment leaves your server except the aggregate counts and sums per variant.
- Using Segment or another service instead? Send the same event to `POST /api/evolve/track` ([API](api.md#http-routes)).
