import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    // Start with a single node-env project. When component tests land, split
    // into two projects (node for api/, jsdom for app/).
    environment: "node",
    include: [
      "api/**/*.test.ts",
      "shared/**/*.test.ts",
      "scripts/**/*.test.ts",
      "app/src/**/*.test.{ts,tsx}",
    ],
    passWithNoTests: true,
  },
});
