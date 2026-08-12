import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    environment: "node",
    include: ["test/**/*.test.ts", "web/**/*.test.ts", "web/**/*.test.tsx"],
  },
});
