import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function resolveUserHome(environment = process.env) {
  const configured = environment.HOME?.trim();
  const resolved = path.resolve(configured || homedir());
  if (resolved === path.parse(resolved).root) {
    throw new Error("The user home directory must not be a filesystem root");
  }
  return resolved;
}

export function resolveCodexHome(environment = process.env) {
  const configured = environment.CODEX_HOME?.trim();
  return configured
    ? path.resolve(configured)
    : path.join(resolveUserHome(environment), ".codex");
}

export function resolveCodexBinary(environment = process.env) {
  const configured = environment.CODEX_BINARY?.trim();
  if (configured) {
    return path.resolve(configured);
  }

  const embedded = "/Applications/ChatGPT.app/Contents/Resources/codex";
  return existsSync(embedded) ? embedded : "codex";
}

export function resolveProjectConfig(configPath, environment = process.env) {
  const configured = environment.PICKERMUX_CONFIG_PATH?.trim();
  return configPath
    ? path.resolve(configPath)
    : configured
      ? path.resolve(configured)
      : path.join(projectRoot, "lmstudio-picker.config.json");
}

export function resolveInstallPaths(environment = process.env) {
  const codexHome = resolveCodexHome(environment);
  const installDirectory = path.join(codexHome, "model-bridge");
  const launchAgentsDirectory = path.join(
    resolveUserHome(environment),
    "Library",
    "LaunchAgents",
  );
  const launchAgentLabel = "com.local.codex-model-bridge";
  return {
    codexHome,
    installDirectory,
    configPath: path.join(codexHome, "config.toml"),
    catalogPath: path.join(installDirectory, "models.json"),
    statePath: path.join(installDirectory, "state.json"),
    keychainRegistryPath: path.join(installDirectory, "keychain-state.json"),
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

export function resolveDistributionPaths(environment = process.env) {
  const userHome = resolveUserHome(environment);
  const codexHome = resolveCodexHome(environment);
  const applicationDirectory = path.join(
    userHome,
    "Library",
    "Application Support",
    "PickerMux",
  );
  return {
    userHome,
    applicationDirectory,
    versionsDirectory: path.join(applicationDirectory, "versions"),
    currentPath: path.join(applicationDirectory, "current"),
    receiptPath: path.join(applicationDirectory, "install-receipt.json"),
    lockPath: path.join(applicationDirectory, ".setup.lock"),
    launcherDirectory: path.join(userHome, ".local", "bin"),
    launcherPath: path.join(userHome, ".local", "bin", "pickermux"),
    installedConfigPath: path.join(
      codexHome,
      "model-bridge",
      "service-config.json",
    ),
  };
}

export function resolveFullRefreshPaths(environment = process.env) {
  const distribution = resolveDistributionPaths(environment);
  const operationDirectory = path.join(
    distribution.applicationDirectory,
    "full-refresh",
  );
  const launchAgentLabel = "com.local.pickermux-full-refresh";
  return {
    installDirectory: distribution.applicationDirectory,
    operationDirectory,
    checkpointPath: path.join(operationDirectory, "full-refresh-state.json"),
    launchAgentPath: path.join(operationDirectory, `${launchAgentLabel}.plist`),
    logPath: path.join(operationDirectory, "full-refresh.log"),
    launchAgentLabel,
    receiptPath: distribution.receiptPath,
  };
}
