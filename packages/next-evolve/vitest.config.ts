import { defineConfig } from "vitest/config";

const resolve = {
  // `server-only` throws outside a React Server environment; tests run in plain Node.
  alias: { "server-only": new URL("./test/empty.ts", import.meta.url).pathname },
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: { name: "unit", include: ["src/**/*.test.{ts,tsx}"], exclude: ["**/*.int.test.ts"] },
      },
      {
        resolve,
        // Integration tests share one customer DB (EVOLVE_DATABASE_URL); run files one at a time.
        test: { name: "integration", include: ["src/**/*.int.test.ts"], fileParallelism: false },
      },
    ],
  },
});
