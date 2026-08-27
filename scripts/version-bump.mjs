#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));

if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) throw new Error(`Unsupported package version: ${packageJson.version}`);
manifest.version = packageJson.version;
versions[packageJson.version] = manifest.minAppVersion;

const orderedVersions = Object.fromEntries(Object.entries(versions).sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true })));
await writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile("versions.json", `${JSON.stringify(orderedVersions, null, 2)}\n`);
