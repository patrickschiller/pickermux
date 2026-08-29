import { readFile } from "node:fs/promises";
import path from "node:path";

import { projectRoot } from "./paths.mjs";

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

export async function readPickerMuxMetadata(root = projectRoot) {
  const packagePath = path.join(path.resolve(root), "package.json");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`PickerMux package metadata is invalid: ${packagePath}`, {
      cause: error,
    });
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.name !== "pickermux" ||
    typeof parsed.version !== "string" ||
    !VERSION_PATTERN.test(parsed.version)
  ) {
    throw new Error(`PickerMux package metadata is not a supported release: ${packagePath}`);
  }
  return {
    name: parsed.name,
    version: parsed.version,
    packagePath,
  };
}
