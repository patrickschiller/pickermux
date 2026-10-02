#!/usr/bin/env node

import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PICKERMUX_DMG_ASSET, PICKERMUX_RELEASE_REPOSITORY, dmgReleaseMarker, parseDmgReleaseRecord } from "../src/companion-release.mjs";

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/u;
const HASH = /^[a-f0-9]{64}$/u;
const ASSETS = [PICKERMUX_DMG_ASSET, "release-notes.md", "SHA256SUMS"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const RELEASE_HIGHLIGHTS = Object.freeze({
  "0.20.0": [
    "- View each external provider's input, output and total tokens in the menu-bar panel.",
    "- Compare the last finalized request with cumulative reported usage **since bridge start**. Totals reset when the bridge restarts.",
    "- Count ordinary model requests and context compaction observed through PickerMux. Native Codex inference, native web search and marked certification requests are excluded.",
    "- Show unavailable or incomplete usage when a provider omits counts, a stream is interrupted or usage cannot be safely observed. Missing counts are never treated as zero.",
    "- Keep token counters in bridge memory; no prompts, response text, credentials or request identifiers are persisted for this feature.",
  ],
  "0.20.1": [
    "- Fix the collapsed menu-bar viewport that could hide controls and token values after upgrading to 0.20.0.",
    "- Keep menu content in a fixed 400-by-600-point panel with vertical scrolling so provider totals, installation details and available actions remain reachable.",
    "- Preserve the existing per-provider last-request and since-bridge-start token counts; this patch changes the menu layout.",
  ],
  "0.21.0": [
    "- Use native macOS menu controls with direct Refresh picker, Open Codex, Check status and Check installation actions, specific feedback, and a persistent Settings, Help and Quit footer.",
    "- Keep per-provider input, output and total usage across bridge restarts, refreshes and backend upgrades. Show cumulative reported usage **since reset** and retain the last model request.",
    "- Add **Settings → Token usage → Reset accumulated counts…** to clear cumulative counts explicitly while retaining the last model request.",
    "- Save validated provider usage in private local storage; prompts, response text, credentials, endpoints and request identifiers remain excluded.",
    "- Fix a false Integration needs review conflict caused by one valid Codex service_tier setting inside PickerMux's marked root block, while retaining receipt verification and preserving the setting.",
  ],
});

function fail() {
  throw new Error("DMG publication requires an intact, Developer ID signed and notarized build of the exact release version.");
}

function tagVersion(tag) {
  const version = typeof tag === "string" ? tag.slice(1) : "";
  if (tag !== `v${version}` || !VERSION.test(version)) fail();
  return version;
}

async function regularDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail();
}

async function readRegular(file, maximum) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum || before.size < 0) fail();
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (contents.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
    return contents;
  } finally {
    await handle.close();
  }
}

function checksums(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const result = new Map();
  for (const line of text.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]{1,120})$/u.exec(line);
    if (!match || result.has(match[2])) fail();
    result.set(match[2], match[1]);
  }
  return result;
}

export async function prepareDmgRelease({ sourceDirectory, outputDirectory, tag }) {
  const version = tagVersion(tag);
  const source = path.resolve(sourceDirectory);
  const output = path.resolve(outputDirectory);
  await regularDirectory(source);
  const manifestBytes = await readRegular(path.join(source, "companion-manifest.json"), 256 * 1024);
  let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch { fail(); }
  const versionedName = `PickerMux-v${version}-macos-universal.dmg`;
  const archiveName = `PickerMux-v${version}-macos-universal.tar.gz`;
  if (manifest?.schemaVersion !== 1 || manifest.product !== "pickermux-companion" || manifest.version !== version ||
    manifest.minimumMacOS !== "13.0" || !Array.isArray(manifest.architectures) || manifest.architectures.join(",") !== "arm64,x86_64" ||
    manifest.signing !== "developer-id-notarized" || !HASH.test(manifest.backendManifestSha256 ?? "") ||
    manifest.archive !== archiveName || !HASH.test(manifest.archiveSha256 ?? "") ||
    manifest.diskImage?.file !== versionedName || !HASH.test(manifest.diskImage.sha256 ?? "") ||
    manifest.diskImage.format !== "UDZO" || manifest.diskImage.filesystem !== "HFS+" || manifest.diskImage.installation !== "drag-to-applications") fail();
  const sums = checksums(await readRegular(path.join(source, "SHA256SUMS"), 4096));
  if (sums.size !== 3 || sums.get(versionedName) !== manifest.diskImage.sha256 ||
    sums.get(archiveName) !== manifest.archiveSha256 || sums.get("companion-manifest.json") !== hash(manifestBytes)) fail();
  const diskImage = await readRegular(path.join(source, versionedName), 256 * 1024 * 1024);
  const sha256 = hash(diskImage);
  if (sha256 !== manifest.diskImage.sha256) fail();
  const highlights = RELEASE_HIGHLIGHTS[version];
  const notes = `PickerMux ${tag} is distributed as one universal macOS DMG.\n\n` +
    (highlights ? `Changes in ${tag}:\n\n${highlights.join("\n")}\n\n` : "") +
    `Download **${PICKERMUX_DMG_ASSET}**, open it, and drag PickerMux into Applications. ` +
    `For a first installation, eject the disk image, open PickerMux from Applications and enable **Use PickerMux in Codex** to install the bundled backend. ` +
    `Keep Codex fully quit and your provider models available during setup.\n\n` +
    `Requires macOS 13 or newer and Node.js 22.15 or newer. Supports Apple silicon and Intel. ` +
    `The app and disk image are Developer ID signed, notarized and stapled.\n\n` +
    `Existing users quit PickerMux, replace the app in Applications, eject the disk image and reopen PickerMux from Applications. ` +
    `Keep Codex fully quit and your provider models available, then choose **Settings → Update installed backend…** when offered to review and apply the bundled backend upgrade. ` +
    `Custom provider settings are preserved.\n\n` +
    `[App guide](${PICKERMUX_RELEASE_REPOSITORY}/blob/${tag}/README.md) · ` +
    `[Technical guide](${PICKERMUX_RELEASE_REPOSITORY}/blob/${tag}/docs/TECHNICAL_GUIDE.md)\n\n` +
    `SHA-256:\n\n\`\`\`text\n${sha256}  ${PICKERMUX_DMG_ASSET}\n\`\`\`\n\n` +
    `${dmgReleaseMarker({ version, sha256 })}\n\n` +
    `PickerMux is an unofficial community project, unaffiliated with OpenAI, Codex or LM Studio.\n`;
  // A fresh directory is the commit boundary. Never replace a candidate that
  // another release run or a contributor has already created.
  await mkdir(output, { mode: 0o700 });
  // Failed candidates remain unpublished. Do not recursively remove a path
  // that another local process could have replaced after directory creation.
  await writeFile(path.join(output, PICKERMUX_DMG_ASSET), diskImage, { flag: "wx", mode: 0o644 });
  await writeFile(path.join(output, "release-notes.md"), notes, { flag: "wx", mode: 0o644 });
  await writeFile(path.join(output, "SHA256SUMS"), `${sha256}  ${PICKERMUX_DMG_ASSET}\n`, { flag: "wx", mode: 0o644 });
  await verifyDmgPublication({ directory: output, tag });
  return { version, diskImage: PICKERMUX_DMG_ASSET, sha256, signing: manifest.signing };
}

export async function verifyDmgPublication({ directory, tag }) {
  const version = tagVersion(tag);
  const root = path.resolve(directory);
  await regularDirectory(root);
  const entries = (await readdir(root)).sort();
  if (entries.join("\n") !== [...ASSETS].sort().join("\n")) fail();
  const sums = checksums(await readRegular(path.join(root, "SHA256SUMS"), 4096));
  const diskImage = await readRegular(path.join(root, PICKERMUX_DMG_ASSET), 256 * 1024 * 1024);
  const sha256 = hash(diskImage);
  if (sums.size !== 1 || sums.get(PICKERMUX_DMG_ASSET) !== sha256) fail();
  const notes = new TextDecoder("utf-8", { fatal: true }).decode(await readRegular(path.join(root, "release-notes.md"), 64 * 1024));
  const record = parseDmgReleaseRecord(notes, { version, file: PICKERMUX_DMG_ASSET });
  if (record.sha256 !== sha256) fail();
  return { version, diskImage: PICKERMUX_DMG_ASSET, sha256, signing: record.signing };
}

async function main(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!["--source", "--output", "--tag", "--verify"].includes(key) || options[key] !== undefined || !argv[index + 1]) fail();
    options[key] = argv[index + 1];
  }
  const verify = options["--verify"];
  if (verify ? options["--source"] || options["--output"] : !options["--source"] || !options["--output"]) fail();
  const result = verify
    ? await verifyDmgPublication({ directory: verify, tag: options["--tag"] })
    : await prepareDmgRelease({ sourceDirectory: options["--source"], outputDirectory: options["--output"], tag: options["--tag"] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write("prepare-dmg-release: DMG release validation failed; nothing can be published.\n");
    process.exitCode = 1;
  });
}
