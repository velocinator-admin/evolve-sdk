import { execFileSync } from "node:child_process";
import { expect, test as setup } from "@playwright/test";
import postgres from "postgres";
import { CLOUD_URL, DB_URL, M1_BUNDLE } from "./env";

setup("fresh customer DB, migrated with the CLI", async () => {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  await sql`drop schema if exists evolve cascade`;
  await sql.end();
  execFileSync("pnpm", ["exec", "next-evolve", "migrate"], {
    env: { ...process.env, EVOLVE_DATABASE_URL: DB_URL },
    stdio: "inherit",
  });
});

setup("publish the M1 bundle and wait until the app serves it", async ({ request }) => {
  const pub = await request.post(`${CLOUD_URL}/__control/publish`, { data: M1_BUNDLE });
  expect(pub.ok()).toBe(true);
  // The app's store polls every second (EVOLVE_POLL_SECONDS=1). A bundle is
  // live once a new visitor gets an assignment cookie.
  await expect
    .poll(
      async () => {
        const res = await request.get("/", { headers: { cookie: "" }, maxRedirects: 0 });
        return res.headers()["set-cookie"] ?? "";
      },
      { timeout: 15_000, intervals: [250] },
    )
    .toContain("evolve_a=");
});
