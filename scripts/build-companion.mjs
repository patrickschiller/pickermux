#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { buildRelease } from "./build-release.mjs";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function exists(target) {
  try { await lstat(target); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function regular(target) {
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Companion source must be a regular file");
}

async function sourceFiles(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Companion source directory must be real");
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const target = path.join(directory, entry.name);
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) throw new Error("Companion input must not contain symbolic links");
    if (stat.isDirectory()) files.push(...await sourceFiles(target));
    else if (stat.isFile() && entry.name.endsWith(".swift")) files.push(target);
    else if (!stat.isFile()) throw new Error("Companion input has an unsafe file type");
  }
  return files;
}

export async function executeCommand(executable, arguments_, { cwd, environment, timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"], shell: false });
    let output = Buffer.alloc(0);
    let bytes = 0;
    let diagnostic = Buffer.alloc(0);
    let reason;
    let killTimer;
    const stop = (message) => {
      reason ??= message;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (value) => {
        bytes += value.length;
        if (bytes > 262144) stop("Compiler or signing tool exceeded its output limit");
        else if (stream === child.stdout) output = Buffer.concat([output, value]);
        else if (arguments_.includes("swiftc") || ["/usr/bin/lipo", "/usr/bin/plutil"].includes(executable)) diagnostic = Buffer.concat([diagnostic, value]).subarray(0, 8192);
      });
    }
    const timer = setTimeout(() => stop("Compiler or signing tool timed out"), timeout);
    child.once("error", () => { reason = "Unable to start the required macOS build tool"; });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (reason || code !== 0) {
        let message = reason ?? `The macOS ${path.basename(executable)} build or signing check failed`;
        if (!reason && diagnostic.length > 0) {
          let safeDiagnostic = diagnostic.toString("utf8");
          for (const [directory, label] of [[cwd, "<project>"], [environment?.TMPDIR, "<build>"], [environment?.HOME, "<home>"]]) {
            if (directory && directory !== "/") safeDiagnostic = safeDiagnostic.replaceAll(directory, label);
          }
          message += `\n${safeDiagnostic}`;
        }
        reject(new Error(message));
      }
      else resolve(output.toString("utf8"));
    });
  });
}

function tarHeader(entryPath, size, mode, directory) {
  if (!/^[A-Za-z0-9._/-]+$/u.test(entryPath) || entryPath.startsWith("/") || entryPath.split("/").includes("..")) {
    throw new Error("Companion archive has an unsafe path");
  }
  const header = Buffer.alloc(512);
  let name = entryPath;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const index = name.lastIndexOf("/");
    prefix = name.slice(0, index);
    name = name.slice(index + 1);
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error("Companion archive path exceeds ustar limits");
  header.write(name, 0, 100, "ascii");
  const octal = (value, offset, length) => header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  header.fill(32, 148, 156);
  header[156] = directory ? 53 : 48;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

export async function companionArchive(bundle) {
  const blocks = [];
  const visit = async (target, relative) => {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new Error("Companion archive refuses symbolic links");
    if (metadata.isDirectory()) {
      blocks.push(tarHeader(`${relative}/`, 0, 0o755, true));
      for (const entry of (await readdir(target)).sort()) await visit(path.join(target, entry), `${relative}/${entry}`);
    } else if (metadata.isFile()) {
      const content = await readFile(target);
      const mode = relative.endsWith("/MacOS/PickerMuxCompanion") ? 0o755 : 0o644;
      blocks.push(tarHeader(relative, content.length, mode, false), content);
      const padding = (512 - content.length % 512) % 512;
      if (padding) blocks.push(Buffer.alloc(padding));
    } else throw new Error("Companion archive refuses special files");
  };
  await visit(bundle, "PickerMux.app");
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9, mtime: 0 });
}

export function releaseSigning(environment) {
  const identity = environment.PICKERMUX_SIGNING_IDENTITY;
  const profile = environment.PICKERMUX_NOTARY_PROFILE;
  if (typeof identity !== "string" || !/^Developer ID Application: [^\r\n\0]{1,160} \([A-Z0-9]{10}\)$/u.test(identity)) {
    throw new Error("Release requires PICKERMUX_SIGNING_IDENTITY for a Developer ID Application certificate");
  }
  if (typeof profile !== "string" || !/^[A-Za-z0-9._-]{1,80}$/u.test(profile)) {
    throw new Error("Release requires PICKERMUX_NOTARY_PROFILE for an existing notarytool Keychain profile");
  }
  return { identity, profile };
}

async function notarize(target, command, profile, product) {
  const result = await command("/usr/bin/xcrun", ["notarytool", "submit", target, "--keychain-profile", profile, "--wait", "--output-format", "json"], 1200000);
  let receipt;
  try { receipt = JSON.parse(result); } catch { throw new Error("Notarization did not return its structured result"); }
  if (receipt?.status !== "Accepted") throw new Error(`Apple did not accept the ${product} notarization`);
}

async function bundleInventory(bundle) {
  const entries = [];
  const visit = async (target, relative) => {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new Error("Disk-image app must not contain symbolic links");
    if (metadata.isDirectory()) {
      entries.push({ path: relative, type: "directory", mode: metadata.mode & 0o7777 });
      for (const name of (await readdir(target)).sort()) await visit(path.join(target, name), `${relative}/${name}`);
    } else if (metadata.isFile() && metadata.nlink === 1) {
      const bytes = await readFile(target);
      entries.push({ path: relative, type: "file", mode: metadata.mode & 0o7777, size: bytes.length, sha256: sha256(bytes) });
    } else throw new Error("Disk-image app has an unsafe file type or hard link");
  };
  await visit(bundle, "PickerMux.app");
  return entries;
}

async function toolPropertyList(contents, command, work, name) {
  const file = path.join(work, `${name}.plist`);
  await writeFile(file, contents, { flag: "wx", mode: 0o600 });
  const result = await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]);
  let parsed;
  try { parsed = JSON.parse(result); } catch { throw new Error("Disk-image tool did not return its structured result"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Disk-image tool returned an invalid structured result");
  return parsed;
}

async function attachedImage(diskImage, command, work, sequence) {
  const contents = await command("/usr/bin/hdiutil", ["info", "-plist"]);
  const information = await toolPropertyList(contents, command, work, `disk-image-info-${sequence}`);
  if (!Array.isArray(information.images)) throw new Error("Disk-image attachment inventory is invalid");
  const matches = information.images.filter((entry) => typeof entry?.["image-path"] === "string" && path.resolve(entry["image-path"]) === diskImage);
  if (matches.length > 1) throw new Error("Disk-image attachment inventory is ambiguous");
  return matches[0];
}

async function detachDiskImage(diskImage, mountpoint, command, work) {
  try {
    await command("/usr/bin/hdiutil", ["detach", mountpoint], 60000);
  } catch {
    // A failed attach may have created a device without mounting it. Only a
    // device explicitly associated with our newly created image may be retried.
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const image = await attachedImage(diskImage, command, work, attempt);
    if (!image) return;
    const entities = image["system-entities"];
    const roots = Array.isArray(entities) ? entities.filter((entity) => /^\/dev\/disk\d+$/u.test(entity?.["dev-entry"])) : [];
    if (roots.length !== 1) throw new Error("Disk-image device ownership could not be verified for cleanup");
    try { await command("/usr/bin/hdiutil", ["detach", roots[0]["dev-entry"]], 60000); }
    catch { /* Retry only this image's verified device, without force. */ }
  }
  if (await attachedImage(diskImage, command, work, 3)) throw new Error("Disk-image verification volume could not be detached");
}

export async function verifyCompanionDiskImage({ diskImage, bundle, work, command, release = false }) {
  await regular(diskImage);
  await command("/usr/bin/hdiutil", ["verify", diskImage]);
  if ((await command("/usr/bin/hdiutil", ["imageinfo", diskImage, "-format"])).trim() !== "UDZO") {
    throw new Error("Companion disk image must use the read-only UDZO format");
  }
  const expected = await bundleInventory(bundle);
  const mountpoint = path.join(work, "disk-image-mount");
  await mkdir(mountpoint, { mode: 0o700 });
  let attachAttempted = false;
  try {
    attachAttempted = true;
    const result = await command("/usr/bin/hdiutil", ["attach", diskImage, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountpoint, "-plist"]);
    const attachment = await toolPropertyList(result, command, work, "disk-image-attachment");
    const entities = attachment["system-entities"];
    const mounted = Array.isArray(entities) ? entities.filter((entity) => entity?.["mount-point"] !== undefined) : [];
    if (mounted.length !== 1 || mounted[0]["mount-point"] !== mountpoint) throw new Error("Disk image mounted at an unexpected location");
    const names = (await readdir(mountpoint)).sort();
    if (names.join(",") !== "Applications,PickerMux.app") throw new Error("Disk image must contain only PickerMux.app and the Applications link");
    const applications = path.join(mountpoint, "Applications");
    if (!(await lstat(applications)).isSymbolicLink() || await readlink(applications) !== "/Applications") {
      throw new Error("Disk-image Applications link must point exactly to /Applications");
    }
    const actual = await bundleInventory(path.join(mountpoint, "PickerMux.app"));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Disk-image app differs from the verified companion bundle");
    if (release) {
      const mountedBundle = path.join(mountpoint, "PickerMux.app");
      await command("/usr/bin/codesign", ["--verify", "--strict", "--deep", mountedBundle]);
      await command("/usr/bin/xcrun", ["stapler", "validate", mountedBundle]);
      await command("/usr/sbin/spctl", ["--assess", "--type", "execute", mountedBundle]);
    }
  } finally {
    if (attachAttempted) {
      try { await detachDiskImage(diskImage, mountpoint, command, work); }
      catch {
        const error = new Error("Disk-image verification volume could not be detached; build directory retained for safe cleanup");
        error.preserveBuildDirectory = true;
        throw error;
      }
    }
  }
}

export async function buildCompanion({ projectDirectory, outputDirectory, release = false, environment = process.env, execute = executeCommand }) {
  if (process.platform !== "darwin" && execute === executeCommand) throw new Error("Companion builds require macOS and Apple command-line tools");
  if (!outputDirectory) throw new Error("--output is required");
  const project = path.resolve(projectDirectory);
  const output = path.resolve(outputDirectory);
  const signing = release ? releaseSigning(environment) : null;
  if (await exists(output)) throw new Error("Companion output already exists; choose a new output directory");
  await regular(path.join(project, "package.json"));
  const metadata = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
  if (metadata.name !== "pickermux" || !VERSION_PATTERN.test(metadata.version)) throw new Error("Companion requires a stable PickerMux package version");
  const version = metadata.version;
  const sources = await sourceFiles(path.join(project, "macos", "Sources"));
  if (!sources.length) throw new Error("Companion Swift source files are missing");
  const templatePath = path.join(project, "macos", "Resources", "Info.plist.in");
  const entitlements = path.join(project, "macos", "Resources", "Companion.entitlements");
  await regular(templatePath);
  await regular(entitlements);
  const template = await readFile(templatePath, "utf8");
  if (!template.includes("__PICKERMUX_VERSION__")) throw new Error("Companion Info.plist version placeholder is missing");
  const info = template.replaceAll("__PICKERMUX_VERSION__", version);
  if (/__PICKERMUX_[A-Z_]+__/u.test(info)) throw new Error("Companion Info.plist has an unresolved placeholder");
  await mkdir(path.dirname(output), { recursive: true });
  const work = await realpath(await mkdtemp(path.join(path.dirname(output), ".pickermux-companion-")));
  let createdOutput = false;
  let cleanupWork = true;
  try {
    const staged = path.join(work, "assets");
    const bundle = path.join(staged, "PickerMux.app");
    const binary = path.join(bundle, "Contents", "MacOS", "PickerMuxCompanion");
    const resources = path.join(bundle, "Contents", "Resources");
    await mkdir(path.dirname(binary), { recursive: true });
    await mkdir(resources, { recursive: true });
    await writeFile(path.join(bundle, "Contents", "Info.plist"), info, { flag: "wx", mode: 0o644 });
    await writeFile(path.join(resources, "LICENSE"), await readFile(path.join(project, "LICENSE")), { flag: "wx", mode: 0o644 });
    const backendRelease = path.join(work, "backend-release");
    await buildRelease({ projectDirectory: project, outputDirectory: backendRelease });
    const manifestData = await readFile(path.join(backendRelease, "release-manifest.json"));
    const manifest = JSON.parse(manifestData);
    const backend = path.join(resources, "Backend");
    await mkdir(backend, { recursive: true });
    for (const file of manifest.files) {
      const contents = await readFile(path.join(project, file.path));
      if (sha256(contents) !== file.sha256 || contents.length !== file.size) throw new Error("Backend source changed while building the app");
      const destination = path.join(backend, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, contents, { flag: "wx", mode: 0o644 });
    }
    await writeFile(path.join(backend, "release-manifest.json"), manifestData, { flag: "wx", mode: 0o644 });
    const pin = path.join(work, "BackendPin.swift");
    await writeFile(pin, `public let bundledBackendManifestHash: String? = "${sha256(manifestData)}"\n`, { flag: "wx", mode: 0o600 });
    const buildEnvironment = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: environment.HOME ?? "/var/empty", TMPDIR: work,
      CLANG_MODULE_CACHE_PATH: path.join(work, "module-cache"), SWIFT_MODULECACHE_PATH: path.join(work, "module-cache"),
      LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8",
    };
    if (environment.DEVELOPER_DIR !== undefined) {
      if (typeof environment.DEVELOPER_DIR !== "string" || !path.isAbsolute(environment.DEVELOPER_DIR) || /[\r\n\0]/u.test(environment.DEVELOPER_DIR)) {
        throw new Error("DEVELOPER_DIR must be one absolute Apple developer-directory path");
      }
      const developer = await lstat(environment.DEVELOPER_DIR);
      if (!developer.isDirectory() || developer.isSymbolicLink()) throw new Error("DEVELOPER_DIR must be a real directory");
      buildEnvironment.DEVELOPER_DIR = environment.DEVELOPER_DIR;
    }
    const command = (tool, args, timeout) => execute(tool, args, { cwd: project, environment: buildEnvironment, timeout });
    const slices = [];
    for (const architecture of ["arm64", "x86_64"]) {
      const slice = path.join(work, `PickerMuxCompanion-${architecture}`);
      await command("/usr/bin/xcrun", ["--sdk", "macosx", "swiftc", "-swift-version", "5", "-O", "-parse-as-library", "-target", `${architecture}-apple-macos13.0`, "-module-cache-path", path.join(work, "module-cache"), "-module-name", "PickerMuxCompanion", ...sources, pin, "-o", slice]);
      slices.push(slice);
    }
    await command("/usr/bin/lipo", ["-create", ...slices, "-output", binary]);
    await chmod(binary, 0o755);
    const architectures = (await command("/usr/bin/lipo", [binary, "-archs"])).trim().split(/\s+/u).sort();
    if (architectures.join(",") !== "arm64,x86_64") throw new Error("Companion executable does not contain exactly the arm64 and x86_64 slices");
    await command("/usr/bin/plutil", ["-lint", path.join(bundle, "Contents", "Info.plist"), entitlements]);
    if (release) {
      await command("/usr/bin/codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", signing.identity, "--entitlements", entitlements, bundle]);
      await command("/usr/bin/codesign", ["--verify", "--strict", "--deep", bundle]);
      const upload = path.join(work, "notary-upload.zip");
      await command("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, upload]);
      await notarize(upload, command, signing.profile, "companion");
      await command("/usr/bin/xcrun", ["stapler", "staple", bundle]);
      await command("/usr/bin/xcrun", ["stapler", "validate", bundle]);
      await command("/usr/bin/codesign", ["--verify", "--strict", "--deep", bundle]);
      await command("/usr/sbin/spctl", ["--assess", "--type", "execute", bundle]);
    }
    const diskImageName = `PickerMux-v${version}-macos-universal.dmg`;
    const diskImage = path.join(staged, diskImageName);
    const diskImageSource = path.join(work, "disk-image-source");
    await mkdir(diskImageSource, { mode: 0o700 });
    // ditto preserves the app's extended metadata, including a stapled ticket;
    // mounted release checks below verify that it survives image packaging.
    await command("/usr/bin/ditto", [bundle, path.join(diskImageSource, "PickerMux.app")]);
    await symlink("/Applications", path.join(diskImageSource, "Applications"));
    await command("/usr/bin/hdiutil", ["create", "-volname", "PickerMux", "-srcfolder", diskImageSource, "-fs", "HFS+", "-format", "UDZO", "-nospotlight", "-o", diskImage]);
    await regular(diskImage);
    await chmod(diskImage, 0o644);
    await command("/usr/bin/hdiutil", ["verify", diskImage]);
    if (release) {
      await command("/usr/bin/codesign", ["--force", "--timestamp", "--sign", signing.identity, diskImage]);
      await command("/usr/bin/codesign", ["--verify", "--strict", diskImage]);
      await notarize(diskImage, command, signing.profile, "disk-image");
      await command("/usr/bin/xcrun", ["stapler", "staple", diskImage]);
      await command("/usr/bin/xcrun", ["stapler", "validate", diskImage]);
      await command("/usr/bin/codesign", ["--verify", "--strict", diskImage]);
      await command("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", diskImage]);
    }
    await verifyCompanionDiskImage({ diskImage, bundle, work, command, release });
    const diskImageSha256 = sha256(await readFile(diskImage));
    const archiveName = `PickerMux-v${version}-macos-universal.tar.gz`;
    const archive = await companionArchive(bundle);
    const archiveSha256 = sha256(archive);
    await writeFile(path.join(staged, archiveName), archive, { flag: "wx", mode: 0o644 });
    const releaseManifest = `${JSON.stringify({ schemaVersion: 1, product: "pickermux-companion", version, minimumMacOS: "13.0", architectures: ["arm64", "x86_64"], signing: release ? "developer-id-notarized" : "unsigned-development", backendManifestSha256: sha256(manifestData), archive: archiveName, archiveSha256, diskImage: { file: diskImageName, sha256: diskImageSha256, format: "UDZO", filesystem: "HFS+", installation: "drag-to-applications" } }, null, 2)}\n`;
    await writeFile(path.join(staged, "companion-manifest.json"), releaseManifest, { flag: "wx", mode: 0o644 });
    await writeFile(path.join(staged, "SHA256SUMS"), `${archiveSha256}  ${archiveName}\n${diskImageSha256}  ${diskImageName}\n${sha256(releaseManifest)}  companion-manifest.json\n`, { flag: "wx", mode: 0o644 });
    // mkdir is the no-clobber commit boundary: an output concurrently created by
    // another contributor is never replaced by rename.
    await mkdir(output);
    createdOutput = true;
    for (const name of await readdir(staged)) await rename(path.join(staged, name), path.join(output, name));
    return { version, outputDirectory: output, archiveName, archiveSha256, diskImageName, diskImageSha256, signing: release ? "developer-id-notarized" : "unsigned-development" };
  } catch (error) {
    if (error?.preserveBuildDirectory === true) cleanupWork = false;
    if (createdOutput) await rm(output, { recursive: true, force: true });
    throw error;
  } finally {
    if (cleanupWork) await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    process.stdout.write("Build a universal macOS 13+ PickerMux companion app, drag-to-Applications DMG and tar.gz.\nUsage: node scripts/build-companion.mjs --output PATH [--release]\nRelease requires Developer ID Application identity and notarytool Keychain profile via PICKERMUX_SIGNING_IDENTITY and PICKERMUX_NOTARY_PROFILE; both app and DMG are signed, notarized and stapled.\n");
    return;
  }
  let outputDirectory;
  let release = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--release" && !release) release = true;
    else if (argv[index] === "--output" && !outputDirectory && argv[index + 1] && !argv[index + 1].startsWith("--")) outputDirectory = argv[++index];
    else throw new Error("Unknown, duplicated or incomplete companion build option");
  }
  const result = await buildCompanion({ projectDirectory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), outputDirectory, release });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`build-companion: ${error.message}\n`);
    process.exitCode = 1;
  });
}
