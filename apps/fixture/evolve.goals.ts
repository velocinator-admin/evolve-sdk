import { defineGoals } from "next-evolve/config";

export default defineGoals({
  cta_click: { event: "cta_click", window: "1d" },
  pricing_cta: { event: "pricing_cta", window: "1d" },
  signup_page: { pageview: "/signup", window: "1d" },
  signed_up: { event: "signup_submit", window: "7d" },
  onboarded: { event: "onboarding_done", window: "7d" },
  paid: {
    event: "subscription_started",
    source: "stripe",
    window: "30d",
    value: (e) => Number(e.props.amount),
  },
});
