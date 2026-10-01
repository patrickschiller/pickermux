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
    MenuBarExtra {
      CompanionPanel(controller: controller)
    } label: {
      Image(nsImage: menuBarImage)
        .accessibilityLabel(controller.menuAccessibilityLabel)
    }
    .menuBarExtraStyle(.window)
  }

  private var menuBarImage: NSImage {
    let image = NSImage(named: "MenuBarIcon") ?? fallbackMenuBarImage()
    image.isTemplate = true
    image.size = NSSize(width: 18, height: 18)
    return image
  }

  private func fallbackMenuBarImage() -> NSImage {
    NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
      let path = NSBezierPath()
      path.lineWidth = 1.6
      path.lineCapStyle = .round
      for y in [CGFloat(4), 9, 14] {
        path.move(to: NSPoint(x: 2, y: y))
        path.line(to: NSPoint(x: 7, y: y))
        path.line(to: NSPoint(x: 11, y: 9))
      }
      path.stroke()
      NSBezierPath(ovalIn: NSRect(x: 11, y: 6, width: 6, height: 6)).fill()
      return true
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
  @Published var operationNoticeAction: CompanionAction?
  @Published var operationFailed = false
  @Published var operationStartedAt: Date?
  @Published var isCheckingStatus = false
  @Published var statusCheckNotice: String?
  @Published var lastStatusCheck: Date?
  @Published var preview: ConfigurationPreview?
  @Published var update: UpdateStatus?
  @Published var loginEnabled = SMAppService.mainApp.status == .enabled
  @Published var notificationsEnabled = UserDefaults.standard.bool(forKey: "statusNotifications")
  @Published var refreshOnClose = UserDefaults.standard.bool(forKey: "refreshOnClose") {
    didSet { UserDefaults.standard.set(refreshOnClose, forKey: "refreshOnClose") }
  }
  private let client = PickerMuxClient()
  private var polling: Task<Void, Never>?
  private let operationQueue = CompanionOperationQueue()
  private var pendingManualChecks = 0
  private var settingsWindow: NSWindow?
  private var helpWindow: NSWindow?
  private var confirmationWindow: ActionConfirmationWindow?
  private var lastTransition: String?

  var menuAccessibilityLabel: String {
    "PickerMux, \(busy != nil ? "operation in progress" : statusLabel(snapshot?.state ?? "unknown"))"
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

  func refreshStatus(manual: Bool = false) async {
    if manual {
      pendingManualChecks += 1
      isCheckingStatus = true
      statusCheckNotice = busy == nil ? "Checking status…" : "Status check queued until the current action finishes."
    } else if busy != nil || !operationQueue.isIdle { return }
    let lease = await operationQueue.acquire(.status)
    if manual { statusCheckNotice = "Checking status…" }
    var autoRefresh = false
    do {
      let next = try await client.status()
      if snapshot?.integration.status != next.integration.status { preview = nil }
      let changed = lastTransition != nil && lastTransition != next.transitionIdentity
      let desktopJustClosed = ["running", "open"].contains(snapshot?.desktop.status ?? "") && ["stopped", "closed"].contains(next.desktop.status)
      autoRefresh = (refreshQueued || (refreshOnClose && desktopJustClosed)) && busy == nil && next.state == "ready" && ["idle", "completed"].contains(next.recovery.status) && next.actions.contains(.refresh)
      let recoveryCompleted = shouldNotifyRecoveryCompletion(previous: snapshot, next: next)
      snapshot = next
      statusFailure = nil
      let checkedAt = Date()
      lastStatusCheck = checkedAt
      if manual { statusCheckNotice = "Status checked at \(checkedAt.formatted(date: .omitted, time: .standard))." }
      if busy == nil { message = statusLabel(next.state) }
      if changed && notificationsEnabled { await notifyIfActionable(next, recoveryCompleted: recoveryCompleted) }
      lastTransition = next.transitionIdentity
    } catch {
      snapshot = nil
      preview = nil
      statusFailure = error as? CompanionFailure
      if busy == nil { message = failureMessage(error) }
      if manual { statusCheckNotice = "Status check failed: \(failureMessage(error))" }
    }
    if manual {
      pendingManualChecks -= 1
      isCheckingStatus = pendingManualChecks > 0
    }
    operationQueue.release(lease)
    if autoRefresh { refreshQueued = false; perform(.refresh) }
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
    operationNoticeAction = busy
    operationFailed = false
    operationStartedAt = Date()
    message = enabled ? "Installing and activating PickerMux… Keep Codex closed and models loaded." : "Turning off PickerMux…"
    Task {
      let lease = await operationQueue.acquire(.action)
      do {
        let outcome = try await changePickerMuxIntegration(enabled, reviewInstalledSetup: reviewInstalledSetup,
          client: client, consent: .toggleIntent)
        switch outcome {
        case .unchanged: operationNotice = "The integration already has the requested state."
        case .cancelled: operationNotice = "The integration change was cancelled."
        case .blocked:
          operationFailed = true
          operationNotice = "The integration cannot be changed yet. Check status and follow the setup guidance."
        case .completed(let result):
          operationFailed = !result.ok
          operationNotice = result.ok ? resultMessage(result, action: enabled ? .configurationApply : .integrationDeactivate) :
            companionActionFailureMessage(result.code)
        }
      } catch {
        operationFailed = true
        operationNotice = failureMessage(error)
      }
      preview = nil
      busy = nil
      operationStartedAt = nil
      operationQueue.release(lease)
      await refreshStatus()
    }
  }

  func perform(_ action: CompanionAction) {
    if action == .configurationApply { setIntegrationEnabled(true); return }
    if action == .integrationDeactivate { setIntegrationEnabled(false); return }
    guard canRun(action) else { return }
    if action == .refresh && ["running", "open"].contains(snapshot?.desktop.status ?? "") {
      refreshQueued.toggle()
      operationNoticeAction = .refresh
      operationFailed = false
      operationNotice = refreshQueued ? "Refresh queued. Fully quit Codex to update the picker." : "Queued refresh cancelled."
      return
    }
    busy = action
    operationNotice = nil
    operationNoticeAction = action
    operationFailed = false
    operationStartedAt = Date()
    message = action == .certify ? "Certification is running; keep models loaded." : "\(action.label)…"
    Task {
      let lease = await operationQueue.acquire(.action)
      var confirmed = false
      if action == .recover {
        confirmed = await confirmation(title: "Repair the picker after a Codex update?",
          text: "Codex will quit twice. Active tasks may be interrupted. PickerMux temporarily opens Codex with native models to refresh the account cache, then restores the picker and opens Codex again. The installation capability changes; earlier encrypted compaction continuations cannot be resumed. An interrupted recovery also requires this confirmation again.",
          button: "Start repair")
      } else if action == .certify {
        confirmed = await confirmation(title: "Certify loaded models?",
          text: "PickerMux sends live test prompts to the configured providers. Certification can take several minutes per model. Finish active model tasks and leave the models loaded until it completes.", button: "Start certification")
      } else if action == .update {
        confirmed = await confirmation(title: "Update PickerMux?",
          text: "PickerMux will verify the release download and activate it through its existing distribution transaction. The CLI remains responsible for ownership checks and rollback. Review the current status after the update.", button: "Update")
      }
      if [.recover, .certify, .update].contains(action) && !confirmed {
        operationNotice = "The action was cancelled."
      } else {
        do {
          let result = try await client.run(action, confirmed: confirmed, previewToken: preview?.previewToken)
          if result.ok {
            if let returnedPreview = result.preview { preview = returnedPreview }
            if let returnedUpdate = result.update { update = returnedUpdate }
            operationNotice = resultMessage(result, action: action)
          } else {
            operationFailed = true
            operationNotice = companionActionFailureMessage(result.code)
          }
        } catch {
          operationFailed = true
          operationNotice = failureMessage(error)
        }
      }
      busy = nil
      operationStartedAt = nil
      operationQueue.release(lease)
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

  func showSettings() {
    if settingsWindow == nil {
      settingsWindow = makeWindow(title: "PickerMux Settings", content: CompanionSettings(controller: self))
    }
    presentWindow(settingsWindow!)
  }

  func showHelp() {
    if helpWindow == nil {
      helpWindow = makeWindow(title: "PickerMux Help", content: CompanionHelp(controller: self))
    }
    presentWindow(helpWindow!)
  }

  private func makeWindow<Content: View>(title: String, content: Content) -> NSWindow {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 420),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = title
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: content)
    window.collectionBehavior.insert(.moveToActiveSpace)
    window.minSize = NSSize(width: 420, height: 300)
    window.center()
    return window
  }

  private func presentWindow(_ window: NSWindow) {
    if let content = window.contentView { window.setContentSize(content.fittingSize) }
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
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

  private func confirmation(title: String, text: String, button: String) async -> Bool {
    guard confirmationWindow == nil else { return false }
    return await withCheckedContinuation { continuation in
      let presenter = ActionConfirmationWindow(title: title, text: text, button: button) { [weak self] confirmed in
        self?.confirmationWindow = nil
        continuation.resume(returning: confirmed)
      }
      confirmationWindow = presenter
      presenter.show()
    }
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
    if action == .configurationPreview { return "Review the setup details. Turning on Use PickerMux in Codex installs and activates it." }
    return "PickerMux completed the requested action."
  }

  private func failureMessage(_ error: Error) -> String {
    (error as? CompanionFailure)?.message ?? "PickerMux could not complete the request. Review its status."
  }

}

private struct CompanionPanel: View {
  @ObservedObject var controller: CompanionController

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text("Use PickerMux in Codex").font(.subheadline.weight(.semibold))
        Spacer()
        Toggle("Use PickerMux in Codex", isOn: Binding(
          get: { controller.integrationState.isEnabled },
          set: { controller.setIntegrationEnabled($0) }))
          .labelsHidden()
          .toggleStyle(.switch)
          .controlSize(.small)
          .disabled(!controller.integrationState.canChange)
          .accessibilityHint(controller.integrationState.guidance)
      }
      Text(controller.operationFailed && controller.busy == nil && controller.operationNoticeAction == .configurationApply ? "Setup needs attention" : controller.integrationState.label)
        .font(.caption.weight(.semibold))
      if controller.busy != nil {
        OperationProgress(controller: controller)
      } else {
        Text(controller.integrationState.guidance)
          .font(.caption).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if controller.integrationState.needsSetupUpgrade {
        Button("Complete PickerMux setup") { controller.setIntegrationEnabled(true, reviewInstalledSetup: true) }
          .disabled(!controller.integrationState.canReviewSetup)
      }
      if controller.snapshot == nil && controller.busy == nil {
        Text(controller.message).font(.caption).fixedSize(horizontal: false, vertical: true)
      }
      if let notice = controller.operationNotice,
         controller.operationNoticeAction != .updateCheck && controller.operationNoticeAction != .update {
        Text(notice).font(.caption)
          .foregroundStyle(controller.operationFailed ? Color.orange : Color.primary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityLabel(notice)
      }
      Divider()
      HStack(spacing: 6) {
        Button(controller.isCheckingStatus ? "Checking…" : "Check status") {
          Task { await controller.refreshStatus(manual: true) }
        }
        .disabled(controller.isCheckingStatus)
        Spacer(minLength: 0)
        Button("Settings…") { controller.showSettings() }
        Button("Help…") { controller.showHelp() }
        Button("Quit") { NSApp.terminate(nil) }
      }
      .buttonStyle(.bordered)
      .controlSize(.small)
      if let notice = controller.statusCheckNotice {
        Text(notice).font(.caption2).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
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
          }
        }
        .font(.caption)
      }
      if controller.refreshQueued {
        Text("Refresh queued until Codex fully quits.").font(.caption)
      }
      let actions = CompanionAction.allCases.filter {
        ![.configurationPreview, .configurationApply, .integrationDeactivate, .updateCheck, .update].contains($0) && controller.snapshot?.actions.contains($0) == true
      }
      if !actions.isEmpty {
        Divider()
        ForEach(actions, id: \.self) { action in
          Button(action == .refresh && controller.refreshQueued ? "Cancel queued refresh" : action.label) { controller.perform(action) }
            .disabled(!controller.canRun(action))
        }
        .controlSize(.small)
      }
    }
    .padding(14)
    .frame(width: 350)
  }

  private func statusRow(_ label: String, _ status: String) -> some View {
    HStack {
      Text(label).foregroundStyle(.secondary)
      Spacer()
      Text(statusLabel(status))
    }.font(.caption)
  }
}

private struct OperationProgress: View {
  @ObservedObject var controller: CompanionController

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      ProgressView().controlSize(.small)
      VStack(alignment: .leading, spacing: 3) {
        Text(controller.message).font(.caption).fixedSize(horizontal: false, vertical: true)
        if let started = controller.operationStartedAt {
          TimelineView(.periodic(from: started, by: 1)) { context in
            let elapsed = max(0, Int(context.date.timeIntervalSince(started)))
            Text("Running \(elapsed / 60)m \(elapsed % 60)s · setup and certification may take several minutes.")
              .font(.caption2).foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
  }
}

private struct CompanionSettings: View {
  @ObservedObject var controller: CompanionController

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("PickerMux Settings").font(.title2.weight(.semibold))
      GroupBox("Updates") {
        VStack(alignment: .leading, spacing: 8) {
          Text("App \(controller.appVersion) · Backend \(controller.snapshot?.version ?? "unavailable")")
            .font(.caption).foregroundStyle(.secondary)
          if let update = controller.update {
            Text(update.status == "available" ? "PickerMux \(update.targetVersion ?? "update") is available." : "Update status: \(statusLabel(update.status))")
              .font(.caption)
          }
          HStack {
            Button(controller.busy == .updateCheck ? "Checking updates…" : "Check for updates") { controller.perform(.updateCheck) }
              .disabled(!controller.canRun(.updateCheck))
            if controller.snapshot?.actions.contains(.update) == true {
              Button("Update PickerMux…") { controller.perform(.update) }
                .disabled(!controller.canRun(.update))
            }
          }
          if let notice = controller.operationNotice,
             controller.operationNoticeAction == .updateCheck || controller.operationNoticeAction == .update {
            Text(notice).font(.caption)
              .foregroundStyle(controller.operationFailed ? Color.orange : Color.primary)
              .fixedSize(horizontal: false, vertical: true)
          }
          Text("CLI updates and companion-app replacement are separate. Install the matching app when its version changes.")
            .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      VStack(alignment: .leading, spacing: 10) {
        Toggle("Start PickerMux companion at login", isOn: Binding(
          get: { controller.loginEnabled }, set: { controller.setLoginEnabled($0) }))
        Toggle("Refresh picker automatically when Codex closes", isOn: $controller.refreshOnClose)
        Toggle("Notify when an update or repair needs attention", isOn: Binding(
          get: { controller.notificationsEnabled }, set: { controller.setNotificationsEnabled($0) }))
      }
      Text("Status is checked every five seconds. Automatic refresh is off by default and runs after Codex fully closes. Updates, additional certification and recovery require explicit confirmation.")
        .font(.caption).foregroundStyle(.secondary)
      if let checked = controller.lastStatusCheck {
        Text("Last status check: \(checked.formatted(date: .omitted, time: .standard))")
          .font(.caption).foregroundStyle(.secondary)
      }
      Text("PickerMux is an unofficial community project, unaffiliated with OpenAI, Codex or LM Studio.")
        .font(.caption).foregroundStyle(.secondary)
    }
    .padding(20)
    .frame(width: 480)
  }
}

private struct CompanionHelp: View {
  @ObservedObject var controller: CompanionController

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("PickerMux setup and help").font(.title2.weight(.semibold))
      if let failure = controller.statusFailure {
        Text(failure.message).font(.callout)
      }
      Text("Turn on Use PickerMux in Codex to install and activate automatically. Turn it off to return to native Codex models while retaining PickerMux settings and certifications.")
      Text("Fully quit Codex with Command-Q and keep your model server running with models loaded during setup. Setup may send live certification test prompts.")
      Text("Requires Node.js 22.15 or newer at /opt/homebrew/bin/node, /usr/local/bin/node or /usr/bin/node. A runtime available only through a shell profile cannot be used.")
        .font(.caption).foregroundStyle(.secondary)
      HStack {
        Link("Node.js downloads", destination: URL(string: "https://nodejs.org/en/download")!)
        Link("Troubleshooting", destination: URL(string: "https://github.com/patrickschiller/pickermux/blob/main/docs/TROUBLESHOOTING.md")!)
      }
      Button("Check status") { Task { await controller.refreshStatus(manual: true) } }
        .disabled(controller.isCheckingStatus)
      if let notice = controller.statusCheckNotice { Text(notice).font(.caption).foregroundStyle(.secondary) }
    }
    .padding(20)
    .frame(width: 480)
  }
}

@MainActor
private final class ActionConfirmationWindow: NSObject, NSWindowDelegate {
  private let window: NSWindow
  private var response: ((Bool) -> Void)?

  init(title: String, text: String, button: String, response: @escaping (Bool) -> Void) {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 300),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    self.response = response
    super.init()
    window.title = "PickerMux"
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.contentView = NSHostingView(rootView: ActionConfirmationView(title: title, text: text, button: button,
      confirm: { [weak self] in self?.finish(true) }, cancel: { [weak self] in self?.finish(false) }))
    window.center()
  }

  func show() {
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }

  func windowWillClose(_ notification: Notification) { finish(false) }

  private func finish(_ approved: Bool) {
    guard let response else { return }
    self.response = nil
    window.close()
    response(approved)
  }
}

private struct ActionConfirmationView: View {
  let title: String
  let text: String
  let button: String
  let confirm: () -> Void
  let cancel: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(title).font(.headline)
      Text(text).font(.callout).fixedSize(horizontal: false, vertical: true)
      HStack {
        Spacer()
        Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
        Button(button, action: confirm).keyboardShortcut(.defaultAction)
      }
    }
    .padding(20)
    .frame(width: 460)
  }
}
