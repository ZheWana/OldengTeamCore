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
        // Node's import.meta.dirname is available in the lint process but is
        // not modeled by the parser's project service in this config file.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- import.meta.dirname is typed by Node at runtime but not by the parser project service
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"]
      }
    }
  },
  ...obsidianmd.configs.recommended
);
