import Foundation

public enum CompanionFailure: Error, Equatable {
  case missingLauncher, missingNode, unsafeNode, unsafeLauncher, timeout, outputLimit, processFailed, incompatibleProtocol

  public var message: String {
    switch self {
    case .missingLauncher: return "Install the current PickerMux CLI before using the companion."
    case .missingNode: return "Node.js 22.15 or newer could not be validated at a supported location. Open Help for setup instructions, then retry status."
    case .unsafeNode: return "An installed Node.js runtime could not be trusted. Open Help to review its installation, then retry status."
    case .unsafeLauncher: return "PickerMux launcher ownership could not be verified. Review the CLI installation."
    case .timeout: return "PickerMux did not finish in time. Check the current status before retrying."
    case .outputLimit: return "PickerMux returned too much output. Review the CLI installation."
    case .processFailed: return "PickerMux could not complete this command. Check the CLI installation and Node.js runtime."
    case .incompatibleProtocol: return "The companion and CLI use incompatible protocols. Update them together."
    }
  }
}

public enum CompanionAction: String, Codable, CaseIterable {
  case refresh, open, recover, certify, diagnose, update
  case updateCheck = "update-check"
  case configurationPreview = "configuration-preview"
  case configurationApply = "configuration-apply"
  case integrationDeactivate = "integration-deactivate"
  case uninstallPreview = "uninstall-preview"
  case uninstall

  public var label: String {
    switch self {
    case .refresh: return "Refresh picker"
    case .open: return "Open Codex"
    case .recover: return "Repair after a Codex update…"
    case .certify: return "Certify models…"
    case .diagnose: return "Check installation"
    case .updateCheck: return "Check for PickerMux updates"
    case .update: return "Update PickerMux…"
    case .configurationPreview: return "Review PickerMux setup"
    case .configurationApply: return "Install and enable PickerMux…"
    case .integrationDeactivate: return "Turn off PickerMux in Codex…"
    case .uninstallPreview: return "Review complete removal"
    case .uninstall: return "Remove PickerMux completely…"
    }
  }

  public var timeout: TimeInterval {
    switch self {
    case .certify, .update, .configurationApply: return 3600
    case .recover, .refresh, .integrationDeactivate, .uninstall: return 600
    default: return 45
    }
  }
}

public struct ComponentStatus: Decodable, Equatable {
  public let status: String
}

public struct RecoveryStatus: Decodable, Equatable {
  public let status: String
  public let phase: String?
  public let operationId: String?
}

public struct CompanionIssue: Decodable, Equatable {
  public let code: String
  // The CLI supplies safe prose, but this GUI does not render arbitrary strings.
  public let message: String
}

public struct CompanionSnapshot: Decodable {
  public let schemaVersion: Int
  public let capabilities: [String]
  public let version: String
  public let state: String
  public let desktop: ComponentStatus
  public let installation: ComponentStatus
  public let managedConfig: ComponentStatus
  public let service: ComponentStatus
  public let compatibility: ComponentStatus
  public let accountCache: ComponentStatus
  public let recovery: RecoveryStatus
  public let integration: ComponentStatus
  public let actions: [CompanionAction]
  public let issues: [CompanionIssue]
  public var usesBundledBackend = false

  public var supportsNativeUninstall: Bool { capabilities.contains("native-uninstall-v1") }

  enum CodingKeys: String, CodingKey {
    case schemaVersion, capabilities, version, state, desktop, installation, managedConfig,
         service, compatibility, accountCache, recovery, integration, actions, issues
  }

  public var transitionIdentity: String {
    "\(state):\(compatibility.status):\(accountCache.status):\(recovery.status):\(recovery.phase ?? "idle"):\(issues.map(\.code).sorted().joined(separator: ","))"
  }

  public func allowingOnly(_ allowed: [CompanionAction], bundledBackend: Bool = false) -> CompanionSnapshot {
    var filtered = CompanionSnapshot(schemaVersion: schemaVersion, capabilities: capabilities, version: version, state: state, desktop: desktop,
      installation: installation, managedConfig: managedConfig, service: service, compatibility: compatibility,
      accountCache: accountCache, recovery: recovery, integration: integration,
      actions: actions.filter(allowed.contains), issues: issues)
    filtered.usesBundledBackend = bundledBackend
    return filtered
  }

  public static func decode(_ data: Data) throws -> CompanionSnapshot {
    guard data.count <= 262144,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == Set(["schemaVersion", "capabilities", "version", "state", "desktop", "installation", "managedConfig", "service", "compatibility", "accountCache", "recovery", "integration", "actions", "issues"]),
          let value = try? JSONDecoder().decode(CompanionSnapshot.self, from: data),
          value.schemaVersion == 1,
          [["integration-toggle-v1"], ["integration-toggle-v1", "native-uninstall-v1"]].contains(value.capabilities),
          (isVersion(value.version) || value.version == "unknown"),
          safeToken(value.state), value.actions.count <= CompanionAction.allCases.count,
          Set(value.actions).count == value.actions.count, value.issues.count <= 32,
          value.supportsNativeUninstall || !value.actions.contains(where: { [.uninstall, .uninstallPreview].contains($0) }),
          value.issues.allSatisfy({ safeCode($0.code) && $0.message.utf8.count <= 256 }),
          [value.desktop, value.installation, value.managedConfig, value.service,
           value.compatibility, value.accountCache, value.integration].allSatisfy({ safeToken($0.status) }),
          safeToken(value.recovery.status),
          value.recovery.phase.map({ recoveryPhases.contains($0) }) ?? true,
          value.recovery.operationId.map({ $0.range(of: "^[A-Za-z0-9-]{1,80}$", options: .regularExpression) != nil }) ?? true
    else { throw CompanionFailure.incompatibleProtocol }
    return value
  }
}

public struct ConfigurationPreview: Decodable {
  public let status: String
  public let previewToken: String?
  public let canApply: Bool
  public let changes: [String]
  public let requiresConfirmation: Bool
}

public struct UpdateStatus: Decodable {
  public let status: String
  public let currentVersion: String
  public let targetVersion: String?
  public let certificationIncomplete: Bool?
  public let restartRequired: Bool?
}

public struct UninstallPreview: Decodable {
  public let action: String
  public static let expectedChanges = ["restore-native-codex", "remove-integration", "remove-runtime", "remove-cli", "remove-certifications", "delete-backups", "delete-provider-credentials", "preserve-historical-chats", "preserve-user-settings"]
  public let status: String
  public let canApply: Bool
  public let previewToken: String?
  public let changes: [String]
}

public struct UninstallCompletion: Decodable {
  public let action: String
  public let status: String
  public let removed: Bool
  public let nativeRestored: Bool
  public let historicalChatsPreserved: Bool
  public let restartRequired: Bool
}

public struct CompanionResult: Decodable {
  public let schemaVersion: Int
  public let ok: Bool
  public let code: String
  public let preview: ConfigurationPreview?
  public let update: UpdateStatus?
  public let uninstallPreview: UninstallPreview?
  public let uninstallCompletion: UninstallCompletion?
  public let certificationIncomplete: Bool
  public let restartRequired: Bool

  enum CodingKeys: String, CodingKey { case schemaVersion, ok, code, data }

  enum ResultDataKeys: String, CodingKey { case certificationIncomplete, restartRequired }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
    ok = try container.decode(Bool.self, forKey: .ok)
    code = try container.decode(String.self, forKey: .code)
    preview = try? container.decode(ConfigurationPreview.self, forKey: .data)
    update = try? container.decode(UpdateStatus.self, forKey: .data)
    let candidate = try? container.decode(UninstallPreview.self, forKey: .data)
    uninstallPreview = candidate?.status == "ready" ? candidate : nil
    uninstallCompletion = try? container.decode(UninstallCompletion.self, forKey: .data)
    let flags = try? container.nestedContainer(keyedBy: ResultDataKeys.self, forKey: .data)
    certificationIncomplete = (try? flags?.decode(Bool.self, forKey: .certificationIncomplete)) ?? false
    restartRequired = (try? flags?.decode(Bool.self, forKey: .restartRequired)) ?? false
  }

  public static func decode(_ data: Data) throws -> CompanionResult {
    guard data.count <= 262144,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys).isSubset(of: ["schemaVersion", "ok", "code", "data", "message"]),
          let value = try? JSONDecoder().decode(CompanionResult.self, from: data),
          value.schemaVersion == 1, safeCode(value.code)
    else { throw CompanionFailure.incompatibleProtocol }
    if let preview = value.preview {
      guard ["pickermux", "ollama", "foreign", "none", "conflict"].contains(preview.status),
            preview.changes.count <= 16, preview.changes.allSatisfy({ safeToken($0) }),
            preview.previewToken.map({ $0.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }) ?? true,
            !preview.canApply || preview.previewToken != nil
      else { throw CompanionFailure.incompatibleProtocol }
    }
    if let update = value.update {
      guard ["current", "available", "unsupported", "unavailable", "updated", "installed", "up-to-date", "no-update", "update-available"].contains(update.status),
            isVersion(update.currentVersion), update.targetVersion.map(isVersion) ?? true
      else { throw CompanionFailure.incompatibleProtocol }
    }
    if let removal = value.uninstallCompletion {
      guard value.ok, removal.action == "uninstall", removal.status == "removed", removal.removed, removal.nativeRestored,
            removal.historicalChatsPreserved, removal.restartRequired,
            let fields = object["data"] as? [String: Any],
            Set(fields.keys) == Set(["action", "status", "removed", "nativeRestored", "historicalChatsPreserved", "restartRequired"])
      else { throw CompanionFailure.incompatibleProtocol }
    }
    if let removal = value.uninstallPreview {
      guard value.ok, removal.action == "uninstall-preview", removal.canApply, removal.changes == UninstallPreview.expectedChanges,
            removal.previewToken?.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
            let fields = object["data"] as? [String: Any],
            Set(fields.keys) == Set(["action", "status", "canApply", "previewToken", "changes"])
      else { throw CompanionFailure.incompatibleProtocol }
    }
    return value
  }
}

public func actionRequest(_ action: CompanionAction, confirmed: Bool = false, previewToken: String? = nil) throws -> Data {
  var object: [String: Any] = ["schemaVersion": 1, "action": action.rawValue]
  if action == .recover {
    guard confirmed else { throw CompanionFailure.incompatibleProtocol }
    object["confirmation"] = ["quitCodexTwice": true, "interruptTasks": true, "invalidateCompaction": true]
  }
  if action == .configurationApply {
    guard confirmed, let previewToken, previewToken.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    else { throw CompanionFailure.incompatibleProtocol }
    object["previewToken"] = previewToken
    object["confirmation"] = ["replaceIntegration": true]
  }
  if action == .integrationDeactivate {
    guard confirmed else { throw CompanionFailure.incompatibleProtocol }
    object["confirmation"] = ["deactivateIntegration": true]
  }
  if action == .uninstall {
    guard confirmed, let previewToken, previewToken.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    else { throw CompanionFailure.incompatibleProtocol }
    object["previewToken"] = previewToken
    object["confirmation"] = ["removePickerMux": true, "restoreNativeCodex": true, "deleteProviderCredentials": true, "deleteBackups": true]
  }
  return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
}

private let recoveryPhases = Set(["prepared", "first-quit-complete", "suspended", "native-opened", "cache-refreshed", "second-quit-complete", "reactivated", "completed"])

func safeToken(_ value: String) -> Bool {
  value.range(of: "^[a-z][a-z0-9-]{0,63}$", options: .regularExpression) != nil
}

func safeCode(_ value: String) -> Bool {
  value.range(of: "^[A-Za-z][A-Za-z0-9_-]{0,79}$", options: .regularExpression) != nil
}

public func isVersion(_ value: String) -> Bool {
  value.range(of: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[A-Za-z0-9.-]{1,40})?$", options: .regularExpression) != nil
}

public func statusLabel(_ value: String) -> String {
  // Unknown statuses remain non-actionable prose, never filesystem paths or CLI output.
  let labels = [
    "ready": "Ready", "ok": "Ready", "running": "Running", "stopped": "Stopped",
    "closed": "Closed", "open": "Open", "missing": "Missing", "absent": "Not installed",
    "installed": "Installed", "valid": "Valid", "invalid": "Needs review", "unavailable": "Unavailable",
    "compatible": "Compatible", "incompatible": "Update detected", "mismatch": "Version mismatch",
    "version-mismatch": "Version mismatch", "matched": "Matches Codex", "current": "Current",
    "idle": "Idle", "active": "Active", "pending": "Pending", "interrupted": "Interrupted",
    "completed": "Completed", "failed": "Failed", "unknown": "Unknown", "conflict": "Conflict",
    "pickermux": "PickerMux", "ollama": "Ollama", "foreign": "Another integration", "none": "None",
    "managed": "Managed", "modified": "User changes detected", "unsafe": "Needs review",
    "blocked": "Needs attention", "needs-recovery": "Recovery needed", "needs-refresh": "Refresh needed",
    "not-installed": "Not installed", "recovery-pending": "Recovery needs attention", "update-required": "Codex update detected",
    "configuration-conflict": "Integration conflict", "degraded": "Needs attention", "suspension-conflict": "Recovery configuration changed",
    "available": "Update available", "unsupported": "Unavailable", "updated": "Updated",
    "refresh-required": "Refresh needed", "runtime-missing": "Runtime missing", "unhealthy": "Needs attention",
    "unreachable": "Unreachable", "inconsistent": "Configuration inconsistent", "installed-marker-recovered": "Managed",
    "invalid-state": "Needs review", "unreadable-config": "Configuration unavailable", "orphaned-managed-block": "Ownership needs review",
    "prepared": "Preparing recovery", "first-quit-complete": "Codex closed", "suspended": "Picker suspended",
    "native-opened": "Waiting for Codex account cache", "cache-refreshed": "Account cache refreshed",
    "second-quit-complete": "Restoring picker", "reactivated": "Picker restored",
    "inactive": "PickerMux is off", "deactivated": "Turned off",
  ]
  return labels[value] ?? "Needs review"
}

public func shouldNotifyRecoveryCompletion(previous: CompanionSnapshot?, next: CompanionSnapshot) -> Bool {
  previous?.recovery.status == "pending" && next.state == "ready" && ["idle", "completed"].contains(next.recovery.status)
}

public func companionActionFailureMessage(_ code: String) -> String {
  let messages = [
    "CONFIRMATION_REQUIRED": "Confirm the operation before retrying.",
    "ACTION_NOT_ALLOWED": "This action is unavailable in the current state. Check status and review the setup guidance.",
    "BUSY": "Another PickerMux operation is active. Wait for it to finish, then check status.",
    "CODEX_RUNNING": "Fully quit Codex with Command-Q, then retry the setup or action.",
    "CONFIGURATION_CONFLICT": "The current integration changed or needs review. Check status and review setup again before enabling PickerMux.",
    "PREVIEW_STALE": "The reviewed setup changed. Toggle PickerMux on again to review a fresh preview.",
    "COMPATIBILITY_MISMATCH": "Codex changed. Review the required repair before using the picker.",
    "ACCOUNT_CACHE_REFRESH_REQUIRED": "Open Codex while signed in and wait for its native model picker to load. Fully quit Codex, then check status again.",
    "RECOVERY_PENDING": "An earlier repair is still pending. Review and resume it before changing PickerMux.",
    "NOT_INSTALLED": "Turn on Use PickerMux in Codex to review installation and activation.",
    "DISTRIBUTION_INVALID": "The installed PickerMux CLI could not be verified. Review its installation in Help before retrying.",
    "UPDATE_INVALID": "The update could not be verified. Check status and retry only with a verified release.",
    "UPDATE_UNAVAILABLE": "The update service is unavailable. Check your connection and try again later.",
    "UPDATE_UNSUPPORTED": "No supported update is available for this system. Review the release requirements in Help.",
    "CERTIFICATION_INCOMPLETE": "PickerMux is installed, but model certification is incomplete. Keep configured provider models available and choose Certify models to retry.",
    "PROVIDER_UNAVAILABLE": "The model server could not be reached during setup. Check the configured server and model availability, then retry setup.",
    "PROVIDER_TIMEOUT": "The model server did not respond in time during setup. Check that it is running and responsive, then retry setup.",
    "PROVIDER_PERMISSION_DENIED": "macOS denied access needed for setup. Review PickerMux in System Settings > Privacy & Security and its installation permissions, then retry setup.",
    "PROVIDER_AUTH_REQUIRED": "The model server rejected access during setup. Review the configured provider credentials and access settings, then retry setup.",
    "PROVIDER_RESPONSE_INVALID": "The model server returned an unsupported response during setup. Review the provider's API compatibility in Help, then retry setup.",
    "NO_LOADED_MODELS": "No loaded model was found during setup. Load a model on the configured server, then retry setup.",
    "DEACTIVATION_FAILED": "PickerMux could not be turned off. Check status before retrying; review the installation in Help.",
    "DEACTIVATION_ROLLBACK_FAILED": "Turning PickerMux off could not finish or fully restore its prior state. Check status and review the pending repair in Help before changing it again.",
    "UNINSTALL_CONFLICT": "The installation changed since the removal review. Keep Codex closed, check status and review a fresh removal preview. Modified or foreign files are retained.",
    "UNINSTALL_PREFLIGHT_FAILED": "PickerMux could not verify all removal ownership. Keep the app installed and review the CLI installation before retrying.",
    "PURGE_INCOMPLETE": "Complete removal could not finish. Some registered credentials or files may already be removed. Keep the app installed for an explicit retry; Codex data is preserved.",
    "UNINSTALL_FAILED": "PickerMux removal could not finish. Keep the app installed, check status and retry only after reviewing the installation.",
  ]
  return messages[code] ?? "PickerMux could not complete this action. Check status and open Help to review the installation."
}
