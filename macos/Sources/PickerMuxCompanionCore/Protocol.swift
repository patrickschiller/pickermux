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
  case fullRefresh = "full-refresh"
  case updateCheck = "update-check"
  case configurationPreview = "configuration-preview"
  case configurationApply = "configuration-apply"
  case lmStudioDefaultPreview = "lmstudio-default-preview"
  case lmStudioDefaultApply = "lmstudio-default-apply"
  case integrationDeactivate = "integration-deactivate"
  case usageReset = "usage-reset"
  case uninstallPreview = "uninstall-preview"
  case uninstall

  public var label: String {
    switch self {
    case .refresh: return "Refresh picker"
    case .fullRefresh: return "Full refresh…"
    case .open: return "Open Codex"
    case .recover: return "Repair after a Codex update…"
    case .certify: return "Certify models…"
    case .diagnose: return "Check installation"
    case .updateCheck: return "Check for PickerMux updates"
    case .update: return "Update PickerMux…"
    case .configurationPreview: return "Review PickerMux setup"
    case .configurationApply: return "Install and enable PickerMux…"
    case .lmStudioDefaultPreview: return "Review LM Studio model setup"
    case .lmStudioDefaultApply: return "Enable LM Studio models…"
    case .integrationDeactivate: return "Turn off PickerMux in Codex…"
    case .usageReset: return "Reset accumulated counts…"
    case .uninstallPreview: return "Review complete removal"
    case .uninstall: return "Remove PickerMux completely…"
    }
  }

  public var timeout: TimeInterval {
    switch self {
    case .certify, .update, .configurationApply, .lmStudioDefaultApply: return 3600
    case .recover, .fullRefresh, .refresh, .integrationDeactivate, .uninstall: return 600
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

public enum ProviderConfigurationKind: String, Decodable, Equatable {
  case nativeOnly = "native-only"
  case external
  case notInstalled = "not-installed"
  case unknown
}

public struct ProviderConfiguration: Decodable, Equatable {
  public let status: ProviderConfigurationKind
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
  public let providerConfiguration: ProviderConfiguration?
  public let tokenUsage: TokenUsageSnapshot?
  public let tokenPerformance: TokenPerformanceSnapshot?
  public var usesBundledBackend = false

  public var supportsNativeUninstall: Bool { capabilities.contains("native-uninstall-v1") }
  public var supportsNativeOnlyLMStudioSetup: Bool { capabilities.contains("native-only-lmstudio-setup-v1") }
  public var supportsTokenUsage: Bool { capabilities.contains("token-usage-v1") || capabilities.contains("token-usage-v2") }
  public var supportsTokenUsageReset: Bool { capabilities.contains("token-usage-reset-v1") }
  public var supportsTokenPerformance: Bool { capabilities.contains("token-performance-v1") }

  enum CodingKeys: String, CodingKey {
    case schemaVersion, capabilities, version, state, desktop, installation, managedConfig,
         service, compatibility, accountCache, recovery, integration, actions, issues, providerConfiguration,
         tokenUsage, tokenPerformance
  }

  public var transitionIdentity: String {
    "\(state):\(compatibility.status):\(accountCache.status):\(recovery.status):\(recovery.phase ?? "idle"):\(providerConfiguration?.status.rawValue ?? "legacy"):\(issues.map(\.code).sorted().joined(separator: ","))"
  }

  public func allowingOnly(_ allowed: [CompanionAction], bundledBackend: Bool = false) -> CompanionSnapshot {
    var filteredActions = actions.filter(allowed.contains)
    if bundledBackend || filteredActions.contains(.lmStudioDefaultPreview) != filteredActions.contains(.lmStudioDefaultApply) {
      filteredActions.removeAll { [.lmStudioDefaultPreview, .lmStudioDefaultApply].contains($0) }
    }
    var filtered = CompanionSnapshot(schemaVersion: schemaVersion, capabilities: capabilities, version: version, state: state, desktop: desktop,
      installation: installation, managedConfig: managedConfig, service: service, compatibility: compatibility,
      accountCache: accountCache, recovery: recovery, integration: integration,
      actions: filteredActions, issues: issues, providerConfiguration: providerConfiguration,
      tokenUsage: tokenUsage, tokenPerformance: tokenPerformance)
    filtered.usesBundledBackend = bundledBackend
    return filtered
  }

  public static func decode(_ data: Data) throws -> CompanionSnapshot {
    guard data.count <= 262144,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys).subtracting(["providerConfiguration", "tokenUsage", "tokenPerformance"]) == Set(["schemaVersion", "capabilities", "version", "state", "desktop", "installation", "managedConfig", "service", "compatibility", "accountCache", "recovery", "integration", "actions", "issues"]),
          let value = try? JSONDecoder().decode(CompanionSnapshot.self, from: data),
          value.schemaVersion == 1,
          [["integration-toggle-v1"], ["integration-toggle-v1", "native-uninstall-v1"],
           ["integration-toggle-v1", "token-usage-v1"], ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v1"],
           ["integration-toggle-v1", "token-usage-v2"], ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v2"],
           ["integration-toggle-v1", "token-usage-v2", "token-usage-reset-v1"],
           ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v2", "token-usage-reset-v1"],
           ["integration-toggle-v1", "native-uninstall-v1", "native-only-lmstudio-setup-v1", "token-usage-v1"],
           ["integration-toggle-v1", "native-uninstall-v1", "native-only-lmstudio-setup-v1", "token-usage-v2", "token-usage-reset-v1"]].contains(value.capabilities.filter { $0 != "token-performance-v1" }),
          (!value.supportsTokenPerformance || (value.supportsTokenUsage &&
            value.capabilities.last == "token-performance-v1" && value.capabilities.filter { $0 == "token-performance-v1" }.count == 1)),
          value.supportsTokenUsage == (value.tokenUsage != nil),
          object["tokenUsage"] == nil || value.tokenUsage != nil,
          value.supportsTokenPerformance == (value.tokenPerformance != nil),
          object["tokenPerformance"] == nil || value.tokenPerformance != nil,
          value.supportsNativeOnlyLMStudioSetup == (value.providerConfiguration != nil),
          object["providerConfiguration"] == nil || value.providerConfiguration != nil,
          object["providerConfiguration"] == nil || ((object["providerConfiguration"] as? [String: Any]).map { Set($0.keys) == Set(["status"]) } == true),
          (isVersion(value.version) || value.version == "unknown"),
          safeToken(value.state), value.actions.count <= CompanionAction.allCases.count,
          Set(value.actions).count == value.actions.count, value.issues.count <= 32,
          value.supportsNativeUninstall || !value.actions.contains(where: { [.uninstall, .uninstallPreview].contains($0) }),
          value.actions.contains(.lmStudioDefaultPreview) == value.actions.contains(.lmStudioDefaultApply),
          !value.actions.contains(.lmStudioDefaultPreview) || (value.supportsNativeOnlyLMStudioSetup && value.providerConfiguration?.status == .nativeOnly),
          value.supportsTokenUsageReset || !value.actions.contains(.usageReset),
          value.issues.allSatisfy({ safeCode($0.code) && $0.message.utf8.count <= 256 }),
          [value.desktop, value.installation, value.managedConfig, value.service,
           value.compatibility, value.accountCache, value.integration].allSatisfy({ safeToken($0.status) }),
          safeToken(value.recovery.status),
          value.recovery.phase.map({ recoveryPhases.contains($0) }) ?? true,
          value.recovery.operationId.map({ $0.range(of: "^[A-Za-z0-9-]{1,80}$", options: .regularExpression) != nil }) ?? true
    else { throw CompanionFailure.incompatibleProtocol }
    // Keep the optional binding separate for Swift 6.3 optimized-build compatibility.
    if let usage = value.tokenUsage {
      let expectedSchema = value.capabilities.contains("token-usage-v2") ? 2 : 1
      guard usage.schemaVersion == expectedSchema else { throw CompanionFailure.incompatibleProtocol }
    }
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

public struct LMStudioDefaultPreview: Decodable, Equatable {
  public static let expectedChanges = [
    "enable-bundled-lmstudio",
    "preserve-bridge-settings",
    "preserve-user-settings",
    "preserve-historical-chats",
    "restore-on-failure",
  ]

  public let action: String
  public let status: String
  public let canApply: Bool
  public let requiresConfirmation: Bool
  public let changes: [String]
  public let previewToken: String
}

public struct LMStudioDefaultApplyCompletion: Decodable, Equatable {
  public let action: String
  public let status: String
  public let updated: Bool
  public let restartRequired: Bool
  public let certificationIncomplete: Bool?
  public let version: String?
}

public struct UpdateStatus: Decodable {
  public let status: String
  public let currentVersion: String
  public let targetVersion: String?
  public let certificationIncomplete: Bool?
  public let restartRequired: Bool?
  public let distribution: String?

  public init(status: String, currentVersion: String, targetVersion: String? = nil,
              certificationIncomplete: Bool? = nil, restartRequired: Bool? = nil, distribution: String? = nil) {
    self.status = status
    self.currentVersion = currentVersion
    self.targetVersion = targetVersion
    self.certificationIncomplete = certificationIncomplete
    self.restartRequired = restartRequired
    self.distribution = distribution
  }
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

public struct RecoveryStartReceipt: Decodable {
  public let action: String
  public let started: Bool
  public let resumed: Bool
  public let operationId: String
}

private struct ResultAction: Decodable {
  let action: String
}

public struct CompanionResult: Decodable {
  public let schemaVersion: Int
  public let ok: Bool
  public let code: String
  public let preview: ConfigurationPreview?
  public let lmStudioDefaultPreview: LMStudioDefaultPreview?
  public let lmStudioDefaultApply: LMStudioDefaultApplyCompletion?
  public let update: UpdateStatus?
  public let uninstallPreview: UninstallPreview?
  public let uninstallCompletion: UninstallCompletion?
  public let usageReset: UsageResetCompletion?
  public let recoveryStart: RecoveryStartReceipt?
  public let certificationIncomplete: Bool
  public let restartRequired: Bool

  enum CodingKeys: String, CodingKey { case schemaVersion, ok, code, data }

  enum ResultDataKeys: String, CodingKey { case certificationIncomplete, restartRequired }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
    ok = try container.decode(Bool.self, forKey: .ok)
    code = try container.decode(String.self, forKey: .code)
    let resultAction = (try? container.decode(ResultAction.self, forKey: .data))?.action
    preview = resultAction == CompanionAction.lmStudioDefaultPreview.rawValue ? nil :
      try? container.decode(ConfigurationPreview.self, forKey: .data)
    lmStudioDefaultPreview = resultAction == CompanionAction.lmStudioDefaultPreview.rawValue ?
      try? container.decode(LMStudioDefaultPreview.self, forKey: .data) : nil
    lmStudioDefaultApply = resultAction == CompanionAction.lmStudioDefaultApply.rawValue ?
      try? container.decode(LMStudioDefaultApplyCompletion.self, forKey: .data) : nil
    update = try? container.decode(UpdateStatus.self, forKey: .data)
    let candidate = try? container.decode(UninstallPreview.self, forKey: .data)
    uninstallPreview = candidate?.status == "ready" ? candidate : nil
    uninstallCompletion = try? container.decode(UninstallCompletion.self, forKey: .data)
    usageReset = try? container.decode(UsageResetCompletion.self, forKey: .data)
    recoveryStart = try? container.decode(RecoveryStartReceipt.self, forKey: .data)
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
    if let fields = object["data"] as? [String: Any], let action = fields["action"] as? String {
      guard CompanionAction(rawValue: action) != nil else { throw CompanionFailure.incompatibleProtocol }
    }
    if let fields = object["data"] as? [String: Any], fields["status"] as? String == "applied" {
      guard fields["action"] as? String != nil else { throw CompanionFailure.incompatibleProtocol }
    }
    if let preview = value.preview {
      guard ["pickermux", "ollama", "foreign", "none", "conflict"].contains(preview.status),
            preview.changes.count <= 16, preview.changes.allSatisfy({ safeToken($0) }),
            preview.previewToken.map({ $0.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }) ?? true,
            !preview.canApply || preview.previewToken != nil
      else { throw CompanionFailure.incompatibleProtocol }
    }
    if let fields = object["data"] as? [String: Any],
       fields["action"] as? String == CompanionAction.lmStudioDefaultPreview.rawValue {
      guard let preview = value.lmStudioDefaultPreview, value.ok,
            preview.status == "native-only", preview.canApply, preview.requiresConfirmation,
            preview.changes == LMStudioDefaultPreview.expectedChanges,
            preview.previewToken.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
            Set(fields.keys) == Set(["action", "status", "canApply", "requiresConfirmation", "changes", "previewToken"])
      else { throw CompanionFailure.incompatibleProtocol }
    }
    if let fields = object["data"] as? [String: Any],
       fields["action"] as? String == CompanionAction.lmStudioDefaultApply.rawValue {
      let required = Set(["action", "status", "updated", "restartRequired"])
      let allowed = required.union(["certificationIncomplete", "version"])
      guard let completion = value.lmStudioDefaultApply, value.ok,
            completion.status == "applied", completion.updated, completion.restartRequired,
            completion.version.map(isVersion) ?? true,
            fields["version"] == nil || completion.version != nil,
            fields["certificationIncomplete"] == nil || completion.certificationIncomplete != nil,
            required.isSubset(of: Set(fields.keys)), Set(fields.keys).isSubset(of: allowed)
      else { throw CompanionFailure.incompatibleProtocol }
    }
    if let update = value.update {
      guard ["current", "available", "unsupported", "unavailable", "updated", "installed", "up-to-date", "no-update", "update-available"].contains(update.status),
            isVersion(update.currentVersion), update.targetVersion.map(isVersion) ?? true,
            update.distribution.map({ ["dmg", "cli-archive"].contains($0) }) ?? true
      else { throw CompanionFailure.incompatibleProtocol }
      if update.distribution == "dmg" && update.status == "available" {
        guard let target = update.targetVersion, compareCompanionVersions(target, update.currentVersion) == 1
        else { throw CompanionFailure.incompatibleProtocol }
      }
    }
    if let fields = object["data"] as? [String: Any],
       fields["currentVersion"] != nil || fields["targetVersion"] != nil || fields["distribution"] != nil ||
       ["update", "update-check"].contains(fields["action"] as? String ?? "") {
      // A malformed update cannot disappear through an optional decode and be
      // mistaken for success. Browser destinations are constructed locally.
      guard value.update != nil,
            Set(fields.keys).isSubset(of: ["action", "status", "currentVersion", "latestVersion", "targetVersion", "version", "distribution",
              "started", "resumed", "updated", "updateAvailable", "restartRequired", "certificationIncomplete", "deactivated", "operationId"])
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
    if let fields = object["data"] as? [String: Any],
       fields["action"] as? String == "usage-reset" || fields["resetAt"] != nil || fields["lastRequestPreserved"] != nil {
      guard let reset = value.usageReset, value.ok, reset.action == "usage-reset", reset.status == "reset", reset.lastRequestPreserved,
            canonicalTokenUsageDate(reset.resetAt) != nil,
            Set(fields.keys) == Set(["action", "status", "resetAt", "lastRequestPreserved"])
      else { throw CompanionFailure.incompatibleProtocol }
    }
    if let fields = object["data"] as? [String: Any] {
      let action = fields["action"] as? String ?? ""
      let hasRecoveryFields = ["started", "resumed", "operationId"].contains { fields[$0] != nil }
      if (["full-refresh", "recover"].contains(action) || (hasRecoveryFields && !["update", "update-check"].contains(action))) {
        guard let receipt = value.recoveryStart, value.ok,
              ["full-refresh", "recover"].contains(receipt.action), receipt.started,
              validRecoveryOperationId(receipt.operationId),
              Set(fields.keys) == Set(["action", "started", "resumed", "operationId"])
        else { throw CompanionFailure.incompatibleProtocol }
      }
    }
    return value
  }
}

public func actionRequest(_ action: CompanionAction, confirmed: Bool = false, previewToken: String? = nil) throws -> Data {
  var object: [String: Any] = ["schemaVersion": 1, "action": action.rawValue]
  if action == .recover || action == .fullRefresh {
    guard confirmed else { throw CompanionFailure.incompatibleProtocol }
    object["confirmation"] = ["quitCodexTwice": true, "interruptTasks": true, "invalidateCompaction": true]
  }
  if action == .configurationApply {
    guard confirmed, let previewToken, previewToken.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    else { throw CompanionFailure.incompatibleProtocol }
    object["previewToken"] = previewToken
    object["confirmation"] = ["replaceIntegration": true]
  }
  if action == .lmStudioDefaultPreview {
    guard !confirmed, previewToken == nil else { throw CompanionFailure.incompatibleProtocol }
  }
  if action == .lmStudioDefaultApply {
    guard confirmed, let previewToken, previewToken.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    else { throw CompanionFailure.incompatibleProtocol }
    object["previewToken"] = previewToken
    object["confirmation"] = ["enableBundledLmStudio": true]
  }
  if action == .integrationDeactivate {
    guard confirmed else { throw CompanionFailure.incompatibleProtocol }
    object["confirmation"] = ["deactivateIntegration": true]
  }
  if action == .usageReset {
    guard confirmed, previewToken == nil else { throw CompanionFailure.incompatibleProtocol }
    object["confirmation"] = ["resetAccumulatedUsage": true]
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

func validRecoveryOperationId(_ value: String) -> Bool {
  value.lowercased().range(
    of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    options: .regularExpression) != nil
}

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
    "ACTION_NOT_ALLOWED": "This action is unavailable in the current state. Check status in Config and review the setup guidance.",
    "BUSY": "Another PickerMux operation is active. Wait for it to finish, then check status in Config.",
    "CODEX_RUNNING": "Fully quit Codex with Command-Q, then retry the setup or action.",
    "CONFIGURATION_CONFLICT": "The current integration changed or needs review. Check status in Config and review setup again before enabling PickerMux.",
    "PREVIEW_STALE": "The reviewed setup changed. Toggle PickerMux on again to review a fresh preview.",
    "COMPATIBILITY_MISMATCH": "Codex changed. Review the required repair before using the picker.",
    "ACCOUNT_CACHE_REFRESH_REQUIRED": "Open Codex while signed in and wait for its native model picker to load. Fully quit Codex, then check status in Config again.",
    "RECOVERY_PENDING": "An earlier repair is still pending. Review and resume it before changing PickerMux.",
    "NOT_INSTALLED": "Turn on Use PickerMux in Codex to review installation and activation.",
    "DISTRIBUTION_INVALID": "The installed PickerMux CLI could not be verified. Review its installation in Help before retrying.",
    "UPDATE_INVALID": "The update could not be verified. Check status in Config and retry only with a verified release.",
    "UPDATE_UNAVAILABLE": "The update service is unavailable. Check your connection and try again later.",
    "UPDATE_UNSUPPORTED": "No supported update is available for this system. Review the release requirements in Help.",
    "DOWNLOAD_REQUIRED": "Download the new PickerMux DMG, quit PickerMux, and replace the app in Applications. Reopen it to review the bundled backend upgrade with Codex closed.",
    "CERTIFICATION_INCOMPLETE": "PickerMux is installed, but model certification is incomplete. Keep configured provider models available and choose Certify models to retry.",
    "PROVIDER_UNAVAILABLE": "The model server could not be reached during setup. Check the configured server and model availability, then retry setup.",
    "PROVIDER_TIMEOUT": "The model server did not respond in time during setup. Check that it is running and responsive, then retry setup.",
    "PROVIDER_PERMISSION_DENIED": "macOS denied access needed for setup. Review PickerMux in System Settings > Privacy & Security and its installation permissions, then retry setup.",
    "PROVIDER_AUTH_REQUIRED": "The model server rejected access during setup. Review the configured provider credentials and access settings, then retry setup.",
    "PROVIDER_RESPONSE_INVALID": "The model server returned an unsupported response during setup. Review the provider's API compatibility in Help, then retry setup.",
    "NO_LOADED_MODELS": "No loaded model was found during setup. Load a model on the configured server, then retry setup.",
    "DEACTIVATION_FAILED": "PickerMux could not be turned off. Check status in Config before retrying; review the installation in Help.",
    "DEACTIVATION_ROLLBACK_FAILED": "Turning PickerMux off could not finish or fully restore its prior state. Check status in Config and review the pending repair in Help before changing it again.",
    "UNINSTALL_CONFLICT": "The installation changed since the removal review. Keep Codex closed, check status in Config and review a fresh removal preview. Modified or foreign files are retained.",
    "UNINSTALL_PREFLIGHT_FAILED": "PickerMux could not verify all removal ownership. Keep the app installed and review the CLI installation before retrying.",
    "PURGE_INCOMPLETE": "Complete removal could not finish. Some registered credentials or files may already be removed. Keep the app installed for an explicit retry; Codex data is preserved.",
    "UNINSTALL_FAILED": "PickerMux removal could not finish. Keep the app installed, check status in Config and retry only after reviewing the installation.",
    "USAGE_RESET_FAILED": "The saved token totals could not be reset. Check status in Config before retrying.",
  ]
  return messages[code] ?? "PickerMux could not complete this action. Check status in Config and open Help to review the installation."
}

public struct UsageResetCompletion: Decodable {
  public let action: String
  public let status: String
  public let resetAt: String
  public let lastRequestPreserved: Bool
}
