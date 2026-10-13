import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tools/*connectors.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
