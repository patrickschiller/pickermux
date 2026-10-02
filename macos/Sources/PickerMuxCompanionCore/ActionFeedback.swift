import Foundation

public func companionActionResultMessage(_ result: CompanionResult, action: CompanionAction) -> String {
  guard result.ok else { return companionActionFailureMessage(result.code) }
  if result.certificationIncomplete {
    return "PickerMux is installed, but model certification is incomplete. Keep configured provider models available and choose Certify models to retry."
  }
  if let update = result.update {
    if ["updated", "installed"].contains(update.status) {
      return "PickerMux was updated. Open Codex after reviewing the status; install the matching companion app when its version changes."
    }
    if update.status == "available", let version = update.targetVersion { return "PickerMux \(version) is available." }
    if update.status == "current" { return "PickerMux is up to date." }
    return "Update information is unavailable."
  }
  switch action {
  case .refresh:
    return result.restartRequired ? "Picker refreshed. Reopen Codex to load the updated picker." : "Picker refreshed."
  case .open: return "Codex opened."
  case .diagnose: return "Installation checks passed."
  case .certify: return "Model certification completed. Reopen Codex to load the certified picker."
  case .recover: return "Repair started. Its progress is shown in Installation details."
  case .configurationApply: return "PickerMux setup completed. Reopen Codex to load the picker."
  case .integrationDeactivate:
    return "PickerMux was turned off. Fully quit and reopen Codex to load its native picker. The app and PickerMux settings remain installed."
  case .configurationPreview: return "Setup reviewed. Turn on Use PickerMux in Codex to install and activate it."
  case .usageReset: return "Accumulated token counts reset. Last model request is unchanged."
  case .uninstall: return "PickerMux was removed. Reopen Codex to load its native picker."
  case .uninstallPreview: return "Complete removal is ready for review."
  case .update, .updateCheck: return "Update check completed."
  }
}
