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
    return snapshot?.state == "ready" ? "checkmark.circle" : "exclamationmark.circle"
  }

  var appVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development"
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
      if busy == nil { message = statusLabel(next.state) }
      if changed && notificationsEnabled { await notifyIfActionable(next, recoveryCompleted: recoveryCompleted) }
      lastTransition = next.transitionIdentity
      if shouldRefresh { refreshQueued = false; perform(.refresh) }
    } catch {
      snapshot = nil
      preview = nil
      message = failureMessage(error)
    }
  }

  func canRun(_ action: CompanionAction) -> Bool {
    guard busy == nil, snapshot?.actions.contains(action) == true else { return false }
    if action == .configurationApply { return preview?.canApply == true && preview?.previewToken != nil }
    return true
  }

  func perform(_ action: CompanionAction) {
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
    } else if action == .configurationApply {
      confirmed = confirmation(title: "Replace the current picker integration?",
        text: "Apply the configuration preview with Codex fully closed. PickerMux replaces the current gateway, including an Ollama integration if present, using a verified backup and conflict checks. The earlier configuration remains restorable. Intentional user changes stop the operation.", button: "Apply preview")
    }
    if [.recover, .certify, .update, .configurationApply].contains(action) && !confirmed { return }
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
          operationNotice = safeErrorMessage(result.code)
        }
      } catch {
        if action == .configurationApply { preview = nil }
        operationNotice = failureMessage(error)
      }
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
    if result.certificationIncomplete { return "PickerMux was updated, but model certification is incomplete. Leave models loaded and choose Certify loaded models to retry." }
    if let update = result.update {
      if update.status == "updated" || update.status == "installed" { return "PickerMux was updated. Open Codex after reviewing the status; install the matching companion app when its version changes." }
      if update.status == "available", let version = update.targetVersion { return "PickerMux \(version) is available." }
      if update.status == "current" { return "PickerMux is up to date." }
      return "Update information is unavailable."
    }
    if action == .recover { return "Recovery started. The status shows its progress." }
    if action == .configurationPreview { return "Review the configuration preview before applying it." }
    return "PickerMux completed the requested action."
  }

  private func failureMessage(_ error: Error) -> String {
    (error as? CompanionFailure)?.message ?? "PickerMux could not complete the request. Review its status."
  }

  private func safeErrorMessage(_ code: String) -> String {
    let messages = [
      "CONFIRMATION_REQUIRED": "Confirm the operation before retrying.",
      "ACTION_NOT_ALLOWED": "The action is unavailable in the current state. Check the status.",
      "BUSY": "Another PickerMux operation is active. Wait for it to finish.",
      "CONFIGURATION_CONFLICT": "Configuration changed. Review a fresh preview before applying it.",
      "PREVIEW_STALE": "The configuration preview expired or changed. Create a fresh preview.",
      "COMPATIBILITY_MISMATCH": "Codex changed. Review the required recovery.",
      "NOT_INSTALLED": "Install the current PickerMux CLI first.",
    ]
    return messages[code] ?? "PickerMux could not complete the action. Review the installation status."
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
      Text(controller.message).font(.callout).fixedSize(horizontal: false, vertical: true)
      if let notice = controller.operationNotice {
        Text(notice).font(.caption).fixedSize(horizontal: false, vertical: true)
      }
      if let snapshot = controller.snapshot {
        VStack(alignment: .leading, spacing: 4) {
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
      if let preview = controller.preview {
        Divider()
        Text("Configuration preview").font(.subheadline.weight(.semibold))
        Text("Current integration: \(statusLabel(preview.status))").font(.caption)
        Text(preview.canApply
          ? "PickerMux can apply the reviewed change after your confirmation."
          : "Configuration needs review before it can be changed.").font(.caption)
        ForEach(preview.changes, id: \.self) { change in
          Text(changeLabel(change)).font(.caption).foregroundStyle(.secondary)
        }
      }
      if let update = controller.update {
        Text(update.status == "available" ? "Available: \(update.targetVersion ?? "a newer version")" : "Update check: \(statusLabel(update.status))")
          .font(.caption)
      }
      if controller.refreshQueued {
        Text("Refresh queued until Codex fully quits.").font(.caption)
      }
      Divider()
      ForEach(CompanionAction.allCases, id: \.self) { action in
        if controller.snapshot?.actions.contains(action) == true {
          Button(action == .refresh && controller.refreshQueued ? "Cancel queued refresh" : action.label) { controller.perform(action) }
            .disabled(!controller.canRun(action))
        }
      }
      HStack {
        Button("Check status") { Task { await controller.refreshStatus() } }
        Spacer()
        if #available(macOS 14.0, *) {
          SettingsLink { Text("Settings…") }
        } else {
          Button("Settings…") { NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil) }
        }
        Button("Quit") { NSApp.terminate(nil) }
      }.font(.caption)
    }
    .padding(16)
    .frame(width: 350)
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
      Text("The app includes a verified backend to preview and install the integration. Other actions use the current receipt-owned CLI. Requires Node.js 22.15 or newer in /opt/homebrew/bin, /usr/local/bin or /usr/bin.")
        .font(.caption).foregroundStyle(.secondary)
      Text("PickerMux is an unofficial community project, unaffiliated with OpenAI, Codex or LM Studio.")
        .font(.caption).foregroundStyle(.secondary)
      Text("App version: \(controller.appVersion)").font(.caption)
    }
    .padding(20)
    .frame(width: 440)
  }
}
