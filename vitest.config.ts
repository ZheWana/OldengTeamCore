import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/obsidian-runtime.ts", import.meta.url))
    }
  },
  test: {
    environment: "node"
  }
});
