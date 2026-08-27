#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";

const expectedTag = process.argv[2];
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));

if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`Unsupported manifest version: ${manifest.version}`);
if (packageJson.version !== manifest.version) throw new Error("package.json and manifest.json versions differ");
if (versions[manifest.version] !== manifest.minAppVersion) throw new Error("versions.json is missing the current version/minAppVersion mapping");
if (expectedTag && expectedTag !== manifest.version) throw new Error(`Tag ${expectedTag} must exactly match ${manifest.version}`);

const builtManifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
if (JSON.stringify(builtManifest) !== JSON.stringify(manifest)) throw new Error("dist/manifest.json differs from manifest.json");
for (const name of ["main.js", "manifest.json", "styles.css"]) {
  const info = await stat(`dist/${name}`);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing release file: dist/${name}`);
}

console.log(`Release ${manifest.version} is internally consistent`);
