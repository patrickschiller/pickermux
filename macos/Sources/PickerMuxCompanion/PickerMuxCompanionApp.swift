import AppKit
import Foundation
import ServiceManagement
import SwiftUI
import UserNotifications
#if SWIFT_PACKAGE
import PickerMuxCompanionCore
#endif

@main
struct PickerMuxCompanionApp: App {
  @StateObject private var controller = CompanionController()

  var body: some Scene {
    MenuBarExtra("PickerMux", systemImage: controller.menuIcon) {
      CompanionPanel(controller: controller)
    }
    .menuBarExtraStyle(.window)
    Settings {
      CompanionSettings(controller: controller)
    }
  }
}

@MainActor
final class CompanionController: ObservableObject {
  @Published var snapshot: CompanionSnapshot?
  @Published var statusFailure: CompanionFailure?
  @Published var message = "Checking PickerMux…"
  @Published var busy: CompanionAction?
  @Published var refreshQueued = false
  @Published var operationNotice: String?
  @Published var preview: ConfigurationPreview?
  @Published var update: UpdateStatus?
  @Published var loginEnabled = SMAppService.mainApp.status == .enabled
  @Published var notificationsEnabled = UserDefaults.standard.bool(forKey: "statusNotifications")
  @Published var refreshOnClose = UserDefaults.standard.bool(forKey: "refreshOnClose") {
    didSet { UserDefaults.standard.set(refreshOnClose, forKey: "refreshOnClose") }
  }
  private let client = PickerMuxClient()
  private var polling: Task<Void, Never>?
  private var refreshing = false
  private var lastTransition: String?

  var menuIcon: String {
    if busy != nil || snapshot?.recovery.status == "pending" { return "arrow.triangle.2.circlepath" }
    if snapshot?.state == "inactive" { return "power" }
    return snapshot?.state == "ready" ? "checkmark.circle" : "exclamationmark.circle"
  }

  var appVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development"
  }

  var integrationState: IntegrationToggleState {
    IntegrationToggleState(snapshot: snapshot, busy: busy != nil)
  }

  init() {
    polling = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refreshStatus()
        try? await Task.sleep(nanoseconds: 5_000_000_000)
      }
    }
  }

  deinit { polling?.cancel() }

  func refreshStatus() async {
    guard !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    do {
      let next = try await client.status()
      if snapshot?.integration.status != next.integration.status { preview = nil }
      let changed = lastTransition != nil && lastTransition != next.transitionIdentity
      let desktopJustClosed = ["running", "open"].contains(snapshot?.desktop.status ?? "") && ["stopped", "closed"].contains(next.desktop.status)
      let shouldRefresh = (refreshQueued || (refreshOnClose && desktopJustClosed)) && busy == nil && next.state == "ready" && ["idle", "completed"].contains(next.recovery.status) && next.actions.contains(.refresh)
      let recoveryCompleted = shouldNotifyRecoveryCompletion(previous: snapshot, next: next)
      snapshot = next
      statusFailure = nil
      if busy == nil { message = statusLabel(next.state) }
      if changed && notificationsEnabled { await notifyIfActionable(next, recoveryCompleted: recoveryCompleted) }
      lastTransition = next.transitionIdentity
      if shouldRefresh { refreshQueued = false; perform(.refresh) }
    } catch {
      snapshot = nil
      preview = nil
      statusFailure = error as? CompanionFailure
      message = failureMessage(error)
    }
  }

  func canRun(_ action: CompanionAction) -> Bool {
    guard busy == nil, snapshot?.actions.contains(action) == true else { return false }
    return true
  }

  func setIntegrationEnabled(_ enabled: Bool, reviewInstalledSetup: Bool = false) {
    guard busy == nil else { return }
    if reviewInstalledSetup {
      guard enabled, integrationState.needsSetupUpgrade, integrationState.canReviewSetup else { return }
    } else {
      guard integrationState.canChange, integrationState.isEnabled != enabled else { return }
    }
    busy = enabled ? .configurationApply : .integrationDeactivate
    operationNotice = nil
    message = enabled ? "Reviewing PickerMux installation and activation…" : "Reviewing PickerMux deactivation…"
    Task {
      defer { busy = nil }
      var retainReviewedDetails = false
      do {
        let outcome = try await changePickerMuxIntegration(enabled, reviewInstalledSetup: reviewInstalledSetup, client: client) { review in
          self.preview = review.preview
          return self.confirmation(title: review.title, text: review.text, button: review.button)
        }
        switch outcome {
        case .unchanged: operationNotice = "The integration already has the requested state."
        case .cancelled:
          operationNotice = "The integration change was cancelled."
          retainReviewedDetails = true
        case .blocked: operationNotice = "The integration cannot be changed yet. Check status and follow the setup guidance."
        case .completed(let result):
          operationNotice = result.ok ? resultMessage(result, action: enabled ? .configurationApply : .integrationDeactivate) :
            companionActionFailureMessage(result.code)
        }
      } catch {
        operationNotice = failureMessage(error)
      }
      if !retainReviewedDetails { preview = nil }
      busy = nil
      await refreshStatus()
    }
  }

  func perform(_ action: CompanionAction) {
    if action == .configurationApply { setIntegrationEnabled(true); return }
    if action == .integrationDeactivate { setIntegrationEnabled(false); return }
    guard canRun(action) else { return }
    if action == .refresh && ["running", "open"].contains(snapshot?.desktop.status ?? "") {
      refreshQueued.toggle()
      message = refreshQueued ? "Refresh queued. Fully quit Codex to update the picker." : "Queued refresh cancelled."
      return
    }
    var confirmed = false
    if action == .recover {
      confirmed = confirmation(title: "Repair the picker after a Codex update?",
        text: "Codex will quit twice. Active tasks may be interrupted. PickerMux temporarily opens Codex with native models to refresh the account cache, then restores the picker and opens Codex again. The installation capability changes; earlier encrypted compaction continuations cannot be resumed. An interrupted recovery also requires this confirmation again.",
        button: "Start repair")
    } else if action == .certify {
      confirmed = confirmation(title: "Certify loaded models?",
        text: "PickerMux sends live test prompts to the configured providers. Certification can take several minutes per model. Finish active model tasks and leave the models loaded until it completes.", button: "Start certification")
    } else if action == .update {
      confirmed = confirmation(title: "Update PickerMux?",
        text: "PickerMux will verify the release download and activate it through its existing distribution transaction. The CLI remains responsible for ownership checks and rollback. Review the current status after the update.", button: "Update")
    }
    if [.recover, .certify, .update].contains(action) && !confirmed { return }
    let token = preview?.previewToken
    busy = action
    operationNotice = nil
    message = action == .certify ? "Certification is running; keep models loaded." : "\(action.label)…"
    Task {
      defer { busy = nil }
      do {
        let result = try await client.run(action, confirmed: confirmed, previewToken: token)
        if action == .configurationApply { preview = nil }
        if result.ok {
          if let returnedPreview = result.preview { preview = returnedPreview }
          if let returnedUpdate = result.update { update = returnedUpdate }
          operationNotice = resultMessage(result, action: action)
        } else {
          operationNotice = companionActionFailureMessage(result.code)
        }
      } catch {
        if action == .configurationApply { preview = nil }
        operationNotice = failureMessage(error)
      }
      busy = nil
      await refreshStatus()
    }
  }

  func setLoginEnabled(_ enabled: Bool) {
    do {
      if enabled { try SMAppService.mainApp.register() }
      else { try SMAppService.mainApp.unregister() }
      loginEnabled = SMAppService.mainApp.status == .enabled
      if enabled && !loginEnabled { message = "Allow PickerMux in System Settings > General > Login Items." }
    } catch {
      loginEnabled = SMAppService.mainApp.status == .enabled
      message = "The login setting could not be changed. Review System Settings > General > Login Items."
    }
  }

  func showHelp() {
    let alert = NSAlert()
    let nodeRequirement = "The companion requires Node.js 22.15 or newer at /opt/homebrew/bin/node, /usr/local/bin/node or /usr/bin/node. A runtime available only through a shell profile cannot be used."
    if statusFailure == .unsafeNode {
      alert.messageText = "Review the Node.js installation"
      alert.informativeText = "Node.js is installed at a supported location, but its executable or directory ownership could not be verified. Review the installation using the troubleshooting guide, then retry status. \(nodeRequirement)"
    } else if statusFailure == .missingNode {
      alert.messageText = "Set up Node.js for PickerMux"
      alert.informativeText = "\(nodeRequirement) If Node.js is already installed, review its version and location before installing again. The official Node.js installer provides a supported runtime. Choose Retry status after setup."
    } else {
      alert.messageText = "PickerMux setup and troubleshooting"
      alert.informativeText = "\(nodeRequirement) Once status loads, turn on Use PickerMux in Codex to review and confirm installation or activation. Turn it off to use the native Codex picker while retaining PickerMux settings. Copying the app from the disk image does not install the bridge. Use the troubleshooting guide for a refused status or action."
    }
    alert.alertStyle = .informational
    alert.addButton(withTitle: "Close")
    alert.addButton(withTitle: "Node.js downloads")
    alert.addButton(withTitle: "Troubleshooting")
    NSApp.activate(ignoringOtherApps: true)
    let response = alert.runModal()
    if response == .alertSecondButtonReturn {
      if let url = URL(string: "https://nodejs.org/en/download") { NSWorkspace.shared.open(url) }
    } else if response == .alertThirdButtonReturn {
      if let url = URL(string: "https://github.com/patrickschiller/pickermux/blob/main/docs/TROUBLESHOOTING.md#companion-cannot-find-or-validate-the-cli-or-nodejs") { NSWorkspace.shared.open(url) }
    }
  }

  func setNotificationsEnabled(_ enabled: Bool) {
    if !enabled {
      notificationsEnabled = false
      UserDefaults.standard.set(false, forKey: "statusNotifications")
      return
    }
    Task {
      let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert])) ?? false
      notificationsEnabled = granted
      UserDefaults.standard.set(granted, forKey: "statusNotifications")
      if !granted { message = "Enable PickerMux notifications in System Settings to receive recovery notices." }
    }
  }

  private func notifyIfActionable(_ snapshot: CompanionSnapshot, recoveryCompleted: Bool) async {
    let body: String?
    if recoveryCompleted || snapshot.recovery.status == "completed" { body = "PickerMux recovery completed. The picker is ready to review." }
    else if ["failed", "interrupted"].contains(snapshot.recovery.status) { body = "PickerMux recovery needs attention. Open the menu to review its status." }
    else if snapshot.state == "update-required" { body = "Codex changed. Open PickerMux to review the required repair." }
    else if snapshot.state == "configuration-conflict" { body = "The picker configuration changed. Open PickerMux to review the integration." }
    else { body = nil }
    guard let body else { return }
    let content = UNMutableNotificationContent()
    content.title = "PickerMux"
    content.body = body
    try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "pickermux-state", content: content, trigger: nil))
  }

  private func confirmation(title: String, text: String, button: String) -> Bool {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = text
    alert.alertStyle = .warning
    alert.addButton(withTitle: button)
    alert.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    return alert.runModal() == .alertFirstButtonReturn
  }

  private func resultMessage(_ result: CompanionResult, action: CompanionAction) -> String {
    if result.certificationIncomplete { return "PickerMux is installed, but model certification is incomplete. Leave models loaded and choose Certify loaded models to retry." }
    if action == .configurationApply { return "PickerMux setup completed. Review the status, then reopen Codex to load the picker." }
    if action == .integrationDeactivate { return "PickerMux was turned off. Reopen Codex to load the native picker. The app and PickerMux settings remain installed." }
    if let update = result.update {
      if update.status == "updated" || update.status == "installed" { return "PickerMux was updated. Open Codex after reviewing the status; install the matching companion app when its version changes." }
      if update.status == "available", let version = update.targetVersion { return "PickerMux \(version) is available." }
      if update.status == "current" { return "PickerMux is up to date." }
      return "Update information is unavailable."
    }
    if action == .recover { return "Recovery started. The status shows its progress." }
    if action == .configurationPreview { return "Review the setup details. Turn on Use PickerMux in Codex to confirm installation or activation." }
    return "PickerMux completed the requested action."
  }

  private func failureMessage(_ error: Error) -> String {
    (error as? CompanionFailure)?.message ?? "PickerMux could not complete the request. Review its status."
  }

}

private struct CompanionPanel: View {
  @ObservedObject var controller: CompanionController

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("PickerMux").font(.headline)
        Spacer()
        if controller.busy != nil { ProgressView().controlSize(.small) }
      }
      HStack(spacing: 8) {
        Button(controller.snapshot == nil ? "Retry status" : "Check status") { Task { await controller.refreshStatus() } }
        Button("Help…") { controller.showHelp() }
        Spacer(minLength: 0)
        if #available(macOS 14.0, *) {
          SettingsLink { Text("Settings…") }
        } else {
          Button("Settings…") {
            NSApp.activate(ignoringOtherApps: true)
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
          }
        }
        Button("Quit") { NSApp.terminate(nil) }
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      Divider()
      Toggle("Use PickerMux in Codex", isOn: Binding(
        get: { controller.integrationState.isEnabled },
        set: { controller.setIntegrationEnabled($0) }))
        .toggleStyle(.switch)
        .disabled(!controller.integrationState.canChange)
        .accessibilityHint(controller.integrationState.guidance)
      Text(controller.integrationState.label).font(.subheadline.weight(.semibold))
      Text(controller.integrationState.guidance)
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      if controller.integrationState.needsSetupUpgrade {
        Button("Complete PickerMux setup…") { controller.setIntegrationEnabled(true, reviewInstalledSetup: true) }
          .disabled(!controller.integrationState.canReviewSetup)
      }
      if controller.busy != nil || controller.snapshot == nil {
        Text(controller.message).font(.callout).fixedSize(horizontal: false, vertical: true)
      }
      if let notice = controller.operationNotice {
        Text(notice).font(.caption).fixedSize(horizontal: false, vertical: true)
      }
      if let snapshot = controller.snapshot {
        DisclosureGroup("Installation details") {
          VStack(alignment: .leading, spacing: 4) {
            statusRow("Status", snapshot.state)
            statusRow("Codex", snapshot.desktop.status)
            statusRow("Bridge", snapshot.service.status)
            statusRow("Compatibility", snapshot.compatibility.status)
            statusRow("Account cache", snapshot.accountCache.status)
            statusRow("Integration", snapshot.integration.status)
            if snapshot.recovery.status != "idle" {
              statusRow("Recovery", snapshot.recovery.phase ?? snapshot.recovery.status)
            }
            if !snapshot.issues.isEmpty {
              Text("The installation needs attention. Check it or review the available repair.")
                .font(.caption).foregroundStyle(.secondary)
            }
            if controller.appVersion != "development" && controller.appVersion != snapshot.version {
              Text("App \(controller.appVersion) · Backend \(snapshot.version). Install the matching app after updating PickerMux.")
                .font(.caption).foregroundStyle(.secondary)
            }
          }
        }
      }
      if let preview = controller.preview {
        DisclosureGroup("Reviewed setup details") {
          Text("Current picker: \(preview.status == "none" ? "Native Codex" : statusLabel(preview.status))").font(.caption)
          Text(preview.canApply
            ? "Turning on PickerMux requests a fresh review and confirmation."
            : "Configuration needs review before it can be changed.").font(.caption)
          ForEach(preview.changes, id: \.self) { change in
            Text(changeLabel(change)).font(.caption).foregroundStyle(.secondary)
          }
        }
      }
      if let update = controller.update {
        Text(update.status == "available" ? "Available: \(update.targetVersion ?? "a newer version")" : "Update check: \(statusLabel(update.status))")
          .font(.caption)
      }
      if controller.refreshQueued {
        Text("Refresh queued until Codex fully quits.").font(.caption)
      }
      if controller.snapshot != nil {
        Divider()
        ForEach(CompanionAction.allCases, id: \.self) { action in
          if ![.configurationPreview, .configurationApply, .integrationDeactivate].contains(action) && controller.snapshot?.actions.contains(action) == true {
            Button(action == .refresh && controller.refreshQueued ? "Cancel queued refresh" : action.label) { controller.perform(action) }
              .disabled(!controller.canRun(action))
          }
        }
      }
    }
    .padding(16)
    .frame(width: 380)
  }

  private func statusRow(_ label: String, _ status: String) -> some View {
    HStack {
      Text(label).foregroundStyle(.secondary)
      Spacer()
      Text(statusLabel(status))
    }.font(.caption)
  }

  private func changeLabel(_ change: String) -> String {
    let labels = [
      "replace-integration": "Replace the current picker gateway with PickerMux.",
      "preserve-user-settings": "Preserve settings outside the owned integration.",
      "preserve-historical-chats": "Preserve the provider alias for historical chats.",
      "restore-on-failure": "Restore the prior configuration if activation fails.",
      "retain-explicit-provider": "Retain the verified HTTP/SSE and zero-retry transport.",
      "create-backup": "Retain a verified backup of the prior configuration.",
      "normalize-owned-blocks": "Consolidate PickerMux's owned configuration fields.",
      "reactivate-integration": "Enable the installed PickerMux bridge again.",
    ]
    return labels[change] ?? "Apply an owned integration change from the reviewed preview."
  }
}

private struct CompanionSettings: View {
  @ObservedObject var controller: CompanionController

  var body: some View {
    Form {
      Toggle("Start PickerMux companion at login", isOn: Binding(
        get: { controller.loginEnabled }, set: { controller.setLoginEnabled($0) }))
      Toggle("Refresh picker automatically when Codex closes", isOn: $controller.refreshOnClose)
      Toggle("Notify when an update or repair needs attention", isOn: Binding(
        get: { controller.notificationsEnabled }, set: { controller.setNotificationsEnabled($0) }))
      Text("Status is checked every five seconds. Automatic refresh is off by default and runs once after Codex closes when the integration is ready. Updates, certification, configuration changes and recovery start only when you choose an action.")
        .font(.caption).foregroundStyle(.secondary)
      Text("Turn on Use PickerMux in Codex to review and confirm installation or activation. The switch follows verified status; turning it off keeps this app installed. Requires Node.js 22.15 or newer in /opt/homebrew/bin, /usr/local/bin or /usr/bin.")
        .font(.caption).foregroundStyle(.secondary)
      Text("PickerMux is an unofficial community project, unaffiliated with OpenAI, Codex or LM Studio.")
        .font(.caption).foregroundStyle(.secondary)
      Text("App version: \(controller.appVersion)").font(.caption)
    }
    .padding(20)
    .frame(width: 440)
  }
}
