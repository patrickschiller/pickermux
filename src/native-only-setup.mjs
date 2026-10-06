import { createHash } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";

import { loadBridgeConfig, validateBridgeConfig } from "./bridge-config.mjs";
import { readCompanionPrivateFile } from "./companion-config.mjs";
import { previewConfigIntegration } from "./config-manager.mjs";

export const BUNDLED_LMSTUDIO_CONFIG_FILE = "lmstudio-picker.config.json";
export const BUNDLED_LMSTUDIO_SETUP_CHANGES = Object.freeze([
  "enable-bundled-lmstudio",
  "preserve-bridge-settings",
  "preserve-user-settings",
  "preserve-historical-chats",
  "restore-on-failure",
]);

function validatedInstalledConfig(bytes) {
  try {
    return validateBridgeConfig(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ));
  } catch {
    const error = new Error("Installed PickerMux service configuration could not be verified.");
    error.code = "COMPANION_CONFIG_INVALID";
    throw error;
  }
}

function assertBundledLmStudioDefault(config) {
  const provider = config?.providers?.[0];
  if (
    config?.providers?.length !== 1 ||
    provider?.id !== "lmstudio" ||
    provider?.kind !== "lmstudio-responses" ||
    provider?.baseUrl !== "http://127.0.0.1:1234/v1" ||
    provider?.allowPrivateNetwork !== true ||
    provider?.discovery?.mode !== "loaded" ||
    provider?.discovery?.maxModels !== 32 ||
    Object.hasOwn(provider, "credentialEnv") ||
    Object.hasOwn(provider, "credentialKeychain")
  ) {
    throw new Error("The receipt-active release has no supported bundled LM Studio default configuration");
  }
  return config;
}

function previewToken({ installedBytes, bundledConfig, integrationToken, sourceRoot }) {
  const digest = createHash("sha256");
  for (const [label, value] of [
    ["contract", "pickermux-native-only-lmstudio-setup-v1"],
    ["source-root", sourceRoot],
    ["installed", installedBytes],
    ["bundled", JSON.stringify(bundledConfig)],
    ["integration", integrationToken],
  ]) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    digest.update(`${label}:${bytes.length}:`, "utf8");
    digest.update(bytes);
  }
  return digest.digest("hex");
}

/** Project only whether external providers exist; identities and endpoints stay private. */
export function providerConfigurationStatus(config) {
  if (!config || !Array.isArray(config.providers)) return { status: "unknown" };
  return { status: config.providers.length === 0 ? "native-only" : "external" };
}

/**
 * Produce a redacted CAS preview for the one fixed GUI configuration migration.
 * The target path is derived solely from the receipt-active source root.
 */
export async function previewBundledLmStudioSetup({
  paths,
  sourceRoot,
  readInstalledImpl = readCompanionPrivateFile,
  loadBundledImpl = loadBridgeConfig,
  integrationPreviewImpl = previewConfigIntegration,
} = {}) {
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot) || path.resolve(sourceRoot) !== sourceRoot || sourceRoot === path.parse(sourceRoot).root) {
    throw new TypeError("A receipt-active absolute source root is required");
  }
  const bundledConfigPath = path.join(sourceRoot, BUNDLED_LMSTUDIO_CONFIG_FILE);
  const [installedBytes, bundledConfig, integration] = await Promise.all([
    readInstalledImpl({ paths, kind: "service-config" }),
    loadBundledImpl(bundledConfigPath),
    integrationPreviewImpl({
      configPath: paths?.configPath,
      statePath: paths?.statePath,
    }),
  ]);
  if (!(installedBytes instanceof Uint8Array)) {
    throw new Error("Installed PickerMux service configuration could not be verified.");
  }
  const installedConfig = validatedInstalledConfig(installedBytes);
  const bundledDefault = assertBundledLmStudioDefault(bundledConfig);
  const nativeOnly = installedConfig.providers.length === 0;
  const integrationReady = integration?.status === "pickermux" && integration?.canApply === true &&
    typeof integration.previewToken === "string" && /^[a-f0-9]{64}$/u.test(integration.previewToken);
  const canApply = nativeOnly && integrationReady;
  const targetConfig = canApply
    ? validateBridgeConfig({
        schemaVersion: installedConfig.schemaVersion,
        bridge: installedConfig.bridge,
        providers: bundledDefault.providers,
      })
    : installedConfig;
  return Object.freeze({
    schemaVersion: 1,
    status: nativeOnly ? "native-only" : "external",
    canApply,
    requiresConfirmation: canApply,
    changes: canApply ? [...BUNDLED_LMSTUDIO_SETUP_CHANGES] : [],
    previewToken: previewToken({
      installedBytes: Buffer.from(installedBytes),
      bundledConfig: targetConfig,
      integrationToken: integrationReady ? integration.previewToken : "unavailable",
      sourceRoot,
    }),
    bundledConfigPath,
    installedConfigBytes: Buffer.from(installedBytes),
    targetConfig,
  });
}
