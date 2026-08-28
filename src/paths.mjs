import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function resolveCodexHome(environment = process.env) {
  const configured = environment.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), ".codex");
}

export function resolveCodexBinary(environment = process.env) {
  const configured = environment.CODEX_BINARY?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  const embedded = "/Applications/ChatGPT.app/Contents/Resources/codex";
  return existsSync(embedded) ? embedded : "codex";
}

export function resolveProjectConfig(configPath) {
  return configPath
    ? path.resolve(configPath)
    : path.join(projectRoot, "lmstudio-picker.config.json");
}

export function resolveInstallPaths(environment = process.env) {
  const codexHome = resolveCodexHome(environment);
  const installDirectory = path.join(codexHome, "model-bridge");
  const launchAgentsDirectory = path.join(homedir(), "Library", "LaunchAgents");
  const launchAgentLabel = "com.local.codex-model-bridge";
  return {
    codexHome,
    installDirectory,
    configPath: path.join(codexHome, "config.toml"),
    catalogPath: path.join(installDirectory, "models.json"),
    statePath: path.join(installDirectory, "state.json"),
    backupDirectory: path.join(installDirectory, "backups"),
    runtimePath: path.join(installDirectory, "runtime.json"),
    serviceConfigPath: path.join(installDirectory, "service-config.json"),
    certificationPath: path.join(installDirectory, "certifications.json"),
    compatibilityPath: path.join(installDirectory, "compatibility.json"),
    serviceDirectory: path.join(installDirectory, "runtime-app"),
    logPath: path.join(installDirectory, "bridge.log"),
    launchAgentLabel,
    launchAgentPath: path.join(launchAgentsDirectory, `${launchAgentLabel}.plist`),
  };
}
