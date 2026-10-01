export const PICKERMUX_RELEASE_REPOSITORY = "https://github.com/patrickschiller/pickermux";
export const PICKERMUX_DMG_ASSET = "PickerMux-macos-universal.dmg";

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MARKER = "pickermux-dmg-release-v1";

function invalid() {
  const error = new Error("The PickerMux disk-image release metadata is invalid.");
  error.code = "UPDATE_INVALID";
  return error;
}

export function dmgReleaseRecord({ version, file = PICKERMUX_DMG_ASSET, sha256, signing = "developer-id-notarized" }) {
  if (!VERSION.test(version) || !HASH.test(sha256) || signing !== "developer-id-notarized" ||
    file !== PICKERMUX_DMG_ASSET) throw invalid();
  return { version, file, sha256, signing };
}

export function dmgReleaseMarker(record) {
  return `<!-- ${MARKER} ${JSON.stringify(dmgReleaseRecord(record))} -->`;
}

export function parseDmgReleaseRecord(body, { version, file }) {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > 64 * 1024 || body.split(MARKER).length !== 2) throw invalid();
  const match = /<!-- pickermux-dmg-release-v1 (\{[^\r\n]{1,1024}\}) -->/u.exec(body);
  if (!match) throw invalid();
  let record;
  try { record = JSON.parse(match[1]); } catch { throw invalid(); }
  if (!record || typeof record !== "object" || Array.isArray(record) ||
    Object.keys(record).length !== 4 || !["version", "file", "sha256", "signing"].every((key) => Object.hasOwn(record, key))) throw invalid();
  const verified = dmgReleaseRecord(record);
  if (JSON.stringify(verified) !== match[1] || verified.version !== version || verified.file !== file) throw invalid();
  return verified;
}
