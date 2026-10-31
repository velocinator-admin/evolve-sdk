import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // `server-only` throws outside a React Server environment; tests run in plain Node.
    alias: { "server-only": new URL("./test/empty.ts", import.meta.url).pathname },
  },
});
