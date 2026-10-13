import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/server/src/**/*.test.ts", "skills/*/server/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.connectors.test.ts"],
    environment: "node",
    testTimeout: 20000,
    // server tests load every skill in beforeAll; allow for a busy machine
    hookTimeout: 60000,
  },
});
