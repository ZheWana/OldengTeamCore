import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const packagePath = require.resolve("obsidian-plugin-validator/package.json");
const cliPath = path.join(path.dirname(packagePath), "bin", "cli.mjs");
// `lint:code` is the canonical source gate: it runs the Obsidian recommended
// rules with this project's current TypeScript compiler and full type data.
// The packaged validator remains responsible for Obsidian manifest/submission
// checks, without repeating source lint through its separately bundled stack.
const result = spawnSync(process.execPath, [cliPath, ".", "--no-lint"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: { ...process.env, NO_COLOR: "1" }
});

process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const summary = output.match(/(\d+) error\(s\),\s*(\d+) warning\(s\)/);
if (!summary) {
  console.error("Could not read the Obsidian validator summary; failing closed.");
  process.exit(1);
}

const errors = Number(summary[1]);
const warnings = Number(summary[2]);
if (errors > 0 || warnings > 0) {
  console.error(`Obsidian lint failed with ${errors} error(s) and ${warnings} warning(s).`);
  process.exit(1);
}
