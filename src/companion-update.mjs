import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

import { compareVersions } from "./distribution-installer.mjs";
import { sanitizeCodexDesktopLaunchEnvironment } from "./codex-desktop-state.mjs";
import { PICKERMUX_DMG_ASSET, PICKERMUX_RELEASE_REPOSITORY, parseDmgReleaseRecord } from "./companion-release.mjs";

const execFile = promisify(execFileCallback);
const REPOSITORY = PICKERMUX_RELEASE_REPOSITORY;
const RELEASE_API = "https://api.github.com/repos/patrickschiller/pickermux/releases/latest";
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const REDIRECT_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
const ROOT_FILES = new Set(["package.json", "LICENSE", "lmstudio-picker.config.json"]);

function failure(code = "UPDATE_INVALID") {
  const error = new Error("The PickerMux update could not be safely verified or activated.");
  error.code = code;
  return error;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function responseBytes(response, maximum) {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/u.test(advertised) || Number(advertised) > maximum)) {
    await response.body?.cancel();
    throw failure();
  }
  if (!response.body) throw failure();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw failure();
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function download(url, maximum, fetchImpl, { asset = false } = {}) {
  let current = url;
  // Asset redirects are expected, but only HTTPS GitHub release storage is eligible.
  const signal = AbortSignal.timeout(30_000);
  for (let hop = 0; hop < 4; hop += 1) {
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal,
        headers: { "user-agent": "PickerMux-Companion", accept: asset ? "application/octet-stream" : "application/vnd.github+json" },
      });
    } catch {
      throw failure("UPDATE_UNAVAILABLE");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!asset || !location) throw failure();
      const next = new URL(location, current);
      if (next.protocol !== "https:" || next.username || next.password || next.port || next.hash || !REDIRECT_HOSTS.has(next.hostname)) {
        throw failure();
      }
      current = next.href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw failure("UPDATE_UNAVAILABLE");
    }
    try {
      return await responseBytes(response, maximum);
    } catch (error) {
      if (error?.code === "UPDATE_INVALID") throw error;
      throw failure("UPDATE_UNAVAILABLE");
    }
  }
  throw failure();
}

function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw failure();
  }
}

export async function checkForCompanionUpdate({ currentVersion, fetchImpl = globalThis.fetch } = {}) {
  if (!VERSION.test(currentVersion) || typeof fetchImpl !== "function") throw failure();
  const release = parseJson(await download(RELEASE_API, 1024 * 1024, fetchImpl));
  const targetVersion = typeof release?.tag_name === "string" ? release.tag_name.slice(1) : "";
  if (release?.tag_name !== `v${targetVersion}` || !VERSION.test(targetVersion) || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
    throw failure();
  }
  if (compareVersions(targetVersion, currentVersion) <= 0) {
    return { status: "current", currentVersion, targetVersion: currentVersion };
  }
  const diskImages = release.assets.filter((entry) => entry?.name === PICKERMUX_DMG_ASSET);
  if (diskImages.length > 0) {
    // A disk image is an app replacement, never an executable CLI payload.
    // Its public record binds the exact tag, name, signing gate and checksum.
    if (release.assets.length !== 1 || diskImages.length !== 1) throw failure();
    const asset = diskImages[0];
    const expected = `${REPOSITORY}/releases/download/v${targetVersion}/${asset.name}`;
    if (asset.browser_download_url !== expected) throw failure();
    const record = parseDmgReleaseRecord(release.body, { version: targetVersion, file: asset.name });
    return { status: "available", distribution: "dmg", currentVersion, targetVersion, assets: { [asset.name]: expected }, diskImageSha256: record.sha256 };
  }
  const names = [`pickermux-v${targetVersion}.tar.gz`, "install.sh", "release-manifest.json", "SHA256SUMS"];
  if (release.assets.length !== names.length) throw failure();
  const assets = {};
  for (const name of names) {
    const found = release.assets.filter((entry) => entry?.name === name);
    const expected = `${REPOSITORY}/releases/download/v${targetVersion}/${name}`;
    if (found.length !== 1 || found[0].browser_download_url !== expected) throw failure();
    assets[name] = expected;
  }
  return { status: "available", distribution: "cli-archive", currentVersion, targetVersion, assets };
}

function allowedFile(name) {
  return ROOT_FILES.has(name) || /^src\/[a-z0-9-]+\.mjs$/u.test(name) || /^bin\/(?:pickermux|lmstudio-picker)\.mjs$/u.test(name);
}

function tarString(header, start, width) {
  const field = header.subarray(start, start + width);
  const end = field.indexOf(0);
  const value = end < 0 ? field : field.subarray(0, end);
  if (value.some((byte) => byte < 32 || byte > 126) || (end >= 0 && field.subarray(end).some((byte) => byte !== 0))) {
    throw failure();
  }
  return value.toString("ascii");
}

function tarOctal(header, start, width) {
  const value = header.subarray(start, start + width).toString("ascii").replace(/[\0 ]+$/u, "").trimStart();
  if (!/^[0-7]+$/u.test(value)) throw failure();
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw failure();
  return parsed;
}

/** Accept only the publisher's small ustar contract; no links or extension headers. */
export function inspectCompanionArchive(archive) {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_ARCHIVE_BYTES) throw failure();
  let bytes;
  try {
    bytes = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch {
    throw failure();
  }
  if (bytes.length % 512 !== 0) throw failure();
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (bytes.length - offset < 1024 || bytes.subarray(offset).some((byte) => byte !== 0)) throw failure();
      return entries;
    }
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
    if (sum !== tarOctal(header, 148, 8) || header.subarray(257, 263).toString("ascii") !== "ustar\0" || tarString(header, 345, 155)) throw failure();
    const name = tarString(header, 0, 100);
    const size = tarOctal(header, 124, 12);
    const mode = tarOctal(header, 100, 8);
    const type = header[156];
    if (entries.has(name) || name.includes("\\") || name.includes("..") || size > MAX_EXPANDED_BYTES || offset + 512 + size > bytes.length) throw failure();
    const directory = type === 53;
    if (directory ? !["src/", "bin/"].includes(name) || size !== 0 || mode !== 0o755 : ![0, 48].includes(type) || !(allowedFile(name) || name === "release-manifest.json") || ![0o644, 0o755].includes(mode)) throw failure();
    if (tarString(header, 157, 100)) throw failure();
    const paddedSize = Math.ceil(size / 512) * 512;
    if (bytes.subarray(offset + 512 + size, offset + 512 + paddedSize).some((byte) => byte !== 0)) throw failure();
    entries.set(name, { directory, mode, bytes: bytes.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + paddedSize;
  }
  throw failure();
}

export function verifyCompanionPayload({ archive, manifestBytes, checksumsBytes, version }) {
  if (!VERSION.test(version)) throw failure();
  const archiveName = `pickermux-v${version}.tar.gz`;
  let checksumText;
  try {
    checksumText = new TextDecoder("utf-8", { fatal: true }).decode(checksumsBytes);
  } catch {
    throw failure();
  }
  const checksums = new Map();
  for (const line of checksumText.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  (pickermux-v\d+\.\d+\.\d+\.tar\.gz|release-manifest\.json|install\.sh)$/u.exec(line);
    if (!match || checksums.has(match[2])) throw failure();
    checksums.set(match[2], match[1]);
  }
  if (checksums.size !== 3 || checksums.get(archiveName) !== hash(archive) || checksums.get("release-manifest.json") !== hash(manifestBytes)) throw failure();
  const manifest = parseJson(manifestBytes);
  if (!exactKeys(manifest, ["schemaVersion", "name", "version", "minimumNodeVersion", "archive", "files"]) || manifest.schemaVersion !== 1 || manifest.name !== "pickermux" || manifest.version !== version || manifest.archive !== archiveName || !VERSION.test(manifest.minimumNodeVersion) || !Array.isArray(manifest.files) || manifest.files.length > 512) throw failure();
  const entries = inspectCompanionArchive(archive);
  const insideManifest = entries.get("release-manifest.json");
  if (!insideManifest || !insideManifest.bytes.equals(manifestBytes)) throw failure();
  const inventoried = new Set();
  for (const file of manifest.files) {
    if (!exactKeys(file, ["path", "mode", "size", "sha256"]) || !allowedFile(file.path) || inventoried.has(file.path) || !HASH.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.mode !== (file.path.startsWith("bin/") ? "0755" : "0644")) throw failure();
    const entry = entries.get(file.path);
    if (!entry || entry.directory || entry.mode !== Number.parseInt(file.mode, 8) || entry.bytes.length !== file.size || hash(entry.bytes) !== file.sha256) throw failure();
    inventoried.add(file.path);
  }
  if (![...ROOT_FILES, "bin/pickermux.mjs", "bin/lmstudio-picker.mjs", "src/cli.mjs"].every((name) => inventoried.has(name))) throw failure();
  if ([...entries].some(([name, entry]) => !entry.directory && name !== "release-manifest.json" && !inventoried.has(name))) throw failure();
  const metadata = parseJson(entries.get("package.json").bytes);
  if (metadata.name !== "pickermux" || metadata.version !== version || metadata.engines?.node !== `>=${manifest.minimumNodeVersion}`) throw failure();
  if (compareVersions(process.versions.node, manifest.minimumNodeVersion) < 0) throw failure("UPDATE_UNSUPPORTED");
  return entries;
}

export async function activateVerifiedCompanionPayload({ sourceRoot, targetVersion, environment = process.env, execFileImpl = execFile }) {
  if (!VERSION.test(targetVersion) || typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) throw failure();
  const env = { ...sanitizeCodexDesktopLaunchEnvironment(environment), PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" };
  let stdout;
  let incompleteExit = false;
  try {
    ({ stdout } = await execFileImpl(process.execPath, [path.join(sourceRoot, "bin", "pickermux.mjs"), "setup", "--distribution-root", sourceRoot, "--json"], {
      env, encoding: "utf8", maxBuffer: 512 * 1024, timeout: 60 * 60 * 1000,
    }));
  } catch (error) {
    // setup retains a committed installation when its optional certification
    // remains conservative. Its exact exit-1 envelope distinguishes that state
    // from a failed/aborted installation; child diagnostics never reach the GUI.
    if (error?.code !== 1 || error.killed || error.signal || typeof error.stdout !== "string" || Buffer.byteLength(error.stdout) > 512 * 1024) throw failure();
    stdout = error.stdout;
    incompleteExit = true;
  }
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > 512 * 1024) throw failure();
  const result = parseJson(Buffer.from(stdout));
  if (!VERSION.test(targetVersion) || result?.version !== targetVersion || !["install", "refresh", "upgrade"].includes(result?.activation?.action) || (incompleteExit && result.certification?.status !== "incomplete")) throw failure();
  return { updated: true, restartRequired: true, certificationIncomplete: result.certification?.status === "incomplete" };
}

export async function applyCompanionUpdate({ currentVersion, fetchImpl = globalThis.fetch, activateImpl = activateVerifiedCompanionPayload, environment = process.env, onProgress = () => {} } = {}) {
  onProgress({ phase: "checking" });
  const candidate = await checkForCompanionUpdate({ currentVersion, fetchImpl });
  if (candidate.status === "current") return candidate;
  if (candidate.distribution === "dmg") throw failure("DOWNLOAD_REQUIRED");
  const { targetVersion, assets } = candidate;
  const archiveName = `pickermux-v${targetVersion}.tar.gz`;
  onProgress({ phase: "downloading" });
  const [checksumsBytes, manifestBytes, archive] = await Promise.all([
    download(assets.SHA256SUMS, 4096, fetchImpl, { asset: true }),
    download(assets["release-manifest.json"], 256 * 1024, fetchImpl, { asset: true }),
    download(assets[archiveName], MAX_ARCHIVE_BYTES, fetchImpl, { asset: true }),
  ]);
  onProgress({ phase: "verifying" });
  const entries = verifyCompanionPayload({ archive, manifestBytes, checksumsBytes, version: targetVersion });
  const staging = await mkdtemp(path.join(tmpdir(), "pickermux-companion-update-"));
  try {
    for (const name of ["bin", "src"]) await mkdir(path.join(staging, name), { mode: 0o700 });
    for (const [name, entry] of entries) {
      if (entry.directory) continue;
      await writeFile(path.join(staging, name), entry.bytes, { mode: name.startsWith("bin/") ? 0o700 : 0o600, flag: "wx" });
    }
    onProgress({ phase: "activating" });
    const result = await activateImpl({ sourceRoot: staging, targetVersion, environment });
    return { ...result, status: "updated", currentVersion, targetVersion };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
