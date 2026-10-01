import Foundation
import XCTest
@testable import PickerMuxCompanionCore

@MainActor
final class IntegrationToggleTests: XCTestCase {
  func snapshot(active: Bool = false, changes: [String: Any] = [:]) throws -> CompanionSnapshot {
    var value: [String: Any] = [
      "schemaVersion": 1, "capabilities": ["integration-toggle-v1"], "version": "0.9.0",
      "state": active ? "ready" : "inactive", "desktop": ["status": "stopped"],
      "installation": ["status": "installed"], "managedConfig": ["status": active ? "installed" : "deactivated"],
      "service": ["status": active ? "running" : "stopped"], "compatibility": ["status": active ? "compatible" : "not-installed"],
      "accountCache": ["status": "ready"], "recovery": ["status": "idle"],
      "integration": ["status": active ? "pickermux" : "none"],
      "actions": active ? ["configuration-preview", "configuration-apply", "integration-deactivate"] : ["configuration-preview", "configuration-apply"],
      "issues": [],
    ]
    value.merge(changes) { _, next in next }
    return try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: value))
  }

  func testSwitchUsesOwnedConfigurationAndHonorsBusyUnknownAndRecoveryStates() throws {
    XCTAssertTrue(IntegrationToggleState(snapshot: try snapshot(active: true)).isEnabled)
    XCTAssertTrue(IntegrationToggleState(snapshot: try snapshot(active: true)).canChange)
    XCTAssertFalse(IntegrationToggleState(snapshot: try snapshot()).isEnabled)
    XCTAssertTrue(IntegrationToggleState(snapshot: try snapshot()).canChange)
    XCTAssertFalse(IntegrationToggleState(snapshot: nil).canChange)
    XCTAssertFalse(IntegrationToggleState(snapshot: try snapshot(active: true), busy: true).canChange)
    for changes in [
      ["desktop": ["status": "unknown"]], ["installation": ["status": "unknown"]],
      ["managedConfig": ["status": "modified"]], ["integration": ["status": "conflict"]],
      ["recovery": ["status": "pending", "phase": "suspended"]], ["actions": []],
    ] as [[String: Any]] {
      XCTAssertFalse(IntegrationToggleState(snapshot: try snapshot(active: true, changes: changes)).canChange)
    }
  }

  func testFreshPreviewAndConfirmationAreRequiredBeforeInstallation() async throws {
    let client = ToggleClient(snapshot: try snapshot(changes: ["installation": ["status": "not-installed"], "managedConfig": ["status": "not-installed"]]))
    var reviews = [IntegrationReview]()
    let result = try await changePickerMuxIntegration(true, client: client) { review in reviews.append(review); return true }
    guard case .completed(let envelope) = result else { return XCTFail("Confirmed setup should complete") }
    XCTAssertTrue(envelope.ok)
    XCTAssertEqual(client.calls.map(\.action), [.configurationPreview, .configurationApply])
    XCTAssertEqual(client.calls.last?.confirmed, true)
    XCTAssertEqual(client.calls.last?.previewToken, String(repeating: "b", count: 64))
    XCTAssertEqual(reviews.count, 1)
    XCTAssertTrue(reviews[0].title.contains("Install"))
    XCTAssertTrue(reviews[0].text.contains("certification"))
    XCTAssertFalse(IntegrationToggleState(snapshot: client.snapshotValue).isEnabled)
  }

  func testCancellingEitherDirectionPerformsNoMutation() async throws {
    let installing = ToggleClient(snapshot: try snapshot())
    let installResult = try await changePickerMuxIntegration(true, client: installing) { _ in false }
    guard case .cancelled = installResult else { return XCTFail("Setup must honor cancellation") }
    XCTAssertEqual(installing.calls.map(\.action), [.configurationPreview])
    let deactivating = ToggleClient(snapshot: try snapshot(active: true))
    let offResult = try await changePickerMuxIntegration(false, client: deactivating) { _ in false }
    guard case .cancelled = offResult else { return XCTFail("Deactivation must honor cancellation") }
    XCTAssertTrue(deactivating.calls.isEmpty)
  }

  func testDeactivationRequiresFreshAllowedStatusAndExplicitConfirmation() async throws {
    let client = ToggleClient(snapshot: try snapshot(active: true))
    var review: IntegrationReview?
    let result = try await changePickerMuxIntegration(false, client: client) { value in review = value; return true }
    guard case .completed = result else { return XCTFail("Deactivation should complete") }
    XCTAssertEqual(client.calls.map(\.action), [.integrationDeactivate])
    XCTAssertEqual(client.calls.first?.confirmed, true)
    XCTAssertNil(client.calls.first?.previewToken)
    XCTAssertTrue(try XCTUnwrap(review).text.contains("native Codex"))
    XCTAssertTrue(try XCTUnwrap(review).text.contains("complete uninstall"))
    XCTAssertTrue(IntegrationToggleState(snapshot: client.snapshotValue).isEnabled)
  }

  func testBlockedOrRefusedPreviewNeverAsksForConfirmationOrApplies() async throws {
    let blocked = ToggleClient(snapshot: try snapshot(changes: ["actions": ["configuration-preview"]]))
    let denied = try await changePickerMuxIntegration(true, client: blocked) { _ in XCTFail("Unavailable setup must not ask for consent"); return true }
    guard case .blocked = denied else { return XCTFail("Unavailable setup must remain blocked") }
    XCTAssertTrue(blocked.calls.isEmpty)
    let refused = ToggleClient(snapshot: try snapshot())
    refused.previewResult = try CompanionResult.decode(Data(#"{"schemaVersion":1,"ok":true,"code":"COMPLETE","data":{"status":"conflict","canApply":false,"requiresConfirmation":false,"changes":[],"previewToken":null}}"#.utf8))
    let result = try await changePickerMuxIntegration(true, client: refused) { _ in XCTFail("A refused preview must not ask for consent"); return true }
    guard case .blocked = result else { return XCTFail("Conflict must remain blocked") }
    XCTAssertEqual(refused.calls.map(\.action), [.configurationPreview])
  }

  func testStalePreviewFailureDoesNotChangeSwitchOrRetry() async throws {
    let client = ToggleClient(snapshot: try snapshot())
    client.mutationResult = try CompanionResult.decode(Data(#"{"schemaVersion":1,"ok":false,"code":"PREVIEW_STALE"}"#.utf8))
    let result = try await changePickerMuxIntegration(true, client: client) { _ in true }
    guard case .completed(let envelope) = result else { return XCTFail("Backend failure must be returned") }
    XCTAssertFalse(envelope.ok)
    XCTAssertEqual(envelope.code, "PREVIEW_STALE")
    XCTAssertEqual(client.calls.map(\.action), [.configurationPreview, .configurationApply])
    XCTAssertFalse(IntegrationToggleState(snapshot: client.snapshotValue).isEnabled)
  }

  func testExplicitToggleAutomaticallyInstallsWithFreshStatusAndExactPreviewToken() async throws {
    let client = ToggleClient(snapshot: try snapshot(changes: ["installation": ["status": "not-installed"], "managedConfig": ["status": "not-installed"]]))
    let outcome = try await changePickerMuxIntegration(true, client: client, consent: .toggleIntent) { _ in
      XCTFail("A deliberate toggle must not request a second confirmation"); return false
    }
    guard case .completed(let result) = outcome else { return XCTFail("Toggle intent should install") }
    XCTAssertTrue(result.ok)
    XCTAssertEqual(client.statusCalls, 1)
    XCTAssertEqual(client.calls.map(\.action), [.configurationPreview, .configurationApply])
    XCTAssertEqual(client.calls.last?.previewToken, String(repeating: "b", count: 64))
    XCTAssertEqual(client.calls.last?.confirmed, true)
    XCTAssertFalse(IntegrationToggleState(snapshot: client.snapshotValue).isEnabled)
  }

  func testExplicitOffToggleIsExactConsentAndDoesNotRequestModalReview() async throws {
    let client = ToggleClient(snapshot: try snapshot(active: true))
    let outcome = try await changePickerMuxIntegration(false, client: client, consent: .toggleIntent) { _ in
      XCTFail("A deliberate off toggle must not request another modal"); return false
    }
    guard case .completed = outcome else { return XCTFail("Off intent should deactivate") }
    XCTAssertEqual(client.statusCalls, 1)
    XCTAssertEqual(client.calls.map(\.action), [.integrationDeactivate])
    XCTAssertEqual(client.calls.first?.confirmed, true)
    XCTAssertNil(client.calls.first?.previewToken)
  }

  func testAutomaticActivationHonorsChangedStatusAndPreviewFailure() async throws {
    let running = ToggleClient(snapshot: try snapshot(changes: ["desktop": ["status": "running"]]))
    let denied = try await changePickerMuxIntegration(true, client: running, consent: .toggleIntent)
    guard case .blocked = denied else { return XCTFail("A newly running Codex must block activation") }
    XCTAssertTrue(running.calls.isEmpty)
    let unavailable = ToggleClient(snapshot: try snapshot())
    unavailable.previewResult = try CompanionResult.decode(Data(#"{"schemaVersion":1,"ok":false,"code":"PROVIDER_UNAVAILABLE"}"#.utf8))
    let failed = try await changePickerMuxIntegration(true, client: unavailable, consent: .toggleIntent)
    guard case .completed(let result) = failed else { return XCTFail("Provider failure must be returned") }
    XCTAssertFalse(result.ok)
    XCTAssertEqual(unavailable.calls.map(\.action), [.configurationPreview])
  }

  func testAutomaticStalePreviewIsNotRetriedAndCancellationAfterPreviewCannotMutate() async throws {
    let stale = ToggleClient(snapshot: try snapshot())
    stale.mutationResult = try CompanionResult.decode(Data(#"{"schemaVersion":1,"ok":false,"code":"PREVIEW_STALE"}"#.utf8))
    let outcome = try await changePickerMuxIntegration(true, client: stale, consent: .toggleIntent)
    guard case .completed(let result) = outcome else { return XCTFail("Stale preview failure must be returned") }
    XCTAssertEqual(result.code, "PREVIEW_STALE")
    XCTAssertEqual(stale.calls.map(\.action), [.configurationPreview, .configurationApply])
    let cancelled = ToggleClient(snapshot: try snapshot())
    cancelled.cancelDuringPreview = true
    let task = Task { try await changePickerMuxIntegration(true, client: cancelled, consent: .toggleIntent) }
    do {
      _ = try await task.value
      XCTFail("Cancelled setup must not mutate")
    } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(cancelled.calls.map(\.action), [.configurationPreview])
  }

  func testActiveLegacySetupCanBeReviewedWhileOffRemainsBlocked() async throws {
    let original = try snapshot(active: true)
    let bundled = original.allowingOnly([.configurationPreview, .configurationApply], bundledBackend: true)
    let state = IntegrationToggleState(snapshot: bundled)
    XCTAssertTrue(state.isEnabled)
    XCTAssertTrue(state.needsSetupUpgrade)
    XCTAssertTrue(state.canReviewSetup)
    XCTAssertFalse(state.canChange)
    let client = ToggleClient(snapshot: bundled)
    let off = try await changePickerMuxIntegration(false, client: client) { _ in XCTFail("Bundled source cannot deactivate"); return true }
    guard case .blocked = off else { return XCTFail("Legacy off must be blocked") }
    XCTAssertTrue(client.calls.isEmpty)
    let upgrade = try await changePickerMuxIntegration(true, reviewInstalledSetup: true, client: client) { review in
      XCTAssertTrue(review.title.contains("Update")); return true
    }
    guard case .completed = upgrade else { return XCTFail("Confirmed bundled setup upgrade should complete") }
    XCTAssertEqual(client.calls.map(\.action), [.configurationPreview, .configurationApply])
  }
}

private final class ToggleClient: CompanionControlling {
  struct Call {
    let action: CompanionAction
    let confirmed: Bool
    let previewToken: String?
  }
  var snapshotValue: CompanionSnapshot
  var statusCalls = 0
  var cancelDuringPreview = false
  var calls = [Call]()
  var previewResult: CompanionResult
  var mutationResult: CompanionResult

  init(snapshot: CompanionSnapshot) {
    snapshotValue = snapshot
    previewResult = try! CompanionResult.decode(Data("{\"schemaVersion\":1,\"ok\":true,\"code\":\"COMPLETE\",\"data\":{\"status\":\"none\",\"canApply\":true,\"requiresConfirmation\":true,\"changes\":[\"reactivate-integration\"],\"previewToken\":\"\(String(repeating: "b", count: 64))\"}}".utf8))
    mutationResult = try! CompanionResult.decode(Data(#"{"schemaVersion":1,"ok":true,"code":"COMPLETE"}"#.utf8))
  }
  func status() async throws -> CompanionSnapshot { statusCalls += 1; return snapshotValue }
  func run(_ action: CompanionAction, confirmed: Bool, previewToken: String?) async throws -> CompanionResult {
    calls.append(Call(action: action, confirmed: confirmed, previewToken: previewToken))
    if action == .configurationPreview && cancelDuringPreview {
      withUnsafeCurrentTask { $0?.cancel() }
    }
    return action == .configurationPreview ? previewResult : mutationResult
  }
}
