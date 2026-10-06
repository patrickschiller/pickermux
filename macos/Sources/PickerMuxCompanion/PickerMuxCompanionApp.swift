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
  @Published var removalState: CompanionRemovalState = .idle
  @Published var notificationsEnabled = UserDefaults.standard.bool(forKey: "statusNotifications")
  @Published var refreshOnClose = UserDefaults.standard.bool(forKey: "refreshOnClose") {
    didSet { UserDefaults.standard.set(refreshOnClose, forKey: "refreshOnClose") }
  }
  private let client: PickerMuxClient
  private let versionOverride: String?
  private let integrationConfirmation: (@MainActor (IntegrationReview) async -> Bool)?
  private let lmStudioSetupConfirmation: (@MainActor (LMStudioSetupReview) async -> Bool)?
  private var backendUpgradePrompt = BackendUpgradePrompt()
  private var polling: Task<Void, Never>?
  private let operationQueue = CompanionOperationQueue()
  private var pendingManualChecks = 0
  private var configWindow: NSWindow?
  private var helpWindow: NSWindow?
  private var confirmationWindow: ActionConfirmationWindow?
  private var lastTransition: String?
  private lazy var removal: CompanionRemovalCoordinator = {
    let coordinator = CompanionRemovalCoordinator()
    coordinator.onStateChange = { [weak self] state in
      self?.removalState = state
      if let notice = state.notice { self?.message = notice }
    }
    return coordinator
  }()

  var activityAllowed: Bool { removalState.permitsActivity }
  var canRemove: Bool { busy == nil && activityAllowed && CompanionRemovalCoordinator.canRemove(snapshot) }

  var menuAccessibilityLabel: String {
    "PickerMux, \(busy != nil ? "operation in progress" : statusLabel(snapshot?.state ?? "unknown"))"
  }

  var appVersion: String {
    versionOverride ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "development"
  }

  var integrationState: IntegrationToggleState {
    IntegrationToggleState(snapshot: snapshot, busy: busy != nil || !activityAllowed)
  }

  var integrationLabel: String {
    IntegrationToggleState(snapshot: snapshot).label
  }

  var backendUpgradeAvailable: Bool {
    companionBackendUpgradeAvailable(appVersion: appVersion, snapshot: snapshot)
  }

  var canReviewBackendUpgrade: Bool {
    backendUpgradeAvailable && integrationState.canReviewSetup
  }

  var bundledSetupAvailability: CompanionPresentation.ActionAvailability {
    CompanionPresentation.bundledSetupAvailability(snapshot: snapshot,
      activityAllowed: activityAllowed, busy: busy)
  }

  var canReviewBundledBootstrap: Bool {
    bundledSetupAvailability.isEnabled
  }

  var diskImageDownloadURL: URL? {
    update.flatMap(companionDiskImageDownloadURL)
  }

  var lastSetupFailed: Bool {
    operationFailed && busy == nil && operationNoticeAction == .configurationApply
  }

  init(pollingEnabled: Bool = true, client: PickerMuxClient = PickerMuxClient(), appVersion: String? = nil,
       integrationConfirmation: (@MainActor (IntegrationReview) async -> Bool)? = nil,
       lmStudioSetupConfirmation: (@MainActor (LMStudioSetupReview) async -> Bool)? = nil) {
    self.client = client
    versionOverride = appVersion
    self.integrationConfirmation = integrationConfirmation
    self.lmStudioSetupConfirmation = lmStudioSetupConfirmation
    if pollingEnabled { startPolling() }
  }

  private func startPolling() {
    guard polling == nil, activityAllowed else { return }
    polling = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refreshStatus()
        try? await Task.sleep(nanoseconds: 5_000_000_000)
      }
    }
  }

  deinit { polling?.cancel() }

  func refreshStatus(manual: Bool = false) async {
    let generation = removal.generation
    guard removal.permitsActivity(generation) else { return }
    if manual {
      pendingManualChecks += 1
      isCheckingStatus = true
      statusCheckNotice = busy == nil ? "Checking status…" : "Status check queued until the current action finishes."
    } else if busy != nil || !operationQueue.isIdle { return }
    let lease = await operationQueue.acquire(.status)
    defer {
      if manual {
        pendingManualChecks -= 1
        isCheckingStatus = pendingManualChecks > 0
      }
      operationQueue.release(lease)
    }
    guard removal.permitsActivity(generation) else { return }
    if manual { statusCheckNotice = "Checking status…" }
    var autoRefresh = false
    do {
      let next = try await client.status()
      guard removal.permitsActivity(generation) else { return }
      if snapshot?.integration.status != next.integration.status { preview = nil }
      let changed = lastTransition != nil && lastTransition != next.transitionIdentity
      let desktopJustClosed = ["running", "open"].contains(snapshot?.desktop.status ?? "") && ["stopped", "closed"].contains(next.desktop.status)
      autoRefresh = removalState == .idle && (refreshQueued || (refreshOnClose && desktopJustClosed)) && busy == nil && next.state == "ready" && ["idle", "completed"].contains(next.recovery.status) && next.actions.contains(.refresh)
      let recoveryCompleted = shouldNotifyRecoveryCompletion(previous: snapshot, next: next)
      snapshot = next
      statusFailure = nil
      let checkedAt = Date()
      lastStatusCheck = checkedAt
      if manual { statusCheckNotice = "Status checked at \(checkedAt.formatted(date: .omitted, time: .standard))." }
      if busy == nil { message = statusLabel(next.state) }
      if changed && notificationsEnabled { await notifyIfActionable(next, recoveryCompleted: recoveryCompleted) }
      guard removal.permitsActivity(generation) else { return }
      lastTransition = next.transitionIdentity
    } catch {
      guard removal.permitsActivity(generation) else { return }
      snapshot = nil
      preview = nil
      statusFailure = error as? CompanionFailure
      if busy == nil { message = failureMessage(error) }
      if manual { statusCheckNotice = "Status check failed. Open Help to review the installation." }
    }
    if autoRefresh && removal.permitsActivity(generation) {
      refreshQueued = false
      perform(.refresh)
    } else if removal.permitsActivity(generation), backendUpgradePrompt.reserveReview(
      appVersion: appVersion, snapshot: snapshot,
      busy: busy != nil || !activityAllowed || confirmationWindow != nil || operationQueue.waitingCount > 0) {
      setIntegrationEnabled(true, reviewInstalledSetup: true, automaticallyOffered: true)
    }
  }

  func canRun(_ action: CompanionAction) -> Bool {
    guard activityAllowed, busy == nil, snapshot != nil else { return false }
    if action == .updateCheck { return true }
    guard action != .update, snapshot?.actions.contains(action) == true else { return false }
    return true
  }

  func configAvailability(for action: CompanionAction) -> CompanionPresentation.ActionAvailability {
    CompanionPresentation.configActionAvailability(for: action, snapshot: snapshot, appVersion: appVersion,
      activityAllowed: activityAllowed, busy: busy)
  }

  func enableLMStudioModels() {
    let availability = CompanionPresentation.providerSetupAvailability(snapshot: snapshot, appVersion: appVersion,
      activityAllowed: activityAllowed, busy: busy)
    guard availability.isEnabled else { return }
    let generation = removal.generation
    busy = .lmStudioDefaultPreview
    operationNotice = nil
    operationNoticeAction = .lmStudioDefaultPreview
    operationFailed = false
    operationStartedAt = Date()
    message = "Reviewing LM Studio model setup…"
    Task {
      let lease = await operationQueue.acquire(.action)
      guard removal.permitsActivity(generation) else { operationQueue.release(lease); return }
      do {
        let outcome = try await enableDefaultLMStudioModels(client: client) { review in
          let accepted = if let confirmation = self.lmStudioSetupConfirmation {
            await confirmation(review)
          } else {
            await self.confirmation(title: review.title, text: review.text, button: review.button)
          }
          if accepted {
            self.busy = .lmStudioDefaultApply
            self.operationNoticeAction = .lmStudioDefaultApply
            self.message = "Enabling LM Studio models and running certification…"
          }
          return accepted
        }
        switch outcome {
        case .cancelled:
          operationNotice = "LM Studio model setup was cancelled. No provider configuration was changed."
        case .blocked:
          operationFailed = true
          operationNotice = "LM Studio model setup is unavailable. Refresh status and follow the guidance in Models."
        case .completed(let result):
          operationFailed = !result.ok
          operationNotice = result.ok ? resultMessage(result, action: .lmStudioDefaultApply) :
            CompanionPresentation.providerSetupFailureMessage(result.code)
        }
      } catch {
        operationFailed = true
        operationNotice = failureMessage(error)
      }
      busy = nil
      operationStartedAt = nil
      operationQueue.release(lease)
      await refreshStatus()
    }
  }

  func setIntegrationEnabled(_ enabled: Bool, reviewInstalledSetup: Bool = false, automaticallyOffered: Bool = false) {
    guard activityAllowed, busy == nil else { return }
    let generation = removal.generation
    if reviewInstalledSetup {
      guard enabled, canReviewBackendUpgrade || canReviewBundledBootstrap else { return }
    } else {
      guard integrationState.canChange, integrationState.isEnabled != enabled else { return }
    }
    let upgradingBundledBackend = reviewInstalledSetup && backendUpgradeAvailable
    if automaticallyOffered {
      guard upgradingBundledBackend, integrationState.isEnabled else { return }
    }
    if upgradingBundledBackend { backendUpgradePrompt.markReviewed(appVersion: appVersion, snapshot: snapshot) }
    busy = enabled ? .configurationApply : .integrationDeactivate
    operationNotice = nil
    operationNoticeAction = busy
    operationFailed = false
    operationStartedAt = Date()
    message = reviewInstalledSetup ? "Reviewing the bundled backend upgrade…" :
      enabled ? "Installing and activating PickerMux… Keep Codex closed and configured provider models available." : "Turning off PickerMux…"
    Task {
      let lease = await operationQueue.acquire(.action)
      guard removal.permitsActivity(generation) else { operationQueue.release(lease); return }
      do {
        let setupClient: any CompanionControlling = upgradingBundledBackend ?
          client.bundledSetupClient(appVersion: appVersion) : client
        let outcome = try await changePickerMuxIntegration(enabled, reviewInstalledSetup: reviewInstalledSetup,
          client: setupClient, consent: automaticallyOffered ? .automaticUpgradeReview : reviewInstalledSetup ? .review : .toggleIntent,
          confirm: { review in
            if let confirmation = self.integrationConfirmation { return await confirmation(review) }
            return await self.confirmation(title: review.title, text: review.text, button: review.button)
          })
        switch outcome {
        case .unchanged: operationNotice = "The integration already has the requested state."
        case .cancelled: operationNotice = "The integration change was cancelled."
        case .blocked:
          operationFailed = true
          operationNotice = "The integration cannot be changed yet. Check status in Config and follow the setup guidance."
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
    if action == .uninstall { removeCompletely(); return }
    guard ![.uninstallPreview, .update, .lmStudioDefaultPreview, .lmStudioDefaultApply].contains(action) else { return }
    if action == .configurationApply { setIntegrationEnabled(true); return }
    if action == .integrationDeactivate { setIntegrationEnabled(false); return }
    guard canRun(action) else { return }
    let generation = removal.generation
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
    message = action == .certify ? "Certification is running; keep configured provider models available." :
      CompanionPresentation.progressTitle(for: action)
    Task {
      let lease = await operationQueue.acquire(.action)
      guard removal.permitsActivity(generation) else { operationQueue.release(lease); return }
      var confirmed = false
      if action == .recover || action == .fullRefresh {
        confirmed = await confirmation(
          title: action == .recover ? "Repair the picker after a Codex update?" : "Run a full picker refresh?",
          text: "Codex will quit twice. Active tasks may be interrupted. PickerMux temporarily opens Codex with native models to refresh the account cache, then restores the picker and opens Codex again. The installation capability changes; earlier encrypted compaction continuations cannot be resumed. An interrupted refresh also requires this confirmation again.",
          button: action == .recover ? "Start repair" : "Start full refresh")
      } else if action == .certify {
        confirmed = await confirmation(title: "Certify models?",
          text: "PickerMux sends live test prompts to the configured providers. Certification can take several minutes per model. Finish active model tasks and keep the configured models available until it completes.", button: "Start certification")
      } else if action == .usageReset {
        confirmed = await confirmation(title: "Reset accumulated counts?",
          text: "Clear the saved totals for all providers. Last model request stays visible.", button: "Reset counts")
      }
      if [.recover, .fullRefresh, .certify, .usageReset].contains(action) && !confirmed {
        operationNotice = "The action was cancelled."
      } else {
        do {
          let result = action == .updateCheck ? try await client.checkUpdatesFromBundledBackend() :
            try await client.run(action, confirmed: confirmed, previewToken: action == .usageReset ? nil : preview?.previewToken)
          if result.ok {
            if action == .usageReset && result.usageReset == nil { throw CompanionFailure.incompatibleProtocol }
            if let returnedPreview = result.preview { preview = returnedPreview }
            if let returnedUpdate = result.update { update = returnedUpdate }
            operationNotice = resultMessage(result, action: action)
          } else {
            operationFailed = true
            operationNotice = CompanionPresentation.actionFailureMessage(for: action, code: result.code)
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

  func removeCompletely() {
    guard canRemove, removal.beginReview() else { return }
    polling?.cancel()
    polling = nil
    refreshQueued = false
    busy = .uninstall
    operationNotice = nil
    operationNoticeAction = .uninstall
    operationStartedAt = Date()
    Task {
      let lease = await operationQueue.acquire(.action)
      await removal.remove(client: client,
        confirm: { review in
          await self.confirmation(title: review.title, text: review.text, button: review.button)
        },
        unregisterLogin: {
          defer { self.loginEnabled = SMAppService.mainApp.status == .enabled }
          try await unregisterCompanionLoginStartup(
            status: { CompanionLoginStartupStatus(SMAppService.mainApp.status) },
            unregister: { try await SMAppService.mainApp.unregister() })
        }, cleanup: { try await self.cleanAppSettings() })
      busy = nil
      operationStartedAt = nil
      preview = nil
      operationFailed = { if case .failed = removalState { return true }; return false }()
      if removalState.backendRemoved {
        snapshot = nil
        statusFailure = nil
        statusCheckNotice = nil
      } else {
        operationNotice = removalState.notice ?? "Removal was cancelled. Nothing was removed."
      }
      operationQueue.release(lease)
      if activityAllowed { startPolling() }
    }
  }

  func retryAppCleanup() {
    guard busy == nil, removalState == .cleanupRequired else { return }
    busy = .uninstall
    Task {
      let lease = await operationQueue.acquire(.action)
      await removal.retryCleanup { try await self.cleanAppSettings() }
      busy = nil
      operationQueue.release(lease)
    }
  }

  private func cleanAppSettings() async throws {
    refreshOnClose = false
    notificationsEnabled = false
    clearCompanionPreferences(.standard)
    let center = UNUserNotificationCenter.current()
    center.removePendingNotificationRequests(withIdentifiers: companionOwnedNotificationIdentifiers)
    center.removeDeliveredNotifications(withIdentifiers: companionOwnedNotificationIdentifiers)
  }

  func showAppInFinder() {
    NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
  }

  func setLoginEnabled(_ enabled: Bool) {
    guard activityAllowed else { return }
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

  func showConfig() {
    if configWindow == nil {
      configWindow = makeWindow(title: CompanionPresentation.configWindowTitle,
        content: CompanionConfig(controller: self))
    }
    presentWindow(configWindow!)
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
    guard activityAllowed else { return }
    let generation = removal.generation
    if !enabled {
      notificationsEnabled = false
      UserDefaults.standard.set(false, forKey: "statusNotifications")
      return
    }
    Task {
      let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert])) ?? false
      guard removal.permitsActivity(generation) else { return }
      notificationsEnabled = granted
      UserDefaults.standard.set(granted, forKey: "statusNotifications")
      if !granted { message = "Enable PickerMux notifications in System Settings to receive recovery notices." }
    }
  }

  private func notifyIfActionable(_ snapshot: CompanionSnapshot, recoveryCompleted: Bool) async {
    guard activityAllowed else { return }
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
    companionActionResultMessage(result, action: action)
  }

  private func failureMessage(_ error: Error) -> String {
    (error as? CompanionFailure)?.message ?? "PickerMux could not complete the request. Review its status."
  }

}

private enum CompanionTypography {
  static let body = Font.system(size: 14)
  static let label = Font.system(size: 14, weight: .semibold)
  static let progress = Font.system(size: 13)
  static let metadata = Font.system(size: 12)
}

enum CompanionPresentation {
  struct ActionAvailability: Equatable {
    let isEnabled: Bool
    let disabledReason: String?
  }

  static let configButtonTitle = "Config…"
  static let configWindowTitle = "PickerMux Config"
  static let configHeading = "PickerMux Config"
  static let outputSpeedLabel = "Output speed"
  static let outputSpeedHelp = "Model output speed for the last completed request. It excludes prompt processing and network transfer time, and resets when the bridge restarts."
  static let providerSetupButtonTitle = "Enable LM Studio models…"
  static let nativeOnlyMenuNotice = "No external models configured"
  static let nativeOnlyModelsGuidance = "The PickerMux menu shows configured providers. Models appear in the Codex model picker after setup and reopening Codex."
  static let integrationToggleTitle = "Use PickerMux in Codex"
  static let menuPrimaryHeadings = [integrationToggleTitle]

  static func compactIntegrationGuidance(for state: IntegrationToggleState,
                                         busy: CompanionAction? = nil) -> String? {
    if busy == nil, state.isEnabled, state.needsSetupUpgrade, state.label == "Enabled in Codex" {
      return nil
    }
    return state.guidance
  }

  static func mainActions(available: [CompanionAction]) -> [CompanionAction] {
    [.refresh, .open, .certify, .recover].filter(available.contains)
  }

  static func configActions(available: [CompanionAction]) -> [CompanionAction] {
    [.diagnose].filter(available.contains) + [.fullRefresh]
  }

  static func configActionAvailability(for action: CompanionAction, snapshot: CompanionSnapshot?, appVersion: String,
                                       activityAllowed: Bool = true, busy: CompanionAction? = nil) -> ActionAvailability {
    guard let snapshot else {
      return ActionAvailability(isEnabled: false,
        disabledReason: actionUnavailableWithoutStatus(action))
    }
    if action == .fullRefresh && snapshot.providerConfiguration?.status == .nativeOnly {
      return ActionAvailability(isEnabled: false,
        disabledReason: "Full refresh preserves provider configuration; enable LM Studio models first.")
    }
    if !snapshot.actions.contains(action) {
      return ActionAvailability(isEnabled: false,
        disabledReason: unattestedActionReason(action, snapshot: snapshot, appVersion: appVersion))
    }
    guard activityAllowed else {
      return ActionAvailability(isEnabled: false,
        disabledReason: "This action is unavailable while PickerMux removal is in progress.")
    }
    guard busy == nil else {
      return ActionAvailability(isEnabled: false, disabledReason: busy == action ? nil :
        "Wait for the current PickerMux operation to finish before starting this action.")
    }
    return ActionAvailability(isEnabled: true, disabledReason: nil)
  }

  static func bundledSetupAvailability(snapshot: CompanionSnapshot?, activityAllowed: Bool = true,
                                       busy: CompanionAction? = nil) -> ActionAvailability {
    guard let snapshot else {
      return ActionAvailability(isEnabled: false,
        disabledReason: "PickerMux setup is unavailable until the app can read a verified status.")
    }
    let state = IntegrationToggleState(snapshot: snapshot)
    guard snapshot.usesBundledBackend, state.needsSetupUpgrade else {
      return ActionAvailability(isEnabled: false,
        disabledReason: "The installed PickerMux backend does not require this setup step.")
    }
    guard activityAllowed else {
      return ActionAvailability(isEnabled: false,
        disabledReason: "PickerMux setup is unavailable while removal is in progress.")
    }
    guard busy == nil else {
      return ActionAvailability(isEnabled: false,
        disabledReason: "Wait for the current PickerMux operation to finish before completing setup.")
    }
    if ["running", "open"].contains(snapshot.desktop.status) {
      return ActionAvailability(isEnabled: false,
        disabledReason: "Fully quit Codex with Command-Q before completing the installed PickerMux setup.")
    }
    if !["idle", "completed"].contains(snapshot.recovery.status) {
      return ActionAvailability(isEnabled: false,
        disabledReason: "Complete the pending repair before completing the installed PickerMux setup.")
    }
    if !["ready", "valid"].contains(snapshot.accountCache.status) {
      return ActionAvailability(isEnabled: false,
        disabledReason: "Open Codex while signed in and wait for its native model picker, then fully quit Codex and check status again.")
    }
    guard state.canReviewSetup else {
      return ActionAvailability(isEnabled: false,
        disabledReason: "PickerMux cannot safely complete setup in the current verified installation state. Review Installation details or open Help.")
    }
    return ActionAvailability(isEnabled: true, disabledReason: nil)
  }

  static func providerSetupAvailability(snapshot: CompanionSnapshot?, appVersion: String,
                                        activityAllowed: Bool = true, busy: CompanionAction? = nil) -> ActionAvailability {
    guard let snapshot else {
      return ActionAvailability(isEnabled: false,
        disabledReason: "LM Studio model setup is unavailable until PickerMux can read a verified status. Check status above or open Help.")
    }
    guard let provider = snapshot.providerConfiguration else {
      return ActionAvailability(isEnabled: false,
        disabledReason: snapshot.usesBundledBackend ?
          "LM Studio model setup requires a verified installed backend. Complete or update the installed backend first." :
          "Update the installed PickerMux backend before enabling LM Studio models.")
    }
    switch provider.status {
    case .external:
      return ActionAvailability(isEnabled: false,
        disabledReason: "External provider configuration is already installed. PickerMux will not replace it.")
    case .notInstalled:
      return ActionAvailability(isEnabled: false,
        disabledReason: "Install and enable PickerMux before configuring LM Studio models.")
    case .unknown:
      return ActionAvailability(isEnabled: false,
        disabledReason: "PickerMux could not verify the provider configuration. Review Installation details or update the installed backend.")
    case .nativeOnly:
      break
    }
    guard !snapshot.usesBundledBackend else {
      return ActionAvailability(isEnabled: false,
        disabledReason: "LM Studio model setup requires a verified installed backend. Complete or update the installed backend first.")
    }
    guard snapshot.supportsNativeOnlyLMStudioSetup else {
      return ActionAvailability(isEnabled: false,
        disabledReason: "Update the installed PickerMux backend before enabling LM Studio models.")
    }
    guard snapshot.actions.contains(.lmStudioDefaultPreview), snapshot.actions.contains(.lmStudioDefaultApply) else {
      if ["running", "open"].contains(snapshot.desktop.status) {
        return ActionAvailability(isEnabled: false,
          disabledReason: "Fully quit Codex with Command-Q before enabling LM Studio models.")
      }
      if companionBackendUpgradeAvailable(appVersion: appVersion, snapshot: snapshot) {
        return ActionAvailability(isEnabled: false,
          disabledReason: "Update the installed backend in Config before enabling LM Studio models.")
      }
      return ActionAvailability(isEnabled: false,
        disabledReason: "LM Studio model setup is unavailable in the current verified state. Review Installation details and retry status.")
    }
    guard activityAllowed else {
      return ActionAvailability(isEnabled: false,
        disabledReason: "LM Studio model setup is unavailable while PickerMux removal is in progress.")
    }
    guard busy == nil else {
      return ActionAvailability(isEnabled: false, disabledReason:
        "Wait for the current PickerMux operation to finish before configuring models.")
    }
    return ActionAvailability(isEnabled: true, disabledReason: nil)
  }

  static func compactProviderNotice(for snapshot: CompanionSnapshot?) -> String? {
    snapshot?.providerConfiguration?.status == .nativeOnly ? nativeOnlyMenuNotice : nil
  }

  static func outputSpeed(for provider: ProviderTokenUsage, in snapshot: CompanionSnapshot) -> Double? {
    guard snapshot.supportsTokenPerformance else { return nil }
    return snapshot.tokenPerformance?.outputTokensPerSecond(for: provider)
  }

  static func progressTitle(for action: CompanionAction) -> String {
    action.label.hasSuffix("…") ? action.label : "\(action.label)…"
  }

  static func showsMainFeedback(for action: CompanionAction?) -> Bool {
    guard let action else { return true }
    return ![.updateCheck, .update, .diagnose, .fullRefresh, .usageReset,
      .lmStudioDefaultPreview, .lmStudioDefaultApply].contains(action)
  }

  static func actionFailureMessage(for action: CompanionAction, code: String) -> String {
    if action == .diagnose {
      return "Installation checks found problems. Review Installation details below and open Help for the relevant recovery guidance."
    }
    return companionActionFailureMessage(code)
  }

  static func providerSetupFailureMessage(_ code: String) -> String {
    if ["PREVIEW_STALE", "CONFIGURATION_CONFLICT"].contains(code) {
      return "The reviewed model setup changed. Check status in Config, then choose Enable LM Studio models again."
    }
    return companionActionFailureMessage(code)
  }

  static func visibleTokenProviders(_ providers: [ProviderTokenUsage]) -> [ProviderTokenUsage] {
    providers.filter { $0.providerId != "kolibri" }
  }

  private static func actionUnavailableWithoutStatus(_ action: CompanionAction) -> String {
    switch action {
    case .fullRefresh:
      return "Full refresh is unavailable until PickerMux can read a verified status. Check status above or open Help."
    case .usageReset:
      return "Saved counts cannot be reset until PickerMux can read a verified status. Check status above or open Help."
    default:
      return "This action is unavailable until PickerMux can read a verified status."
    }
  }

  private static func unattestedActionReason(_ action: CompanionAction, snapshot: CompanionSnapshot,
                                             appVersion: String) -> String {
    if snapshot.usesBundledBackend {
      switch action {
      case .fullRefresh:
        return "Full refresh requires a verified installed backend. Complete or update the installed backend first."
      case .usageReset:
        return "Resetting saved counts requires a verified installed backend. Complete or update the installed backend first."
      default:
        return "This action requires a verified installed backend."
      }
    }
    switch action {
    case .fullRefresh:
      if companionBackendUpgradeAvailable(appVersion: appVersion, snapshot: snapshot) {
        return "Update the installed backend in Config before running Full refresh."
      }
      return "Full refresh is unavailable in the current verified installation state. Review Installation details and use any offered repair."
    case .usageReset:
      if !snapshot.supportsTokenUsageReset || snapshot.tokenUsage?.isPersistent != true {
        return "Update the installed backend in Config before resetting accumulated counts."
      }
      return "Saved counts cannot be reset in the current verified installation state. Review Installation details or open Help."
    default:
      return "This action was not offered by the verified installed backend."
    }
  }

  static func configStatusFailureGuidance(_ failure: CompanionFailure?) -> String {
    guard let failure else {
      return "PickerMux could not read a verified status. Open Help to review the installation before retrying."
    }
    switch failure {
    case .missingLauncher:
      return "The PickerMux CLI is not installed or could not be found. Open Help for installation guidance."
    case .missingNode:
      return "Node.js 22.15 or newer was not found at a supported location. Open Help for runtime setup."
    case .unsafeNode:
      return "The installed Node.js runtime could not be trusted. Open Help to review its installation."
    case .unsafeLauncher:
      return "PickerMux could not verify CLI ownership. Open Help to review the installed CLI."
    case .timeout:
      return "The installed command did not finish in time. Wait for any active operation, then retry or open Help."
    case .outputLimit:
      return "The installed command returned an unsupported amount of data. Open Help to review the CLI installation."
    case .processFailed:
      return "The installed command failed. Open Help to review the CLI installation and Node.js runtime."
    case .incompatibleProtocol:
      return "The app and installed CLI use incompatible control protocols. Install matching PickerMux versions."
    }
  }

  static func statusIssueGuidance(for code: String) -> String {
    let guidance = [
      "metadata-unavailable": "PickerMux could not verify the installed backend version. Review the CLI installation in Help.",
      "desktop-unavailable": "PickerMux could not determine whether Codex is running. Fully quit Codex with Command-Q before retrying.",
      "installation-unavailable": "PickerMux could not verify the installed distribution. Review the CLI installation in Help.",
      "managedConfig-unavailable": "PickerMux could not verify its managed Codex configuration. Keep Codex closed and review troubleshooting in Help.",
      "service-unavailable": "PickerMux could not verify the bridge service. Review the CLI installation and Node.js runtime in Help.",
      "compatibility-unavailable": "PickerMux could not verify Codex compatibility. Fully quit Codex and review recovery guidance in Help.",
      "accountCache-unavailable": "PickerMux could not verify the Codex account cache. Open Codex while signed in, wait for its native picker, then fully quit it.",
      "recovery-unavailable": "PickerMux could not verify recovery state. Keep Codex closed and review troubleshooting in Help before another change.",
      "integration-unavailable": "PickerMux could not verify the active model-picker integration. Keep Codex closed and review troubleshooting in Help.",
      "providerConfiguration-unavailable": "PickerMux could not verify the installed provider configuration. Review the CLI installation in Help before changing models.",
      "configuration-conflict": "PickerMux detected Codex configuration changes it does not own. Keep Codex closed and review the configuration-conflict guidance in Help.",
      "update-required": "Codex changed. Fully quit Codex, then use the offered repair. Full refresh becomes available again after the installation is ready.",
      "account-cache-refresh-required": "Open Codex while signed in, wait for its native model picker, fully quit Codex, then use the offered repair.",
      "recovery-pending": "An earlier full refresh or repair is incomplete. Keep Codex closed and use the offered resume or repair action.",
    ]
    return guidance[code] ??
      "The installation reported an issue this app version does not recognize. Update PickerMux or review Help."
  }
}

private enum MenuTypography {
  static let body = Font.system(size: 13)
  static let label = Font.system(size: 13)
  static let progress = Font.system(size: 11)
  static let metadata = Font.system(size: 11)
}

enum CompanionMenuDividerPlacement: CaseIterable, Equatable {
  case footerBoundary
}

private struct CompanionMenuDivider: View {
  let placement: CompanionMenuDividerPlacement

  var body: some View {
    switch placement {
    case .footerBoundary: Divider()
    }
  }
}

private struct MenuRowButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    MenuRowLabel(label: configuration.label, isPressed: configuration.isPressed)
  }
}

private struct MenuRowLabel<Label: View>: View {
  let label: Label
  let isPressed: Bool
  @Environment(\.isEnabled) private var isEnabled
  @State private var isHovered = false

  var body: some View {
    let highlighted = isEnabled && (isHovered || isPressed)
    label
      .font(MenuTypography.body)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 14)
      .padding(.vertical, 4)
      .contentShape(Rectangle())
      .background(highlighted ? Color.accentColor : .clear)
      .foregroundStyle(highlighted ? Color.white : Color.primary)
      .opacity(isEnabled ? 1 : 0.45)
      .onHover { isHovered = $0 }
  }
}

struct CompanionPanel: View {
  @ObservedObject var controller: CompanionController

  var body: some View {
    CompanionMenuViewport {
      content
    } footer: {
      if !controller.removalState.backendRemoved {
        VStack(spacing: 0) {
          CompanionMenuDivider(placement: .footerBoundary)
          Button(CompanionPresentation.configButtonTitle) { controller.showConfig() }
          Button("Help…") { controller.showHelp() }
          Button("Quit") { NSApp.terminate(nil) }
        }
        .buttonStyle(MenuRowButtonStyle())
        .padding(.vertical, 4)
      }
    }
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 0) {
      if controller.removalState.backendRemoved {
        RemovalCompletionView(controller: controller)
          .padding(14)
      } else {
        VStack(alignment: .leading, spacing: 4) {
          HStack {
            ForEach(CompanionPresentation.menuPrimaryHeadings, id: \.self) { heading in
              Text(heading).font(MenuTypography.label)
            }
            Spacer()
            Toggle(CompanionPresentation.integrationToggleTitle, isOn: Binding(
              get: { controller.integrationState.isEnabled },
              set: { controller.setIntegrationEnabled($0) }))
              .labelsHidden()
              .toggleStyle(.switch)
              .controlSize(.small)
              .disabled(!controller.integrationState.canChange)
              .accessibilityHint(CompanionPresentation.compactIntegrationGuidance(
                for: controller.integrationState, busy: controller.busy) ?? "Manage setup and updates in Config.")
          }
          Text(controller.integrationLabel)
            .font(MenuTypography.label.weight(.semibold))
          if let guidance = CompanionPresentation.compactIntegrationGuidance(
            for: controller.integrationState, busy: controller.busy) {
            Text(guidance)
              .font(MenuTypography.metadata).foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 8)
        if controller.backendUpgradeAvailable {
          VStack(alignment: .leading, spacing: 4) {
            Text("Backend update available").font(MenuTypography.body.weight(.semibold))
            Text("App \(controller.appVersion) · Backend \(controller.snapshot?.version ?? "unavailable")")
              .font(MenuTypography.metadata).foregroundStyle(.secondary)
            Text(["running", "open"].contains(controller.snapshot?.desktop.status ?? "") ?
              "Fully quit Codex to review the update. You can also start it from Config." :
              "Review this app's backend update in Config.")
              .font(MenuTypography.metadata).foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
            Button("Open Config…") { controller.showConfig() }
              .disabled(!controller.activityAllowed || controller.busy != nil)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 6)
        }
        if let notice = CompanionPresentation.compactProviderNotice(for: controller.snapshot) {
          VStack(alignment: .leading, spacing: 4) {
            Text(notice).font(MenuTypography.body.weight(.semibold))
            Text("Open Config to enable LM Studio models in the Codex model picker.")
              .font(MenuTypography.metadata).foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
            Button("Open Config…") { controller.showConfig() }
              .disabled(!controller.activityAllowed || controller.busy != nil)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 6)
        }
        if let snapshot = controller.snapshot {
          TokenUsageView(snapshot: snapshot)
            .padding(.horizontal, 14)
            .padding(.top, 6)
            .padding(.bottom, 10)
        }
        ForEach(CompanionPresentation.mainActions(available: controller.snapshot?.actions ?? [])
          .filter { [.refresh, .open].contains($0) }, id: \.self) { action in
          actionButton(action)
        }
        if feedbackVisible {
          VStack(alignment: .leading, spacing: 3) {
            if controller.busy != nil && CompanionPresentation.showsMainFeedback(for: controller.busy) {
              OperationProgress(controller: controller, compact: true)
            } else if let notice = controller.operationNotice,
                      CompanionPresentation.showsMainFeedback(for: controller.operationNoticeAction) {
              Text(controller.lastSetupFailed ? "Last setup attempt: \(notice)" : notice)
                .foregroundStyle(controller.operationFailed ? .red : .primary)
                .fixedSize(horizontal: false, vertical: true)
              if controller.lastSetupFailed {
                Text(controller.backendUpgradeAvailable ?
                  "After fixing the cause, retry Update installed backend in Config." :
                  "After fixing the cause, turn the switch on again. Check status in Config does not retry setup.")
                  .fixedSize(horizontal: false, vertical: true)
              }
            } else if controller.snapshot == nil {
              Text(controller.message).fixedSize(horizontal: false, vertical: true)
            }
            if controller.refreshQueued {
              Text("Refresh queued until Codex fully quits.").foregroundStyle(.secondary)
            }
          }
          .font(MenuTypography.metadata)
          .padding(.horizontal, 14)
          .padding(.bottom, 6)
        }
        let maintenance = CompanionPresentation.mainActions(available: controller.snapshot?.actions ?? [])
          .filter { [.certify, .recover].contains($0) }
        if !maintenance.isEmpty {
          DisclosureGroup("More actions") {
            VStack(alignment: .leading, spacing: 0) {
              ForEach(maintenance, id: \.self) { action in actionButton(action) }
            }
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 4)
        }
      }
    }
    .font(MenuTypography.body)
    .buttonStyle(MenuRowButtonStyle())
    .controlSize(.small)
    .padding(.bottom, 4)
  }

  private var feedbackVisible: Bool {
    (controller.busy != nil && CompanionPresentation.showsMainFeedback(for: controller.busy)) ||
      controller.snapshot == nil || controller.refreshQueued ||
      (controller.operationNotice != nil && CompanionPresentation.showsMainFeedback(for: controller.operationNoticeAction))
  }

  private func actionButton(_ action: CompanionAction) -> some View {
    Button(action == .refresh && controller.refreshQueued ? "Cancel queued refresh" : action.label) {
      controller.perform(action)
    }
    .disabled(!controller.canRun(action))
  }

}

struct TokenUsageView: View {
  let snapshot: CompanionSnapshot

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Token usage").font(MenuTypography.metadata).foregroundStyle(.secondary)
      if let usage = snapshot.tokenUsage {
        let visibleProviders = CompanionPresentation.visibleTokenProviders(usage.providers)
        if usage.status == .unavailable {
          Text("Token usage is unavailable. Check the bridge status.")
            .font(MenuTypography.metadata).foregroundStyle(.secondary)
        } else if visibleProviders.isEmpty {
          Text("No model requests yet.")
            .font(MenuTypography.metadata).foregroundStyle(.secondary)
        } else {
          ForEach(visibleProviders) { provider in
            VStack(alignment: .leading, spacing: 6) {
              Text(provider.providerId == "lmstudio" ? "LM Studio" : provider.providerId)
                .font(MenuTypography.label)
                .lineLimit(1).truncationMode(.middle)
              tokenSummary("Last model request", counts: provider.last.counts)
              if let rate = CompanionPresentation.outputSpeed(for: provider, in: snapshot) {
                outputSpeed(rate)
              }
              tokenSummary(usage.isPersistent ? "Since reset" : "Since bridge start", counts: provider.displayTotals)
              if let note = provider.missingUsageMessage {
                Text(note).font(MenuTypography.metadata).foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
              if provider.totals == nil && provider.requests > provider.unavailableRequests {
                Text("The accumulated counts exceeded the supported limit and are unavailable.")
                  .font(MenuTypography.metadata).foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
            .padding(.top, provider.id == visibleProviders.first?.id ? 0 : 6)
          }
        }
        Text(usage.isPersistent ? "Saved across restarts. Reset in Config." : "Counts reset when the bridge restarts.")
          .font(MenuTypography.metadata).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        Text("Token usage is unavailable. Update the installed PickerMux backend to enable it.")
          .font(MenuTypography.metadata).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func tokenSummary(_ title: String, counts: TokenUsageCounts?) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title).font(MenuTypography.metadata).foregroundStyle(.secondary)
      tokenRow("Input", counts?.inputTokens)
      tokenRow("Output", counts?.outputTokens)
      tokenRow("Total", counts?.totalTokens).fontWeight(.semibold)
    }
  }

  private func outputSpeed(_ rate: Double) -> some View {
    HStack {
      Text(CompanionPresentation.outputSpeedLabel).foregroundStyle(.secondary)
      Spacer(minLength: 16)
      Text("\(rate.formatted(.number.precision(.fractionLength(1)))) tokens/s")
        .monospacedDigit()
        .lineLimit(1).minimumScaleFactor(0.8)
    }
    .font(Font.system(size: 12))
    .help(CompanionPresentation.outputSpeedHelp)
  }

  private func tokenRow(_ label: String, _ count: Int?) -> some View {
    HStack {
      Text(label).foregroundStyle(label == "Total" ? .primary : .secondary)
      Spacer(minLength: 16)
      tokenCount(count)
    }
    .font(Font.system(size: 12))
  }

  private func tokenCount(_ count: Int?) -> some View {
    Text(count.map { $0.formatted(.number) } ?? "Unavailable")
      .monospacedDigit()
      .lineLimit(1).minimumScaleFactor(0.8)
  }
}

private struct OperationProgress: View {
  @ObservedObject var controller: CompanionController
  var compact = false

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      ProgressView().controlSize(.small)
      VStack(alignment: .leading, spacing: 3) {
        Text(controller.message).font(compact ? MenuTypography.metadata : CompanionTypography.body)
          .fixedSize(horizontal: false, vertical: true)
        if let started = controller.operationStartedAt {
          TimelineView(.periodic(from: started, by: 1)) { context in
            let elapsed = max(0, Int(context.date.timeIntervalSince(started)))
            Text("Running \(elapsed / 60)m \(elapsed % 60)s" +
              ([.configurationApply, .lmStudioDefaultApply, .certify].contains(controller.busy) ? " · setup and certification may take several minutes." : "."))
              .font(compact ? MenuTypography.progress : CompanionTypography.progress).foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
  }
}

private struct CompanionConfig: View {
  @ObservedObject var controller: CompanionController

  var body: some View {
    CompanionConfigViewport(height: controller.removalState.backendRemoved ? 360 : 640) {
      VStack(alignment: .leading, spacing: 16) {
        Text(CompanionPresentation.configHeading).font(.title2.weight(.semibold))
        if controller.removalState.backendRemoved {
          RemovalCompletionView(controller: controller)
        } else {
          GroupBox("Installation") {
            VStack(alignment: .leading, spacing: 10) {
              let fullRefreshAvailability = controller.configAvailability(for: .fullRefresh)
              HStack {
                Button(controller.isCheckingStatus ? "Checking status…" : "Check status") {
                  Task { await controller.refreshStatus(manual: true) }
                }
                .disabled(controller.isCheckingStatus || !controller.activityAllowed)
                ForEach(CompanionPresentation.configActions(available: controller.snapshot?.actions ?? []), id: \.self) { action in
                  Button(configActionTitle(action)) { controller.perform(action) }
                    .disabled(action == .fullRefresh ? !fullRefreshAvailability.isEnabled : !controller.canRun(action))
                }
              }
              if let reason = fullRefreshAvailability.disabledReason {
                Text(reason).font(CompanionTypography.progress).foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
              if let failure = controller.statusFailure {
                Text("Status check failed. \(CompanionPresentation.configStatusFailureGuidance(failure))")
                  .font(CompanionTypography.progress).foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              } else if let notice = controller.statusCheckNotice {
                Text(notice).font(CompanionTypography.progress).foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              } else if let checked = controller.lastStatusCheck {
                Text("Last status check: \(checked.formatted(date: .omitted, time: .standard))")
                  .font(CompanionTypography.metadata).foregroundStyle(.secondary)
              }
              if controller.busy == .diagnose || controller.busy == .fullRefresh {
                OperationProgress(controller: controller)
              }
              if let notice = controller.operationNotice,
                 controller.operationNoticeAction == .diagnose || controller.operationNoticeAction == .fullRefresh {
                Text(notice).foregroundStyle(controller.operationFailed ? .red : .primary)
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
                    ForEach(Array(snapshot.issues.enumerated()), id: \.offset) { indexedIssue in
                      Text(CompanionPresentation.statusIssueGuidance(for: indexedIssue.element.code))
                        .font(CompanionTypography.body).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                  }
                }
              } else {
                Text("Installation details are unavailable. Open Help to review the installation before retrying.")
                  .font(CompanionTypography.body).foregroundStyle(.secondary)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          GroupBox("Models") {
            VStack(alignment: .leading, spacing: 8) {
              let providerStatus = controller.snapshot?.providerConfiguration?.status
              let setupAvailability = CompanionPresentation.providerSetupAvailability(
                snapshot: controller.snapshot, appVersion: controller.appVersion,
                activityAllowed: controller.activityAllowed, busy: controller.busy)
              if providerStatus == .nativeOnly {
                Text(CompanionPresentation.nativeOnlyModelsGuidance)
                  .fixedSize(horizontal: false, vertical: true)
              } else if providerStatus == .external {
                Text("External provider configuration is already installed. PickerMux will not replace it. Models remain available in the Codex model picker.")
                  .fixedSize(horizontal: false, vertical: true)
              } else {
                Text("Models appear in the Codex model picker after PickerMux verifies an installed provider configuration.")
                  .fixedSize(horizontal: false, vertical: true)
              }
              if providerStatus != .external {
                Button(controller.busy == .lmStudioDefaultPreview ? "Reviewing LM Studio setup…" :
                  controller.busy == .lmStudioDefaultApply ? "Enabling LM Studio models…" :
                  CompanionPresentation.providerSetupButtonTitle) {
                    controller.enableLMStudioModels()
                  }
                  .disabled(!setupAvailability.isEnabled)
              }
              if providerStatus != .external, let reason = setupAvailability.disabledReason {
                Text(reason).font(CompanionTypography.progress).foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
              if controller.busy.map({ [.lmStudioDefaultPreview, .lmStudioDefaultApply].contains($0) }) == true {
                OperationProgress(controller: controller)
              }
              if let notice = controller.operationNotice,
                 controller.operationNoticeAction.map({ [.lmStudioDefaultPreview, .lmStudioDefaultApply].contains($0) }) == true {
                Text(notice).foregroundStyle(controller.operationFailed ? .red : .primary)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          GroupBox("Token usage") {
            VStack(alignment: .leading, spacing: 8) {
              let resetAvailability = controller.configAvailability(for: .usageReset)
              Text(controller.snapshot?.tokenUsage?.isPersistent == true ?
                "Accumulated counts are saved across app and bridge restarts." :
                "Update the installed PickerMux backend to save totals across restarts and reset them here.")
                .fixedSize(horizontal: false, vertical: true)
              Button(controller.busy == .usageReset ? "Resetting counts…" : "Reset accumulated counts…") {
                controller.perform(.usageReset)
              }
              .disabled(!resetAvailability.isEnabled)
              if let reason = resetAvailability.disabledReason {
                Text(reason).font(CompanionTypography.progress).foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              }
              if let reset = controller.snapshot?.tokenUsage?.resetDate {
                Text("Last reset: \(reset.formatted(date: .numeric, time: .shortened))")
                  .font(CompanionTypography.metadata).foregroundStyle(.secondary)
              } else if controller.snapshot?.tokenUsage?.isPersistent == true {
                Text("Last reset: Never").font(CompanionTypography.metadata).foregroundStyle(.secondary)
              }
              Text("Resets totals for all providers. Last model request stays visible.")
                .font(CompanionTypography.metadata).foregroundStyle(.secondary)
              if controller.busy == .usageReset { OperationProgress(controller: controller) }
              if let notice = controller.operationNotice, controller.operationNoticeAction == .usageReset {
                Text(notice).foregroundStyle(controller.operationFailed ? .red : .primary)
                  .fixedSize(horizontal: false, vertical: true)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          GroupBox("Updates") {
            VStack(alignment: .leading, spacing: 8) {
              Text("App \(controller.appVersion) · Backend \(controller.snapshot?.version ?? "unavailable")")
                .font(CompanionTypography.metadata).foregroundStyle(.secondary)
              if let update = controller.update {
                Text(update.status == "available" ? "PickerMux \(update.targetVersion ?? "update") is available." : "Update status: \(statusLabel(update.status))")
                  .font(CompanionTypography.body)
              }
              HStack {
                Button(controller.busy == .updateCheck ? "Checking updates…" : "Check for updates") { controller.perform(.updateCheck) }
                  .disabled(!controller.canRun(.updateCheck))
                if let url = controller.diskImageDownloadURL {
                  Link("Download DMG…", destination: url)
                    .disabled(!controller.activityAllowed || controller.busy != nil)
                }
              }
              if controller.backendUpgradeAvailable {
                Button(controller.busy == .configurationApply ? "Updating installed backend…" : "Update installed backend…") {
                  controller.setIntegrationEnabled(true, reviewInstalledSetup: true)
                }
                .disabled(!controller.canReviewBackendUpgrade)
                Text("Use this app's bundled version to update the installed CLI and bridge. Provider settings are retained. This also enables PickerMux if it is off and may send live certification prompts. Fully quit Codex before reviewing the upgrade.")
                  .font(CompanionTypography.body).foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
              } else if controller.snapshot?.usesBundledBackend == true && controller.integrationState.needsSetupUpgrade {
                let setupAvailability = controller.bundledSetupAvailability
                Button(controller.busy == .configurationApply ? "Completing PickerMux setup…" : "Complete PickerMux setup…") {
                  controller.setIntegrationEnabled(true, reviewInstalledSetup: true)
                }
                .disabled(!setupAvailability.isEnabled)
                Text("Finish installing this app's verified bundled CLI and bridge. Existing provider settings are retained, and setup may send live certification prompts.")
                  .font(CompanionTypography.body).foregroundStyle(.secondary)
                  .fixedSize(horizontal: false, vertical: true)
                if let reason = setupAvailability.disabledReason {
                  Text(reason).font(CompanionTypography.progress).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
              }
              if let notice = controller.operationNotice,
                 controller.operationNoticeAction == .updateCheck || controller.operationNoticeAction == .update || controller.operationNoticeAction == .configurationApply {
                Text(notice).font(CompanionTypography.body)
                  .foregroundStyle(.primary)
                  .fixedSize(horizontal: false, vertical: true)
              }
              Text("App updates are distributed as a DMG. Quit PickerMux before replacing the app, then reopen it. With PickerMux enabled and Codex fully closed, the app offers its newer backend automatically. One confirmation starts the update. Cancelling leaves the current backend in place; you can retry here.")
                .font(CompanionTypography.body).foregroundStyle(.secondary)
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
          .disabled(!controller.activityAllowed)
          Text("Status is checked every five seconds. Automatic refresh is off by default and runs after Codex fully closes. Updates, additional certification and recovery require explicit confirmation.")
            .font(CompanionTypography.body).foregroundStyle(.secondary)
          GroupBox("Remove PickerMux") {
            VStack(alignment: .leading, spacing: 10) {
              Text("Turning the Codex switch off is reversible. Fully quit and reopen Codex to load its native picker. Complete removal also deletes PickerMux's CLI, managed data, verified backups and registered provider credentials.")
                .fixedSize(horizontal: false, vertical: true)
              Button(controller.busy == .uninstall ? "Removing PickerMux…" : "Remove PickerMux completely…", role: .destructive) { controller.removeCompletely() }
                .disabled(!controller.canRemove)
              if controller.busy == .uninstall { OperationProgress(controller: controller) }
              if let notice = controller.removalState.notice {
                Text(notice).fixedSize(horizontal: false, vertical: true)
              } else if !controller.canRemove {
                Text(controller.busy != nil ? "Wait for the current operation to finish before removal." :
                  CompanionRemovalCoordinator.availability(controller.snapshot).notice ?? "Check status in Config before removal.")
                  .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        Text("PickerMux is an unofficial community project, unaffiliated with OpenAI, Codex or LM Studio.")
          .font(CompanionTypography.body).foregroundStyle(.secondary)
      }
      .font(CompanionTypography.body)
      .controlSize(.regular)
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func configActionTitle(_ action: CompanionAction) -> String {
    if controller.busy == action {
      return action == .diagnose ? "Checking installation…" : "Starting full refresh…"
    }
    return action.label
  }

  private func statusRow(_ label: String, _ status: String) -> some View {
    HStack {
      Text(label).foregroundStyle(.secondary)
      Spacer()
      Text(statusLabel(status))
    }
    .font(CompanionTypography.body)
  }
}

private struct RemovalCompletionView: View {
  @ObservedObject var controller: CompanionController

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(controller.removalState == .removed ? "PickerMux removed" : "App cleanup needs attention")
        .font(CompanionTypography.label)
      Text(controller.removalState.notice ?? "").fixedSize(horizontal: false, vertical: true)
      if controller.removalState == .cleanupRequired {
        Button("Retry app cleanup") { controller.retryAppCleanup() }.disabled(controller.busy != nil)
      }
      HStack {
        Button("Show app in Finder") { controller.showAppInFinder() }
        Button("Quit PickerMux") { NSApp.terminate(nil) }
      }
      Text("The inactive compatibility alias in Codex configuration supports old chats without a running PickerMux service. The app is ready to remove from this Mac after cleanup.")
        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
    .font(CompanionTypography.body)
  }
}

private struct CompanionHelp: View {
  @ObservedObject var controller: CompanionController

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("PickerMux setup and help").font(.title2.weight(.semibold))
      if let failure = controller.statusFailure {
        Text(failure.message).font(CompanionTypography.body)
      }
      Text("PickerMux adds models from configured providers using the OpenAI Responses API alongside native Codex models. Turn on Use PickerMux in Codex to install and activate automatically. Turn it off, then fully quit and reopen Codex to load its native picker without PickerMux models. Configuration and certifications are retained for reactivation. Use Remove PickerMux completely in Config for full removal.")
      Text("Fully quit Codex with Command-Q and keep the configured provider and its models available during setup. New installations use LM Studio by default. Setup may send live certification test prompts.")
      Text("Requires Node.js 22.15 or newer at /opt/homebrew/bin/node, /usr/local/bin/node or /usr/bin/node. A runtime available only through a shell profile cannot be used.")
        .font(CompanionTypography.body).foregroundStyle(.secondary)
      HStack {
        Link("Node.js downloads", destination: URL(string: "https://nodejs.org/en/download")!)
        Link("Troubleshooting", destination: URL(string: "https://github.com/patrickschiller/pickermux/blob/main/docs/TROUBLESHOOTING.md")!)
      }
      Button("Open Config…") { controller.showConfig() }
        .disabled(!controller.activityAllowed)
    }
    .font(CompanionTypography.body)
    .controlSize(.regular)
    .padding(20)
    .frame(width: 500)
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
    if let content = window.contentView { window.setContentSize(content.fittingSize) }
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
      Text(title).font(CompanionTypography.label)
      Text(text).font(CompanionTypography.body).fixedSize(horizontal: false, vertical: true)
      HStack {
        Spacer()
        Button("Cancel", action: cancel).keyboardShortcut(.cancelAction)
        Button(button, action: confirm).keyboardShortcut(.defaultAction)
      }
    }
    .font(CompanionTypography.body)
    .controlSize(.regular)
    .padding(20)
    .frame(width: 480)
  }
}
