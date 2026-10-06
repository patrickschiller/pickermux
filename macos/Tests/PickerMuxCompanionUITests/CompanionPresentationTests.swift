import Foundation
import XCTest
@testable import PickerMuxCompanion
import PickerMuxCompanionCore

final class CompanionPresentationTests: XCTestCase {
  func testConfigurationSurfaceUsesConfigCopy() {
    XCTAssertEqual(CompanionPresentation.configButtonTitle, "Config…")
    XCTAssertEqual(CompanionPresentation.configWindowTitle, "PickerMux Config")
    XCTAssertEqual(CompanionPresentation.configHeading, "PickerMux Config")
    XCTAssertFalse(CompanionPresentation.configButtonTitle.contains("Settings"))
    XCTAssertFalse(CompanionPresentation.configWindowTitle.contains("Settings"))
    XCTAssertEqual(CompanionPresentation.menuPrimaryHeadings, ["Use PickerMux in Codex"])
  }

  func testDiagnosticsAndFullRefreshAreRoutedOnlyToConfig() {
    let available: [CompanionAction] = [
      .diagnose, .updateCheck, .refresh, .fullRefresh, .certify, .open, .recover,
      .update, .uninstall,
    ]

    XCTAssertEqual(CompanionPresentation.configActions(available: available), [.diagnose, .fullRefresh])
    XCTAssertEqual(CompanionPresentation.mainActions(available: available), [.refresh, .open, .certify, .recover])
    XCTAssertFalse(CompanionPresentation.mainActions(available: available).contains(.diagnose))
    XCTAssertFalse(CompanionPresentation.mainActions(available: available).contains(.fullRefresh))
    XCTAssertFalse(CompanionPresentation.showsMainFeedback(for: .diagnose))
    XCTAssertFalse(CompanionPresentation.showsMainFeedback(for: .fullRefresh))
    XCTAssertEqual(CompanionPresentation.configActions(available: [.diagnose]), [.diagnose, .fullRefresh])
    XCTAssertEqual(CompanionPresentation.configActions(available: []), [.fullRefresh])
  }

  func testReadyConfigActionsAreEnabledWithoutDisabledCopy() throws {
    let snapshot = try presentationSnapshot()
    for action in [CompanionAction.fullRefresh, .usageReset] {
      let availability = CompanionPresentation.configActionAvailability(
        for: action, snapshot: snapshot, appVersion: "0.30.0")
      XCTAssertTrue(availability.isEnabled)
      XCTAssertNil(availability.disabledReason)
    }
  }

  func testOlderBackendKeepsConfigActionsDiscoverableAndRequestsUpdateFirst() throws {
    let snapshot = try presentationSnapshot(version: "0.24.4", actions: [.diagnose], persistentUsage: false)
    XCTAssertEqual(CompanionPresentation.configActions(available: snapshot.actions), [.diagnose, .fullRefresh])
    for action in [CompanionAction.fullRefresh, .usageReset] {
      let availability = CompanionPresentation.configActionAvailability(
        for: action, snapshot: snapshot, appVersion: "0.30.0")
      XCTAssertFalse(availability.isEnabled)
      XCTAssertTrue(try XCTUnwrap(availability.disabledReason).contains("Update the installed backend in Config"))
    }
  }

  func testBundledStatusCannotAuthorizeConfigActionsAndExplainsInstalledBackendRequirement() throws {
    let installed = try presentationSnapshot()
    let bundled = installed.allowingOnly([.diagnose], bundledBackend: true)
    for action in [CompanionAction.fullRefresh, .usageReset] {
      let availability = CompanionPresentation.configActionAvailability(
        for: action, snapshot: bundled, appVersion: "0.30.0")
      XCTAssertFalse(availability.isEnabled)
      let reason = try XCTUnwrap(availability.disabledReason)
      XCTAssertTrue(reason.contains("verified installed backend"))
      XCTAssertFalse(reason.contains("/"))
    }
  }

  func testMissingActionAndTransientBusyStateAlwaysHaveSafeExplanations() throws {
    let ready = try presentationSnapshot()
    let busy = CompanionPresentation.configActionAvailability(
      for: .fullRefresh, snapshot: ready, appVersion: "0.30.0", busy: .diagnose)
    XCTAssertFalse(busy.isEnabled)
    XCTAssertTrue(try XCTUnwrap(busy.disabledReason).contains("current PickerMux operation"))

    for action in [CompanionAction.fullRefresh, .usageReset] {
      let missing = CompanionPresentation.configActionAvailability(
        for: action, snapshot: nil, appVersion: "0.30.0")
      XCTAssertFalse(missing.isEnabled)
      XCTAssertTrue(try XCTUnwrap(missing.disabledReason).contains("verified status"))
    }
  }

  func testBundledSetupLeavesCompactMenuAndRemainsActionableInConfig() throws {
    let actions: [CompanionAction] = [.configurationPreview, .configurationApply]
    let runningInstalled = try presentationSnapshot(actions: actions, desktop: "running")
    let runningBundled = runningInstalled.allowingOnly(actions, bundledBackend: true)
    let runningState = IntegrationToggleState(snapshot: runningBundled)
    XCTAssertTrue(runningState.isEnabled)
    XCTAssertTrue(runningState.needsSetupUpgrade)
    XCTAssertTrue(runningState.guidance.contains("Complete Codex setup"))
    XCTAssertNil(CompanionPresentation.compactIntegrationGuidance(for: runningState))

    let runningAvailability = CompanionPresentation.bundledSetupAvailability(snapshot: runningBundled)
    XCTAssertFalse(runningAvailability.isEnabled)
    XCTAssertTrue(try XCTUnwrap(runningAvailability.disabledReason).contains("Fully quit Codex"))
    XCTAssertFalse(try XCTUnwrap(runningAvailability.disabledReason).contains("Complete Codex setup"))

    let stoppedInstalled = try presentationSnapshot(actions: actions)
    let stoppedBundled = stoppedInstalled.allowingOnly(actions, bundledBackend: true)
    let stoppedState = IntegrationToggleState(snapshot: stoppedBundled)
    XCTAssertTrue(stoppedState.canReviewSetup)
    XCTAssertNil(CompanionPresentation.compactIntegrationGuidance(for: stoppedState))
    XCTAssertEqual(CompanionPresentation.bundledSetupAvailability(snapshot: stoppedBundled),
      CompanionPresentation.ActionAvailability(isEnabled: true, disabledReason: nil))

    let busyState = IntegrationToggleState(snapshot: stoppedBundled, busy: true)
    XCTAssertNotNil(CompanionPresentation.compactIntegrationGuidance(for: busyState, busy: .diagnose))
    XCTAssertTrue(try XCTUnwrap(CompanionPresentation.compactIntegrationGuidance(
      for: busyState, busy: .diagnose)).contains("current operation"))

    let regularState = IntegrationToggleState(snapshot: stoppedInstalled)
    XCTAssertNotNil(CompanionPresentation.compactIntegrationGuidance(for: regularState))
  }

  func testBundledSetupConfigControlExplainsTransientBlocks() throws {
    let actions: [CompanionAction] = [.configurationPreview, .configurationApply]
    let installed = try presentationSnapshot(actions: actions)
    let bundled = installed.allowingOnly(actions, bundledBackend: true)

    let busy = CompanionPresentation.bundledSetupAvailability(snapshot: bundled, busy: .diagnose)
    XCTAssertFalse(busy.isEnabled)
    XCTAssertTrue(try XCTUnwrap(busy.disabledReason).contains("current PickerMux operation"))

    let removing = CompanionPresentation.bundledSetupAvailability(snapshot: bundled, activityAllowed: false)
    XCTAssertFalse(removing.isEnabled)
    XCTAssertTrue(try XCTUnwrap(removing.disabledReason).contains("removal"))

    let missing = CompanionPresentation.bundledSetupAvailability(snapshot: nil)
    XCTAssertFalse(missing.isEnabled)
    XCTAssertTrue(try XCTUnwrap(missing.disabledReason).contains("verified status"))
  }

  func testProgressTitlesContainExactlyOneTrailingEllipsis() {
    XCTAssertEqual(CompanionPresentation.progressTitle(for: .refresh), "Refresh picker…")
    XCTAssertEqual(CompanionPresentation.progressTitle(for: .fullRefresh), "Full refresh…")
    XCTAssertFalse(CompanionPresentation.progressTitle(for: .fullRefresh).hasSuffix("……"))
  }

  func testInstallationCheckFailureUsesNonCircularConfigCopy() {
    let message = CompanionPresentation.actionFailureMessage(for: .diagnose, code: "ACTION_FAILED")
    XCTAssertTrue(message.contains("Installation checks found problems"))
    XCTAssertTrue(message.contains("Installation details"))
    XCTAssertTrue(message.contains("Help"))
    XCTAssertFalse(message.contains("Check status"))
    XCTAssertFalse(message.contains("ACTION_FAILED"))
  }

  func testConfigStatusFailuresDoNotDirectBackToStatus() {
    for failure in [
      CompanionFailure.missingLauncher, .missingNode, .unsafeNode, .unsafeLauncher,
      .timeout, .outputLimit, .processFailed, .incompatibleProtocol,
    ] {
      let guidance = CompanionPresentation.configStatusFailureGuidance(failure)
      XCTAssertFalse(guidance.localizedCaseInsensitiveContains("check status"), "\(failure)")
      XCTAssertFalse(guidance.isEmpty)
    }
  }

  func testKnownIssueCodesUseFixedGuidanceAndIgnoreBackendMessages() {
    let codes = [
      "metadata-unavailable", "desktop-unavailable", "installation-unavailable",
      "managedConfig-unavailable", "service-unavailable", "compatibility-unavailable",
      "accountCache-unavailable", "recovery-unavailable", "integration-unavailable",
      "configuration-conflict", "update-required", "account-cache-refresh-required",
      "recovery-pending", "providerConfiguration-unavailable",
    ]
    let backendMessage = "secret backend path /private/canary"
    for code in codes {
      let guidance = CompanionPresentation.statusIssueGuidance(for: code)
      XCTAssertFalse(guidance.contains(backendMessage))
      XCTAssertFalse(guidance.contains("/private/canary"))
      XCTAssertFalse(guidance.isEmpty)
    }
    let unknown = CompanionPresentation.statusIssueGuidance(for: backendMessage)
    XCTAssertFalse(unknown.contains(backendMessage))
    XCTAssertTrue(unknown.contains("does not recognize"))
    for code in ["update-required", "account-cache-refresh-required"] {
      let recovery = CompanionPresentation.statusIssueGuidance(for: code)
      XCTAssertTrue(recovery.contains("offered repair"))
      XCTAssertFalse(recovery.contains("run Full refresh"))
    }
  }

  func testNativeOnlyProviderSetupIsDiscoverableAndBlocksIneffectiveFullRefresh() throws {
    let snapshot = try providerSnapshot(status: .nativeOnly,
      actions: [.diagnose, .fullRefresh, .lmStudioDefaultPreview, .lmStudioDefaultApply])
    let setup = CompanionPresentation.providerSetupAvailability(
      snapshot: snapshot, appVersion: "0.30.0")
    XCTAssertTrue(setup.isEnabled)
    XCTAssertNil(setup.disabledReason)
    XCTAssertEqual(CompanionPresentation.providerSetupButtonTitle, "Enable LM Studio models…")
    XCTAssertEqual(CompanionPresentation.compactProviderNotice(for: snapshot), "No external models configured")
    XCTAssertTrue(CompanionPresentation.nativeOnlyModelsGuidance.contains("menu shows configured providers"))
    XCTAssertTrue(CompanionPresentation.nativeOnlyModelsGuidance.contains("Codex model picker"))
    XCTAssertFalse(CompanionPresentation.nativeOnlyModelsGuidance.contains("http"))

    let fullRefresh = CompanionPresentation.configActionAvailability(
      for: .fullRefresh, snapshot: snapshot, appVersion: "0.30.0")
    XCTAssertFalse(fullRefresh.isEnabled)
    XCTAssertEqual(fullRefresh.disabledReason,
      "Full refresh preserves provider configuration; enable LM Studio models first.")
  }

  func testExternalProviderConfigurationIsNeverOfferedReplacement() throws {
    let snapshot = try providerSnapshot(status: .external)
    let setup = CompanionPresentation.providerSetupAvailability(
      snapshot: snapshot, appVersion: "0.30.0")
    XCTAssertFalse(setup.isEnabled)
    XCTAssertTrue(try XCTUnwrap(setup.disabledReason).contains("will not replace"))
    XCTAssertNil(CompanionPresentation.compactProviderNotice(for: snapshot))
  }

  func testProviderSetupFailuresUseFixedWorkflowSpecificCopy() {
    let stale = CompanionPresentation.providerSetupFailureMessage("PREVIEW_STALE")
    XCTAssertTrue(stale.contains("Enable LM Studio models again"))
    XCTAssertFalse(stale.contains("Toggle PickerMux"))
    let unknown = CompanionPresentation.providerSetupFailureMessage("secret endpoint /private/canary")
    XCTAssertFalse(unknown.contains("secret"))
    XCTAssertFalse(unknown.contains("/private/canary"))
  }

  func testProviderSetupExplainsLegacyBundledAndUnavailableStates() throws {
    let legacy = try presentationSnapshot(version: "0.24.4", actions: [.diagnose], persistentUsage: false)
    let legacyAvailability = CompanionPresentation.providerSetupAvailability(
      snapshot: legacy, appVersion: "0.30.0")
    XCTAssertFalse(legacyAvailability.isEnabled)
    XCTAssertTrue(try XCTUnwrap(legacyAvailability.disabledReason).contains("Update the installed PickerMux backend"))

    let nativeOnly = try providerSnapshot(status: .nativeOnly,
      actions: [.lmStudioDefaultPreview, .lmStudioDefaultApply])
    let bundled = nativeOnly.allowingOnly([.lmStudioDefaultPreview, .lmStudioDefaultApply], bundledBackend: true)
    XCTAssertFalse(bundled.actions.contains(.lmStudioDefaultPreview))
    XCTAssertFalse(bundled.actions.contains(.lmStudioDefaultApply))
    let bundledAvailability = CompanionPresentation.providerSetupAvailability(
      snapshot: bundled, appVersion: "0.30.0")
    XCTAssertFalse(bundledAvailability.isEnabled)
    XCTAssertTrue(try XCTUnwrap(bundledAvailability.disabledReason).contains("verified installed backend"))

    for status in [ProviderConfigurationKind.notInstalled, .unknown] {
      let unavailable = CompanionPresentation.providerSetupAvailability(
        snapshot: try providerSnapshot(status: status), appVersion: "0.30.0")
      XCTAssertFalse(unavailable.isEnabled)
      XCTAssertFalse(try XCTUnwrap(unavailable.disabledReason).isEmpty)
    }
  }

  private func presentationSnapshot(version: String = "0.30.0",
                                    actions: [CompanionAction] = [.diagnose, .fullRefresh, .usageReset],
                                    persistentUsage: Bool = true,
                                    desktop: String = "stopped") throws -> CompanionSnapshot {
    let capabilities = persistentUsage ?
      ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v2", "token-usage-reset-v1"] :
      ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v1"]
    let tokenUsage: [String: Any] = persistentUsage ?
      ["schemaVersion": 2, "status": "available", "resetAt": NSNull(), "providers": []] :
      ["schemaVersion": 1, "status": "available", "providers": []]
    let fields: [String: Any] = [
      "schemaVersion": 1, "version": version, "state": "ready", "capabilities": capabilities,
      "desktop": ["status": desktop], "installation": ["status": "installed"],
      "managedConfig": ["status": "installed"], "service": ["status": "running"],
      "compatibility": ["status": "compatible"], "accountCache": ["status": "ready"],
      "integration": ["status": "pickermux"], "recovery": ["status": "idle"],
      "issues": [], "actions": actions.map(\.rawValue), "tokenUsage": tokenUsage,
    ]
    return try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: fields))
  }

  private func providerSnapshot(status: ProviderConfigurationKind,
                                actions: [CompanionAction] = []) throws -> CompanionSnapshot {
    let fields: [String: Any] = [
      "schemaVersion": 1, "version": "0.30.0", "state": "ready",
      "capabilities": ["integration-toggle-v1", "native-uninstall-v1",
        "native-only-lmstudio-setup-v1", "token-usage-v2", "token-usage-reset-v1"],
      "desktop": ["status": "stopped"], "installation": ["status": "installed"],
      "managedConfig": ["status": "installed"], "service": ["status": "running"],
      "compatibility": ["status": "compatible"], "accountCache": ["status": "ready"],
      "integration": ["status": "pickermux"], "recovery": ["status": "idle"],
      "providerConfiguration": ["status": status.rawValue], "issues": [],
      "actions": actions.map(\.rawValue),
      "tokenUsage": ["schemaVersion": 2, "status": "available", "resetAt": NSNull(), "providers": []],
    ]
    return try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: fields))
  }
}
