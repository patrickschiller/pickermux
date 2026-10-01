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

  public var label: String {
    switch self {
    case .refresh: return "Refresh picker"
    case .open: return "Open Codex"
    case .recover: return "Repair after a Codex update…"
    case .certify: return "Certify loaded models…"
    case .diagnose: return "Check installation"
    case .updateCheck: return "Check for PickerMux updates"
    case .update: return "Update PickerMux…"
    case .configurationPreview: return "Preview configuration changes"
    case .configurationApply: return "Apply configuration changes…"
    }
  }

  public var timeout: TimeInterval {
    switch self {
    case .certify, .update, .configurationApply: return 3600
    case .recover, .refresh: return 600
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

  public var transitionIdentity: String {
    "\(state):\(compatibility.status):\(accountCache.status):\(recovery.status):\(recovery.phase ?? "idle"):\(issues.map(\.code).sorted().joined(separator: ","))"
  }

  public func allowingOnly(_ allowed: [CompanionAction]) -> CompanionSnapshot {
    CompanionSnapshot(schemaVersion: schemaVersion, version: version, state: state, desktop: desktop,
      installation: installation, managedConfig: managedConfig, service: service, compatibility: compatibility,
      accountCache: accountCache, recovery: recovery, integration: integration,
      actions: actions.filter(allowed.contains), issues: issues)
  }

  public static func decode(_ data: Data) throws -> CompanionSnapshot {
    guard data.count <= 262144,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == Set(["schemaVersion", "version", "state", "desktop", "installation", "managedConfig", "service", "compatibility", "accountCache", "recovery", "integration", "actions", "issues"]),
          let value = try? JSONDecoder().decode(CompanionSnapshot.self, from: data),
          value.schemaVersion == 1, (isVersion(value.version) || value.version == "unknown"),
          safeToken(value.state), value.actions.count <= CompanionAction.allCases.count,
          Set(value.actions).count == value.actions.count, value.issues.count <= 32,
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

public struct CompanionResult: Decodable {
  public let schemaVersion: Int
  public let ok: Bool
  public let code: String
  public let preview: ConfigurationPreview?
  public let update: UpdateStatus?
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
  ]
  return labels[value] ?? "Needs review"
}

public func shouldNotifyRecoveryCompletion(previous: CompanionSnapshot?, next: CompanionSnapshot) -> Bool {
  previous?.recovery.status == "pending" && next.state == "ready" && ["idle", "completed"].contains(next.recovery.status)
}
