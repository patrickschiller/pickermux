import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ICON_SIZES = [
  ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function regularIconFile(file, limit) {
  const initial = await lstat(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > limit) {
    throw new Error("Companion icon must be one bounded regular file without links");
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit || before.dev !== initial.dev || before.ino !== initial.ino) {
      throw new Error("Companion icon changed while opening it");
    }
    const chunks = [];
    let size = 0;
    const buffer = Buffer.alloc(8192);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > limit) throw new Error("Companion icon exceeded its bounded file size while reading it");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const bytes = Buffer.concat(chunks);
    const after = await handle.stat();
    const current = await lstat(file);
    if (bytes.length > limit || bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1) {
      throw new Error("Companion icon changed while reading it");
    }
    return bytes;
  } finally { await handle.close(); }
}

export function validateIconPng(bytes, pixels) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_MAGIC) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) !== pixels || bytes.readUInt32BE(20) !== pixels || bytes[24] !== 8 || bytes[25] !== 6 || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) {
    throw new Error(`Companion icon requires a ${pixels}x${pixels} PNG with 8-bit RGBA alpha`);
  }
  let imageData = false;
  let ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error("Companion PNG chunk is truncated");
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/u.test(type) || offset + length + 12 > bytes.length || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) {
      throw new Error("Companion PNG chunk or checksum is invalid");
    }
    if (type === "IHDR" && offset !== 8) throw new Error("Companion PNG has duplicate image headers");
    if (type === "IDAT" && length > 0) imageData = true;
    offset += length + 12;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) throw new Error("Companion PNG has an invalid end marker");
      ended = true;
    }
  }
  if (!imageData || !ended) throw new Error("Companion PNG is missing image data or its end marker");
}

export function validateCompanionIcns(bytes) {
  if (bytes.length < 16 || bytes.toString("ascii", 0, 4) !== "icns" || bytes.readUInt32BE(4) !== bytes.length) throw new Error("Companion icon output is not a complete ICNS file");
  const records = new Set();
  const required = new Map([["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024], ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512]]);
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error("Companion ICNS record is truncated");
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    if (!/^[A-Za-z0-9 ]{4}$/u.test(type) || length <= 8 || offset + length > bytes.length || records.has(type)) throw new Error("Companion ICNS record is malformed or duplicated");
    records.add(type);
    if (required.has(type)) validateIconPng(bytes.subarray(offset + 8, offset + length), required.get(type));
    offset += length;
  }
  // Modern iconutil emits ic04/ic05 for the small bitmap representations;
  // older native tool versions also use the equivalent icp4/is32/icp5/il32.
  if (![...required.keys()].every((type) => records.has(type)) || !["ic04", "icp4", "is32"].some((type) => records.has(type)) || !["ic05", "icp5", "il32"].some((type) => records.has(type))) {
    throw new Error("Companion ICNS file is missing required standard and Retina representations");
  }
}

export async function buildCompanionIcon({ source, resources, work, command }) {
  const master = await regularIconFile(source, 8 * 1024 * 1024);
  validateIconPng(master, 1024);
  // Native tools consume an immutable build-local snapshot rather than a
  // repository asset that could be edited halfway through icon conversion.
  const pinnedMaster = path.join(work, "AppIcon-master.png");
  await writeFile(pinnedMaster, master, { flag: "wx", mode: 0o600 });
  const iconset = path.join(work, "AppIcon.iconset");
  await mkdir(iconset, { mode: 0o700 });
  for (const [name, pixels] of ICON_SIZES) {
    const output = path.join(iconset, name);
    await command("/usr/bin/sips", ["-s", "format", "png", "--resampleHeightWidth", String(pixels), String(pixels), pinnedMaster, "--out", output]);
    validateIconPng(await regularIconFile(output, 8 * 1024 * 1024), pixels);
  }
  const generated = path.join(work, "AppIcon.icns");
  await command("/usr/bin/iconutil", ["--convert", "icns", "--output", generated, iconset]);
  const icon = await regularIconFile(generated, 16 * 1024 * 1024);
  validateCompanionIcns(icon);
  const destination = path.join(resources, "AppIcon.icns");
  await writeFile(destination, icon, { flag: "wx", mode: 0o644 });
  await chmod(destination, 0o644);
  return { file: "AppIcon.icns", sha256: sha256(icon), source: "macos/Resources/AppIcon.png", sourceSha256: sha256(master), pixels: 1024 };
}
