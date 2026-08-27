import esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";

const production = process.argv[2] === "production";

await mkdir("dist", { recursive: true });
await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  platform: "browser",
  target: "es2018",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  outfile: "dist/main.js",
  logLevel: "info"
});
await cp("manifest.json", "dist/manifest.json");
await cp("styles.css", "dist/styles.css");
