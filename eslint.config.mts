import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules/",
    "dist/",
    "esbuild.config.mjs",
    "scripts/",
    "tests/",
    "vitest.config.ts"
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mts", "stylelint.config.mjs", "manifest.json"]
        },
        tsconfigRootDir: import.meta.dirname as string,
        extraFileExtensions: [".json"]
      }
    }
  },
  ...obsidianmd.configs.recommended
);
