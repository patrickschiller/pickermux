import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class BackendUpgradePromptTests: XCTestCase {
  private func snapshot(changes: [String: Any] = [:]) throws -> CompanionSnapshot {
    var value: [String: Any] = [
      "schemaVersion": 1, "capabilities": ["integration-toggle-v1"],
      "version": "0.22.1", "state": "ready", "desktop": ["status": "stopped"],
      "installation": ["status": "installed"], "managedConfig": ["status": "installed"],
      "service": ["status": "running"], "compatibility": ["status": "compatible"],
      "accountCache": ["status": "ready"], "recovery": ["status": "idle"],
      "integration": ["status": "pickermux"],
      "actions": ["configuration-preview", "configuration-apply", "integration-deactivate"], "issues": [],
    ]
    value.merge(changes) { _, next in next }
    return try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: value))
  }

  func testEligiblePairIsReservedBeforeRepeatedPollsOrCancelledFailedReviews() throws {
    for outcome in ["pending", "cancelled", "failed"] {
      var prompt = BackendUpgradePrompt()
      let current = try snapshot()
      XCTAssertTrue(prompt.reserveReview(appVersion: "0.22.2", snapshot: current), outcome)
      for _ in 0..<3 {
        XCTAssertFalse(prompt.reserveReview(appVersion: "0.22.2", snapshot: current), outcome)
      }
    }
  }

  func testRunningCodexAndBusyOperationsDeferWithoutConsumingThePair() throws {
    var prompt = BackendUpgradePrompt()
    for desktop in ["running", "open", "unknown"] {
      XCTAssertFalse(prompt.reserveReview(appVersion: "0.22.2", snapshot: try snapshot(changes: ["desktop": ["status": desktop]])))
    }
    let current = try snapshot()
    XCTAssertFalse(prompt.reserveReview(appVersion: "0.22.2", snapshot: current, busy: true))
    XCTAssertTrue(prompt.reserveReview(appVersion: "0.22.2", snapshot: current))
  }

  func testUnsafeOrIncompleteSnapshotsCannotOfferOrConsumeAnUpgrade() throws {
    let changes: [[String: Any]] = [
      ["state": "unknown"], ["state": "inactive"], ["state": "configuration-conflict"],
      ["compatibility": ["status": "unknown"]], ["compatibility": ["status": "update-required"]],
      ["installation": ["status": "not-installed"]], ["installation": ["status": "unknown"]],
      ["integration": ["status": "none"], "managedConfig": ["status": "deactivated"]],
      ["integration": ["status": "ollama"], "managedConfig": ["status": "deactivated"]],
      ["integration": ["status": "foreign"], "managedConfig": ["status": "deactivated"]],
      ["integration": ["status": "conflict"]], ["managedConfig": ["status": "modified"]],
      ["accountCache": ["status": "missing"]], ["accountCache": ["status": "version-mismatch"]],
      ["recovery": ["status": "pending", "phase": "suspended"]], ["recovery": ["status": "failed"]],
      ["recovery": ["status": "unknown"]], ["actions": []],
      ["actions": ["configuration-preview"]], ["actions": ["configuration-apply"]],
    ]
    for change in changes {
      var prompt = BackendUpgradePrompt()
      XCTAssertFalse(prompt.reserveReview(appVersion: "0.22.2", snapshot: try snapshot(changes: change)), "\(change)")
      XCTAssertTrue(prompt.reserveReview(appVersion: "0.22.2", snapshot: try snapshot()), "\(change)")
    }
  }

  func testAbsentBundledEqualNewerAndNoncanonicalVersionsCannotOffer() throws {
    var prompt = BackendUpgradePrompt()
    XCTAssertFalse(prompt.reserveReview(appVersion: "0.22.2", snapshot: nil))
    let current = try snapshot()
    XCTAssertFalse(prompt.reserveReview(appVersion: "0.22.2", snapshot:
      current.allowingOnly([.configurationPreview, .configurationApply], bundledBackend: true)))
    for version in ["0.22.1", "0.22.0", "development", "v0.22.2", "00.22.2", "0.22.2-beta"] {
      XCTAssertFalse(prompt.reserveReview(appVersion: version, snapshot: current), version)
    }
    for version in ["unknown", "0.22.1-beta"] {
      XCTAssertFalse(prompt.reserveReview(appVersion: "0.22.2", snapshot: try snapshot(changes: ["version": version])), version)
    }
    XCTAssertThrowsError(try snapshot(changes: ["version": "00.22.1"])) {
      XCTAssertEqual($0 as? CompanionFailure, .incompatibleProtocol)
    }
    XCTAssertTrue(prompt.reserveReview(appVersion: "0.22.2", snapshot: current))
  }

  func testOwnedRecoveredInstallationClosedCodexAndCompletedRecoveryRemainEligible() throws {
    var prompt = BackendUpgradePrompt()
    XCTAssertTrue(prompt.reserveReview(appVersion: "0.22.2", snapshot: try snapshot(changes: [
      "managedConfig": ["status": "installed-marker-recovered"], "desktop": ["status": "closed"],
      "accountCache": ["status": "valid"], "recovery": ["status": "completed"],
    ])))
  }

  func testManualReviewSuppressesOnlyItsKnownPair() throws {
    var prompt = BackendUpgradePrompt()
    let current = try snapshot()
    prompt.markReviewed(appVersion: "0.22.2", snapshot: current)
    XCTAssertFalse(prompt.reserveReview(appVersion: "0.22.2", snapshot: current))
    XCTAssertTrue(prompt.reserveReview(appVersion: "0.22.3", snapshot: current))
    var unproven = BackendUpgradePrompt()
    unproven.markReviewed(appVersion: "0.22.2", snapshot: nil)
    unproven.markReviewed(appVersion: "0.22.2", snapshot: current.allowingOnly([], bundledBackend: true))
    XCTAssertTrue(unproven.reserveReview(appVersion: "0.22.2", snapshot: current))
  }

  func testNewVersionPairAndNewProcessCanOfferAgain() throws {
    var prompt = BackendUpgradePrompt()
    let current = try snapshot()
    XCTAssertTrue(prompt.reserveReview(appVersion: "0.22.3", snapshot: current))
    XCTAssertTrue(prompt.reserveReview(appVersion: "0.22.3", snapshot: try snapshot(changes: ["version": "0.22.2"])))
    XCTAssertTrue(prompt.reserveReview(appVersion: "0.22.4", snapshot: current))
    var restarted = BackendUpgradePrompt()
    XCTAssertTrue(restarted.reserveReview(appVersion: "0.22.3", snapshot: current))
  }
}
