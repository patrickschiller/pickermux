import Foundation

public struct IntegrationToggleState {
  public let isEnabled: Bool
  public let canChange: Bool
  public let needsSetupUpgrade: Bool
  public let canReviewSetup: Bool
  public let label: String
  public let guidance: String

  public init(snapshot: CompanionSnapshot?, busy: Bool = false) {
    guard let snapshot else {
      isEnabled = false
      canChange = false
      needsSetupUpgrade = false
      canReviewSetup = false
      label = "Checking installation"
      guidance = "Check status or open Help before enabling PickerMux."
      return
    }
    let active = snapshot.integration.status == "pickermux" &&
      ["installed", "installed-marker-recovered"].contains(snapshot.managedConfig.status)
    let inactive = ["none", "ollama", "foreign"].contains(snapshot.integration.status) &&
      ["not-installed", "deactivated"].contains(snapshot.managedConfig.status)
    let knownRecovery = ["idle", "completed"].contains(snapshot.recovery.status)
    let closed = ["stopped", "closed"].contains(snapshot.desktop.status)
    let knownInstallation = ["installed", "not-installed"].contains(snapshot.installation.status)
    isEnabled = active
    needsSetupUpgrade = snapshot.installation.status == "installed" && snapshot.usesBundledBackend
    canReviewSetup = !busy && knownRecovery && closed && knownInstallation && (active || inactive) &&
      ["ready", "valid"].contains(snapshot.accountCache.status) &&
      snapshot.actions.contains(.configurationPreview) && snapshot.actions.contains(.configurationApply)
    canChange = !busy && knownRecovery && closed && knownInstallation && (active || inactive) &&
      (active ? snapshot.actions.contains(.integrationDeactivate) :
        canReviewSetup)

    if busy {
      label = active ? "Enabled in Codex" : "Operation in progress"
      guidance = "Wait for the current operation to finish. The switch follows the verified installation status."
    } else if !knownRecovery {
      label = "Repair needs attention"
      guidance = "Review and complete the pending repair before changing the integration."
    } else if !knownInstallation || (!active && !inactive) {
      label = "Integration needs review"
      guidance = "The current integration could not be verified. Check status and open Help before changing it."
    } else if active {
      label = "Enabled in Codex"
      if needsSetupUpgrade {
        guidance = canReviewSetup ? "Complete setup for this app to update the installed bridge before changing the switch." :
          "Complete Codex setup and fully quit it before updating the installed bridge for this app."
      } else {
        guidance = canChange ? "Turn off, then reopen Codex to load its native picker without PickerMux models. The app and PickerMux settings stay installed." :
          "Fully quit Codex and check status before turning PickerMux off."
      }
    } else if snapshot.desktop.status == "unknown" {
      label = "Codex state unavailable"
      guidance = "Check status and open Help before changing the integration."
    } else if !closed {
      label = "Not enabled in Codex"
      guidance = "Fully quit Codex with Command-Q before installing or activating PickerMux."
    } else if !canChange && !["ready", "valid"].contains(snapshot.accountCache.status) {
      label = "Codex setup required"
      guidance = "Open Codex while signed in and wait for its native model picker to load. Fully quit Codex, then check status again."
    } else if snapshot.integration.status == "ollama" || snapshot.integration.status == "foreign" {
      label = "Another integration is active"
      guidance = "Turning on installs PickerMux and replaces the current picker integration after a verified backup. Setup may send certification test prompts to configured provider models."
    } else if snapshot.installation.status == "installed" {
      label = "Installed, currently off"
      guidance = "Turn on to activate PickerMux in Codex. Setup may send certification test prompts to configured provider models."
    } else {
      label = "Ready to install"
      guidance = "Turning on installs PickerMux and adds configured provider models to Codex. New installations use LM Studio by default. Keep Codex closed during setup; certification may send live test prompts."
    }
  }
}

public struct IntegrationReview {
  public let title: String
  public let text: String
  public let button: String
  public let preview: ConfigurationPreview?
}

public enum IntegrationToggleOutcome {
  case unchanged
  case cancelled
  case blocked
  case completed(CompanionResult)
}

public enum IntegrationConsent {
  case review
  // A deliberate switch or setup-button click is consent for this exact direction.
  case toggleIntent
}

public protocol CompanionControlling {
  func status() async throws -> CompanionSnapshot
  func run(_ action: CompanionAction, confirmed: Bool, previewToken: String?) async throws -> CompanionResult
}

extension PickerMuxClient: CompanionControlling {}

public func changePickerMuxIntegration(_ enabled: Bool, reviewInstalledSetup: Bool = false, client: any CompanionControlling,
                                      consent: IntegrationConsent = .review,
                                      confirm: @MainActor (IntegrationReview) async -> Bool = { _ in false }) async throws -> IntegrationToggleOutcome {
  try Task.checkCancellation()
  let snapshot = try await client.status()
  let state = IntegrationToggleState(snapshot: snapshot)
  let upgrading = enabled && reviewInstalledSetup && state.needsSetupUpgrade
  guard state.isEnabled != enabled || upgrading else { return .unchanged }
  guard upgrading ? state.canReviewSetup : state.canChange else { return .blocked }
  if !enabled {
    let review = IntegrationReview(title: "Turn off PickerMux in Codex?",
      text: "PickerMux will stop its bridge and restore the native Codex picker. The app, settings, certifications and verified backups stay installed so you can turn it on again. Use complete uninstall in Settings to remove the retained PickerMux data. Reopen Codex afterwards. Historical chats remain readable.",
      button: "Turn off PickerMux", preview: nil)
    if consent == .review {
      guard await confirm(review) else { return .cancelled }
    }
    try Task.checkCancellation()
    return .completed(try await client.run(.integrationDeactivate, confirmed: true, previewToken: nil))
  }

  let result = try await client.run(.configurationPreview, confirmed: false, previewToken: nil)
  guard result.ok else { return .completed(result) }
  guard let preview = result.preview, preview.canApply, let token = preview.previewToken else { return .blocked }
  let replacing = ["ollama", "foreign"].contains(preview.status)
  let title = upgrading ? "Update PickerMux setup for this app?" :
    snapshot.installation.status == "installed" ? "Enable PickerMux in Codex?" : "Install and enable PickerMux?"
  let replacement = replacing ? "The current picker integration will be replaced after a verified backup. " : ""
  let upgrade = upgrading ? "This app's verified bundled backend will install its CLI and bridge. If PickerMux is currently off, this also enables it in Codex. " : ""
  let review = IntegrationReview(title: title,
    text: "\(upgrade)\(replacement)PickerMux will install or activate its CLI and bridge so configured provider models appear alongside native Codex models. New installations use LM Studio by default. Existing provider settings are preserved and the earlier configuration remains restorable. Keep Codex fully closed and provider models available. Setup can send live certification test prompts to those models. Reopen Codex after setup finishes.",
    button: upgrading ? "Update setup" : snapshot.installation.status == "installed" ? "Enable PickerMux" : "Install and enable", preview: preview)
  if consent == .review {
    guard await confirm(review) else { return .cancelled }
  }
  try Task.checkCancellation()
  return .completed(try await client.run(.configurationApply, confirmed: true, previewToken: token))
}
