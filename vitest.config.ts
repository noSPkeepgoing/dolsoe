import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@contract": path.join(root, "docs/contract") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "docs/contract/**/*.test.ts"],
  },
});
