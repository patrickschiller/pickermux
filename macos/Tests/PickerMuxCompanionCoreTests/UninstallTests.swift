import Foundation
import ServiceManagement
import XCTest
@testable import PickerMuxCompanionCore

@MainActor
final class UninstallTests: XCTestCase {
  func testAbsentInstallationExplainsAppDeletionInsteadOfRequestingCliUpdate() throws {
    let absent = try removalSnapshot([
      "installation": ["status": "not-installed"], "managedConfig": ["status": "not-installed"],
      "service": ["status": "not-installed"], "integration": ["status": "none"],
      "actions": ["configuration-preview"],
    ]).allowingOnly([.configurationPreview], bundledBackend: true)
    XCTAssertEqual(CompanionRemovalCoordinator.availability(absent), .notInstalled)
    XCTAssertFalse(CompanionRemovalCoordinator.canRemove(absent))
    XCTAssertTrue(CompanionRemovalCoordinator.availability(absent).notice?.contains("nothing left to uninstall") == true)
    XCTAssertFalse(CompanionRemovalCoordinator.availability(absent).notice?.contains("0.9.5") == true)
  }

  func testPartialOrUnknownInstallationCannotBePresentedAsAlreadyRemoved() throws {
    for changes in [
      ["managedConfig": ["status": "unknown"]], ["managedConfig": ["status": "installed"]],
      ["service": ["status": "running"]], ["service": ["status": "unknown"]],
      ["integration": ["status": "pickermux"]], ["recovery": ["status": "pending", "phase": "prepared", "operationId": "11111111-1111-4111-8111-111111111111"]],
    ] as [[String: Any]] {
      var fields: [String: Any] = ["installation": ["status": "not-installed"], "managedConfig": ["status": "not-installed"],
        "service": ["status": "not-installed"], "integration": ["status": "none"]]
      fields.merge(changes) { _, new in new }
      let partial = try removalSnapshot(fields).allowingOnly([.configurationPreview], bundledBackend: true)
      XCTAssertNotEqual(CompanionRemovalCoordinator.availability(partial), .notInstalled)
      XCTAssertFalse(CompanionRemovalCoordinator.canRemove(partial))
    }
  }

  func testRemovalAvailabilityIdentifiesEachBlockingCondition() throws {
    XCTAssertEqual(CompanionRemovalCoordinator.availability(nil), .statusUnavailable)
    XCTAssertEqual(CompanionRemovalCoordinator.availability(try removalSnapshot()), .available)
    for (changes, expected) in [
      (["capabilities": ["integration-toggle-v1"], "actions": ["configuration-preview"]], CompanionRemovalAvailability.backendUnsupported),
      (["desktop": ["status": "running"]], .codexRunning),
      (["desktop": ["status": "unknown"]], .codexUnknown),
      (["installation": ["status": "invalid"]], .installationUnverified),
      (["recovery": ["status": "pending", "phase": "prepared", "operationId": "11111111-1111-4111-8111-111111111111"]], .recoveryPending),
      (["recovery": ["status": "unknown"]], .recoveryUnknown),
      (["actions": ["uninstall-preview"]], .actionUnavailable),
    ] as [([String: Any], CompanionRemovalAvailability)] {
      let snapshot = try removalSnapshot(changes)
      XCTAssertEqual(CompanionRemovalCoordinator.availability(snapshot), expected)
      XCTAssertFalse(CompanionRemovalCoordinator.canRemove(snapshot))
      XCTAssertNotNil(expected.notice)
    }
  }

  func testReviewCancellationDoesNotDisableLoginOrRemoveAnything() async throws {
    let coordinator = CompanionRemovalCoordinator()
    let client = try RemovalClient()
    var mutations = 0
    XCTAssertTrue(coordinator.beginReview())
    await coordinator.remove(client: client, confirm: { review in
      XCTAssertTrue(review.text.contains("registered provider credentials"))
      XCTAssertTrue(review.text.contains("Codex login, chats"))
      return false
    }, unregisterLogin: { mutations += 1 }, cleanup: { mutations += 1 })
    XCTAssertEqual(coordinator.state, .idle)
    XCTAssertEqual(client.calls, [.uninstallPreview])
    XCTAssertEqual(mutations, 0)
  }

  func testSuccessfulRemovalUsesReviewedTokenAndDisablesLoginBeforePurge() async throws {
    let coordinator = CompanionRemovalCoordinator()
    let client = try RemovalClient()
    var sequence = [String]()
    client.onRemove = { sequence.append("purge") }
    coordinator.beginReview()
    await coordinator.remove(client: client, confirm: { _ in true },
      unregisterLogin: { sequence.append("login") }, cleanup: { sequence.append("cleanup") })
    XCTAssertEqual(sequence, ["login", "purge", "cleanup"])
    XCTAssertEqual(coordinator.state, .removed)
    XCTAssertTrue(coordinator.state.backendRemoved)
    XCTAssertEqual(client.calls, [.uninstallPreview, .uninstall])
    XCTAssertEqual(client.token, String(repeating: "b", count: 64))
    XCTAssertTrue(client.confirmed)
    XCTAssertFalse(coordinator.beginReview())
  }

  func testLoginFailureLeavesBackendAndSettingsUntouched() async throws {
    let coordinator = CompanionRemovalCoordinator()
    let client = try RemovalClient()
    var cleanups = 0
    coordinator.beginReview()
    await coordinator.remove(client: client, confirm: { _ in true },
      unregisterLogin: { throw CompanionFailure.processFailed }, cleanup: { cleanups += 1 })
    XCTAssertEqual(coordinator.state, .failed("LOGIN_UNREGISTER_FAILED"))
    XCTAssertEqual(client.calls, [.uninstallPreview])
    XCTAssertEqual(cleanups, 0)
  }

  func testNeverRegisteredLoginStartupCanCompleteRemovalAfterAuthoritativeAbsentProof() async throws {
    let coordinator = CompanionRemovalCoordinator()
    let client = try RemovalClient()
    var unregisters = 0
    coordinator.beginReview()
    await coordinator.remove(client: client, confirm: { _ in true }, unregisterLogin: {
      try await unregisterCompanionLoginStartup(status: { .notFound }, unregister: {
        unregisters += 1
        throw NSError(domain: companionServiceManagementErrorDomain(), code: kSMErrorJobNotFound)
      }, pause: { XCTFail("Already absent") })
    }, cleanup: {})
    XCTAssertEqual(unregisters, 1)
    XCTAssertEqual(coordinator.state, .removed)
    XCTAssertEqual(client.calls, [.uninstallPreview, .uninstall])
  }

  func testSignatureFailureDoesNotCallPurgeAndReportsRetainedIntegration() async throws {
    let coordinator = CompanionRemovalCoordinator()
    let client = try RemovalClient()
    coordinator.beginReview()
    await coordinator.remove(client: client, confirm: { _ in true }, unregisterLogin: {
      try await unregisterCompanionLoginStartup(status: { .notFound }, unregister: {
        throw NSError(domain: companionServiceManagementErrorDomain(), code: kSMErrorInvalidSignature)
      }, pause: { XCTFail("Invalid signature") })
    }, cleanup: { XCTFail("Failed login cleanup must not delete settings") })
    XCTAssertEqual(coordinator.state, .failed("LOGIN_SIGNATURE_INVALID"))
    XCTAssertEqual(client.calls, [.uninstallPreview])
    XCTAssertTrue(coordinator.state.notice?.contains("integration and CLI were retained") == true)
  }

  func testFailedAndPartialBackendRemovalNeverReportsSuccessOrCleansApp() async throws {
    for code in ["UNINSTALL_CONFLICT", "PURGE_INCOMPLETE", "UNINSTALL_FAILED"] {
      let coordinator = CompanionRemovalCoordinator()
      let client = try RemovalClient()
      client.removal = try CompanionResult.decode(JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "ok": false, "code": code]))
      var cleanups = 0
      coordinator.beginReview()
      await coordinator.remove(client: client, confirm: { _ in true }, unregisterLogin: {}, cleanup: { cleanups += 1 })
      XCTAssertEqual(coordinator.state, .failed(code))
      XCTAssertFalse(coordinator.state.backendRemoved)
      XCTAssertEqual(cleanups, 0)
    }
  }

  func testGenericOrMalformedSuccessCannotBecomeRemoved() async throws {
    let coordinator = CompanionRemovalCoordinator()
    let client = try RemovalClient()
    client.removal = try CompanionResult.decode(Data(#"{"schemaVersion":1,"ok":true,"code":"COMPLETE"}"#.utf8))
    coordinator.beginReview()
    await coordinator.remove(client: client, confirm: { _ in true }, unregisterLogin: {}, cleanup: { XCTFail("No verified commit") })
    XCTAssertEqual(coordinator.state, .failed("UNINSTALL_PROTOCOL_INVALID"))
  }

  func testCleanupFailureStaysTerminalAndRetryDoesNotPurgeAgain() async throws {
    let coordinator = CompanionRemovalCoordinator()
    let client = try RemovalClient()
    coordinator.beginReview()
    await coordinator.remove(client: client, confirm: { _ in true }, unregisterLogin: {}, cleanup: { throw CompanionFailure.processFailed })
    XCTAssertEqual(coordinator.state, .cleanupRequired)
    XCTAssertTrue(coordinator.state.backendRemoved)
    XCTAssertFalse(coordinator.state.permitsActivity)
    var cleanupRetries = 0
    await coordinator.retryCleanup { cleanupRetries += 1 }
    await coordinator.retryCleanup { XCTFail("Completed cleanup must not repeat") }
    XCTAssertEqual(coordinator.state, .removed)
    XCTAssertEqual(cleanupRetries, 1)
    XCTAssertEqual(client.calls, [.uninstallPreview, .uninstall])
  }

  func testLegacyBundledAndRunningSnapshotsCannotAuthorizeRemoval() async throws {
    for changes in [
      ["capabilities": ["integration-toggle-v1"], "actions": ["configuration-preview"]],
      ["desktop": ["status": "running"]],
      ["recovery": ["status": "pending"]],
      ["installation": ["status": "invalid"]],
    ] as [[String: Any]] {
      let coordinator = CompanionRemovalCoordinator()
      let client = try RemovalClient(changes)
      coordinator.beginReview()
      await coordinator.remove(client: client, confirm: { _ in XCTFail("Unavailable review"); return true },
        unregisterLogin: { XCTFail("Unavailable login mutation") }, cleanup: {})
      XCTAssertEqual(coordinator.state, .failed("UNINSTALL_UNSUPPORTED"))
      XCTAssertTrue(coordinator.state.notice?.contains("~/.local/bin/pickermux uninstall --purge") == true)
      XCTAssertTrue(coordinator.state.notice?.contains("No setup or update was started") == true)
      XCTAssertTrue(coordinator.state.notice?.contains("0.9.5 or newer") == true)
      XCTAssertTrue(coordinator.state.notice?.contains("may reactivate an earlier Ollama integration") == true)
      XCTAssertTrue(client.calls.isEmpty)
    }
    let bundled = try removalSnapshot().allowingOnly([.uninstallPreview, .uninstall], bundledBackend: true)
    XCTAssertFalse(CompanionRemovalCoordinator.canRemove(bundled))
    XCTAssertTrue(CompanionRemovalCoordinator.canRemove(try removalSnapshot(["managedConfig": ["status": "deactivated"], "integration": ["status": "none"]])))
  }

  func testLateObservationsAndQueuedPollsCannotRunAfterRemoval() async throws {
    let coordinator = CompanionRemovalCoordinator()
    let client = try RemovalClient()
    let queue = CompanionOperationQueue()
    let inFlightPoll = await queue.acquire(.status)
    let oldGeneration = coordinator.generation
    coordinator.beginReview()
    var clientCallsAfterRemoval = 0
    let removal = Task {
      let lease = await queue.acquire(.action)
      await coordinator.remove(client: client, confirm: { _ in true }, unregisterLogin: {}, cleanup: {})
      queue.release(lease)
    }
    await waitUntil { queue.waitingCount == 1 }
    let waitingPoll = Task {
      let lease = await queue.acquire(.status)
      if coordinator.permitsActivity(oldGeneration) { clientCallsAfterRemoval += 1 }
      queue.release(lease)
    }
    await waitUntil { queue.waitingCount == 2 }
    XCTAssertFalse(coordinator.permitsActivity(oldGeneration), "An in-flight poll cannot publish its late result")
    queue.release(inFlightPoll)
    await removal.value
    await waitingPoll.value
    XCTAssertEqual(coordinator.state, .removed)
    XCTAssertEqual(clientCallsAfterRemoval, 0)
    XCTAssertFalse(coordinator.permitsActivity(coordinator.generation), "Fresh polling and auto-refresh remain stopped")
    XCTAssertTrue(queue.isIdle)
  }

  func testCancellationInvalidatesQueuedWorkEvenWhenNormalActivityResumes() async throws {
    let coordinator = CompanionRemovalCoordinator()
    let old = coordinator.generation
    coordinator.beginReview()
    await coordinator.remove(client: try RemovalClient(), confirm: { _ in false }, unregisterLogin: {}, cleanup: {})
    XCTAssertFalse(coordinator.permitsActivity(old))
    XCTAssertTrue(coordinator.permitsActivity(coordinator.generation))
  }

  func testPreferenceCleanupPreservesUnrelatedData() {
    var defaults: [String: Any] = ["refreshOnClose": true, "statusNotifications": true, "unrelated-setting": "keep"]
    var removedKeys = [String]()
    clearCompanionPreferences(removing: { key in
      removedKeys.append(key)
      defaults.removeValue(forKey: key)
    })
    XCTAssertNil(defaults["refreshOnClose"])
    XCTAssertNil(defaults["statusNotifications"])
    XCTAssertEqual(defaults["unrelated-setting"] as? String, "keep")
    XCTAssertEqual(removedKeys, ["refreshOnClose", "statusNotifications"])
    XCTAssertEqual(companionOwnedNotificationIdentifiers, ["pickermux-state"])
  }

  private func waitUntil(_ predicate: () -> Bool) async {
    for _ in 0..<100 { if predicate() { return }; await Task.yield() }
    XCTFail("Queued operation did not arrive")
  }
}

private func removalSnapshot(_ changes: [String: Any] = [:]) throws -> CompanionSnapshot {
  var fields: [String: Any] = [
    "schemaVersion": 1, "capabilities": ["integration-toggle-v1", "native-uninstall-v1"], "version": "0.9.5", "state": "ready",
    "desktop": ["status": "stopped"], "installation": ["status": "installed"], "managedConfig": ["status": "installed"],
    "service": ["status": "running"], "compatibility": ["status": "compatible"], "accountCache": ["status": "ready"],
    "recovery": ["status": "idle"], "integration": ["status": "pickermux"], "actions": ["uninstall-preview", "uninstall"], "issues": [],
  ]
  fields.merge(changes) { _, new in new }
  return try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: fields))
}

private final class RemovalClient: CompanionControlling {
  let snapshot: CompanionSnapshot
  var calls = [CompanionAction]()
  var token: String?
  var confirmed = false
  var onRemove: (() -> Void)?
  var removal: CompanionResult

  init(_ changes: [String: Any] = [:]) throws {
    snapshot = try removalSnapshot(changes)
    removal = try CompanionResult.decode(JSONSerialization.data(withJSONObject: [
      "schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": [
        "action": "uninstall", "status": "removed", "removed": true, "nativeRestored": true,
        "historicalChatsPreserved": true, "restartRequired": true,
      ],
    ]))
  }

  func status() async throws -> CompanionSnapshot { snapshot }
  func run(_ action: CompanionAction, confirmed: Bool, previewToken: String?) async throws -> CompanionResult {
    calls.append(action)
    if action == .uninstallPreview {
      return try CompanionResult.decode(JSONSerialization.data(withJSONObject: [
        "schemaVersion": 1, "ok": true, "code": "PREVIEW_READY", "data": [
          "action": "uninstall-preview", "status": "ready", "canApply": true,
          "previewToken": String(repeating: "b", count: 64), "changes": UninstallPreview.expectedChanges,
        ],
      ]))
    }
    self.confirmed = confirmed
    token = previewToken
    onRemove?()
    return removal
  }
}
