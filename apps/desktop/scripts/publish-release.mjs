#!/usr/bin/env node
// Publishes the signed artifacts in release/ as a GitHub prerelease, deterministically:
// tag first, then the release with every asset and the update manifest. electron-builder's own
// publisher posts the release before the tag exists and fails with 422 (see docs/release.md).
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const dir = "release";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const notes = process.argv[2];
if (!notes) { console.error("usage: publish-release.mjs <notes.md>"); process.exit(2); }

const present = readdirSync(dir);
const files = present.filter((f) => f.startsWith(`Quire-${version}-`) && /\.(dmg|zip)$/.test(f));
if (files.length < 4) throw new Error(`Expected the four dmg/zip artifacts for ${version} in ${dir}; found ${files.join(", ") || "none"}`);
const sha512 = (f) => createHash("sha512").update(readFileSync(join(dir, f))).digest("base64");
const zips = files.filter((f) => f.endsWith(".zip")); const dmgs = files.filter((f) => f.endsWith(".dmg"));
const ordered = [...zips.filter((f) => f.includes("x64")), ...zips.filter((f) => f.includes("arm64")), ...dmgs.filter((f) => f.includes("x64")), ...dmgs.filter((f) => f.includes("arm64"))];
const entries = ordered.map((f) => ({ url: f, sha512: sha512(f), size: statSync(join(dir, f)).size }));
const manifest = ["version: " + version, "files:", ...entries.flatMap((e) => [`  - url: ${e.url}`, `    sha512: ${e.sha512}`, `    size: ${e.size}`]), `path: ${entries[0].url}`, `sha512: ${entries[0].sha512}`, `releaseDate: '${new Date().toISOString()}'`, ""].join("\n");
writeFileSync(join(dir, "latest-mac.yml"), manifest);

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
try { execFileSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { stdio: "ignore" }); } catch { run("git", ["tag", tag]); }
run("git", ["push", "origin", tag]);
const assets = [...ordered, ...ordered.map((f) => `${f}.blockmap`).filter((f) => present.includes(f)), "latest-mac.yml"].map((f) => join(dir, f));
const prerelease = /alpha|beta|rc/.test(version);
run("gh", ["release", "create", tag, ...assets, "--title", `Quire ${version}`, "--notes-file", notes, ...(prerelease ? ["--prerelease"] : ["--latest"])]);
console.log(`Published ${tag} with ${assets.length} assets`);
