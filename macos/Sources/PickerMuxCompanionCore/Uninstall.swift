import Foundation

public enum CompanionRemovalState: Equatable {
  case idle, reviewing, removing, cleanupRequired, removed
  case failed(String)

  public var permitsActivity: Bool {
    switch self { case .idle, .failed: return true; default: return false }
  }

  public var backendRemoved: Bool { self == .removed || self == .cleanupRequired }

  public var notice: String? {
    switch self {
    case .idle: return nil
    case .reviewing: return "Reviewing complete removal…"
    case .removing: return "Removing PickerMux… Keep Codex closed until removal finishes."
    case .cleanupRequired: return "The PickerMux integration, CLI and managed data were removed. App settings cleanup still needs attention. Retry app cleanup before quitting."
    case .removed: return "PickerMux was removed and native Codex configuration restored. Quit this app, move PickerMux.app from Applications to the Trash, then reopen Codex. Historical chats remain readable; choose a native model to continue them."
    case .failed(let code):
      if code == "LOGIN_UNREGISTER_FAILED" { return "macOS could not verify login startup as disabled. PickerMux's integration and CLI were retained. Review Login Items in System Settings, then retry removal." }
      if code == "LOGIN_SIGNATURE_INVALID" { return "macOS rejected the app signature during login cleanup. PickerMux's integration and CLI were retained. Use a correctly signed matching app, then retry removal." }
      if code == "LOGIN_PERMISSION_DENIED" { return "macOS denied login startup cleanup. PickerMux's integration and CLI were retained. Review Login Items in System Settings and your permissions, then retry removal." }
      if code == "LOGIN_SERVICE_UNAVAILABLE" { return "macOS ServiceManagement was unavailable during login cleanup. PickerMux's integration and CLI were retained. Retry removal when the service is available." }
      if code == "LOGIN_STARTUP_STILL_REGISTERED" { return "Login startup still appears registered after cleanup. PickerMux's integration and CLI were retained. Review Login Items in System Settings, then retry removal." }
      if code == "LOGIN_STARTUP_UNVERIFIED" { return "The login startup status could not be verified. PickerMux's integration and CLI were retained. Review Login Items in System Settings, then retry removal." }
      if code == "UNINSTALL_UNSUPPORTED" { return "Native-only app removal requires a matching CLI version 0.9.5 or newer. Explicitly update the CLI and app, or fully quit Codex and use ~/.local/bin/pickermux uninstall --purge in Terminal. An older CLI restores the previous configuration and may reactivate an earlier Ollama integration. No setup or update was started." }
      if code == "UNINSTALL_PROTOCOL_INVALID" { return "The removal result could not be verified. Keep the app installed, keep Codex closed, and review the installation before retrying. No operation is retried automatically." }
      return companionActionFailureMessage(code)
    }
  }
}

public struct CompanionRemovalReview {
  public let title = "Remove PickerMux completely?"
  public let button = "Remove PickerMux"
  public let text = "PickerMux will restore native Codex configuration and remove its integration, service, CLI, certifications, verified backups and registered provider credentials. Your Codex login, chats and unrelated settings stay intact. An inert provider alias keeps historical chats readable. Login startup will be disabled. After removal, quit PickerMux, move PickerMux.app to the Trash and reopen Codex. A previous gateway such as Ollama is not reactivated."
}

public enum CompanionRemovalAvailability: Equatable {
  case available, statusUnavailable, notInstalled, installationUnverified, backendUnsupported
  case codexRunning, codexUnknown, recoveryPending, recoveryUnknown, actionUnavailable

  public var notice: String? {
    switch self {
    case .available: return nil
    case .statusUnavailable: return "Removal status is unavailable. Check status in Config before removal."
    case .notInstalled: return "PickerMux's integration and CLI are not installed. There is nothing left to uninstall here. Quit PickerMux and move PickerMux.app from Applications to the Trash."
    case .installationUnverified: return "The installed PickerMux state could not be verified. Check installation in Config before removal; retained data must not be deleted without verified ownership."
    case .backendUnsupported: return "The app could not use an installed CLI with native removal support (0.9.5 or newer). Check installation in Config and review the CLI version. The bundled setup backend cannot remove an installation."
    case .codexRunning: return "Fully quit Codex with Command-Q before removal."
    case .codexUnknown: return "Codex's running status could not be verified. Fully quit Codex and check status in Config before removal."
    case .recoveryPending: return "Finish the pending Codex repair before removal."
    case .recoveryUnknown: return "The repair status could not be verified. Check installation in Config before removal."
    case .actionUnavailable: return "The installed backend does not currently allow complete removal. Check installation in Config and review its reported issues."
    }
  }
}

// The generation invalidates tasks waiting on the shared queue and late status
// observations. Removing the CLI must never trigger bootstrap or auto-refresh.
@MainActor
public final class CompanionRemovalCoordinator {
  public private(set) var state: CompanionRemovalState = .idle
  public private(set) var generation = 0
  public var onStateChange: ((CompanionRemovalState) -> Void)?

  public init() {}

  public func permitsActivity(_ capturedGeneration: Int) -> Bool {
    state.permitsActivity && generation == capturedGeneration
  }

  @discardableResult
  public func beginReview() -> Bool {
    guard state.permitsActivity else { return false }
    generation += 1
    transition(.reviewing)
    return true
  }

  public static func canRemove(_ snapshot: CompanionSnapshot?) -> Bool {
    availability(snapshot) == .available
  }

  public static func availability(_ snapshot: CompanionSnapshot?) -> CompanionRemovalAvailability {
    guard let snapshot else { return .statusUnavailable }
    // Absence is a display state, never authority to purge through a fallback.
    if snapshot.installation.status == "not-installed" && snapshot.managedConfig.status == "not-installed" &&
       snapshot.service.status == "not-installed" && snapshot.integration.status == "none" &&
       ["idle", "completed"].contains(snapshot.recovery.status) { return .notInstalled }
    guard snapshot.installation.status == "installed" else { return .installationUnverified }
    guard !snapshot.usesBundledBackend && snapshot.supportsNativeUninstall else { return .backendUnsupported }
    guard ["stopped", "closed"].contains(snapshot.desktop.status) else {
      return snapshot.desktop.status == "running" ? .codexRunning : .codexUnknown
    }
    guard ["idle", "completed"].contains(snapshot.recovery.status) else {
      return snapshot.recovery.status == "pending" ? .recoveryPending : .recoveryUnknown
    }
    guard snapshot.actions.contains(.uninstallPreview) && snapshot.actions.contains(.uninstall) else { return .actionUnavailable }
    return .available
  }

  public func remove(client: any CompanionControlling,
                     confirm: (CompanionRemovalReview) async -> Bool,
                     unregisterLogin: () async throws -> Void,
                     cleanup: () async throws -> Void) async {
    guard state == .reviewing else { return }
    do {
      try Task.checkCancellation()
      let snapshot = try await client.status()
      guard Self.canRemove(snapshot) else { transition(.failed("UNINSTALL_UNSUPPORTED")); return }
      let result = try await client.run(.uninstallPreview, confirmed: false, previewToken: nil)
      guard result.ok else { transition(.failed(result.code)); return }
      guard let preview = result.uninstallPreview, let token = preview.previewToken else {
        transition(.failed("UNINSTALL_PROTOCOL_INVALID")); return
      }
      guard await confirm(CompanionRemovalReview()) else { transition(.idle); return }
      try Task.checkCancellation()
      transition(.removing)
      do { try await unregisterLogin() }
      catch { transition(.failed((error as? CompanionLoginStartupFailure)?.code ?? "LOGIN_UNREGISTER_FAILED")); return }
      try Task.checkCancellation()
      let removed = try await client.run(.uninstall, confirmed: true, previewToken: token)
      guard removed.ok else { transition(.failed(removed.code)); return }
      guard removed.uninstallCompletion != nil else { transition(.failed("UNINSTALL_PROTOCOL_INVALID")); return }
      await finishCleanup(cleanup)
    } catch is CancellationError {
      transition(.failed("UNINSTALL_PROTOCOL_INVALID"))
    } catch {
      transition(.failed("UNINSTALL_PROTOCOL_INVALID"))
    }
  }

  public func retryCleanup(_ cleanup: () async throws -> Void) async {
    guard state == .cleanupRequired else { return }
    await finishCleanup(cleanup)
  }

  private func finishCleanup(_ cleanup: () async throws -> Void) async {
    // Once backend removal is confirmed, local cleanup failures cannot restore
    // activity or authorize a second purge of an absent installation.
    transition(.cleanupRequired)
    do { try await cleanup(); transition(.removed) }
    catch { transition(.cleanupRequired) }
  }

  private func transition(_ next: CompanionRemovalState) {
    state = next
    onStateChange?(next)
  }
}

public let companionOwnedPreferenceKeys = ["refreshOnClose", "statusNotifications"]
public let companionOwnedNotificationIdentifiers = ["pickermux-state"]

public func clearCompanionPreferences(_ defaults: UserDefaults) {
  clearCompanionPreferences(removing: { defaults.removeObject(forKey: $0) })
}

public func clearCompanionPreferences(removing removeValue: (String) -> Void) {
  for key in companionOwnedPreferenceKeys { removeValue(key) }
}
