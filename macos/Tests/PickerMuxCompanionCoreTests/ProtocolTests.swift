import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class ProtocolTests: XCTestCase {
  func testNodeFailureGuidanceDistinguishesAbsentAndRejectedInstallations() {
    XCTAssertNotEqual(CompanionFailure.missingNode.message, CompanionFailure.unsafeNode.message)
    XCTAssertTrue(CompanionFailure.missingNode.message.contains("22.15"))
    XCTAssertTrue(CompanionFailure.unsafeNode.message.contains("installed"))
    XCTAssertTrue(CompanionFailure.unsafeNode.message.contains("review"))
    XCTAssertFalse(CompanionFailure.unsafeNode.message.contains("Install Node"))
    XCTAssertFalse(CompanionFailure.unsafeNode.message.contains("/"))
  }

  func snapshot(_ changes: [String: Any] = [:]) throws -> Data {
    var value: [String: Any] = [
      "schemaVersion": 1, "version": "0.8.3", "state": "ready",
      "desktop": ["status": "closed"], "installation": ["status": "installed"],
      "managedConfig": ["status": "managed"], "service": ["status": "running"],
      "compatibility": ["status": "compatible"], "accountCache": ["status": "valid"],
      "recovery": ["status": "idle", "phase": NSNull(), "operationId": NSNull()],
      "integration": ["status": "pickermux"], "actions": ["refresh", "open"], "issues": [],
    ]
    value.merge(changes) { _, new in new }
    return try JSONSerialization.data(withJSONObject: value)
  }

  func testCurrentSchemaAcceptsOnlyBoundedPublicFields() throws {
    let value = try CompanionSnapshot.decode(snapshot())
    XCTAssertEqual(value.actions, [.refresh, .open])
    XCTAssertEqual(value.state, "ready")
    for changes in [
      ["schemaVersion": 2], ["version": "/private/config"], ["unexpected": "value"],
      ["actions": ["refresh", "refresh"]], ["actions": ["shell"]],
      ["service": ["status": "http://127.0.0.1/private"]],
      ["recovery": ["status": "active", "phase": "unknown"]],
    ] as [[String: Any]] {
      XCTAssertThrowsError(try CompanionSnapshot.decode(snapshot(changes)))
    }
  }

  func testRecoveryConfirmationCannotBeImplicitOrReused() throws {
    XCTAssertThrowsError(try actionRequest(.recover))
    let data = try actionRequest(.recover, confirmed: true)
    let request = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(request["action"] as? String, "recover")
    XCTAssertEqual(request["confirmation"] as? [String: Bool], ["quitCodexTwice": true, "interruptTasks": true, "invalidateCompaction": true])
    XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("FULL"))
    XCTAssertThrowsError(try actionRequest(.recover))
  }

  func testConfigurationApplyRequiresBoundPreviewAndConfirmation() throws {
    XCTAssertThrowsError(try actionRequest(.configurationApply, confirmed: true))
    XCTAssertThrowsError(try actionRequest(.configurationApply, confirmed: false, previewToken: String(repeating: "a", count: 64)))
    let token = String(repeating: "a", count: 64)
    let request = try JSONSerialization.jsonObject(with: actionRequest(.configurationApply, confirmed: true, previewToken: token)) as? [String: Any]
    XCTAssertEqual(request?["previewToken"] as? String, token)
    XCTAssertEqual(request?["confirmation"] as? [String: Bool], ["replaceIntegration": true])
  }

  func testPreviewAndUpdateDecodePublicDataOnly() throws {
    let token = String(repeating: "b", count: 64)
    let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "ok": true, "code": "PREVIEW_READY", "data": ["schemaVersion": 1, "status": "ollama", "canApply": true, "requiresConfirmation": true, "changes": ["activate-pickermux"], "previewToken": token]])
    XCTAssertEqual(try CompanionResult.decode(data).preview?.previewToken, token)
    let update = Data(#"{"schemaVersion":1,"ok":true,"code":"UPDATE_AVAILABLE","data":{"status":"available","currentVersion":"0.8.3","targetVersion":"0.9.0"}}"#.utf8)
    XCTAssertEqual(try CompanionResult.decode(update).update?.targetVersion, "0.9.0")
    XCTAssertThrowsError(try CompanionResult.decode(Data(#"{"schemaVersion":2,"ok":true,"code":"OK"}"#.utf8)))
    XCTAssertThrowsError(try CompanionResult.decode(Data(#"{"schemaVersion":1,"ok":false,"code":"token=private"}"#.utf8)))
  }

  func testUnknownStatusDoesNotExposeRawContent() {
    XCTAssertEqual(statusLabel("/private/secret"), "Needs review")
    XCTAssertEqual(statusLabel("future-safe-token"), "Needs review")
  }

  func testRecoveryCompletionNoticeSurvivesCheckpointCleanupAndStaysQuietInitially() throws {
    let ready = try CompanionSnapshot.decode(snapshot())
    let pending = try CompanionSnapshot.decode(snapshot(["state": "recovery-pending", "recovery": ["status": "pending", "phase": "reactivated", "operationId": "f395a074-1550-4f7d-b749-1e911eb333b8"]]))
    XCTAssertFalse(shouldNotifyRecoveryCompletion(previous: nil, next: ready))
    XCTAssertFalse(shouldNotifyRecoveryCompletion(previous: ready, next: ready))
    XCTAssertFalse(shouldNotifyRecoveryCompletion(previous: pending, next: pending))
    XCTAssertTrue(shouldNotifyRecoveryCompletion(previous: pending, next: ready))
  }

  func testEnvironmentDropsCredentialAndCodexOverrides() {
    let environment = companionEnvironment(home: URL(fileURLWithPath: "/temporary/home"), temporaryDirectory: URL(fileURLWithPath: "/temporary/cache"))
    XCTAssertEqual(Set(environment.keys), Set(["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"]))
    XCTAssertFalse(environment["PATH"]!.contains(".local"))
    XCTAssertNil(environment["CODEX_HOME"])
    XCTAssertNil(environment["OPENAI_API_KEY"])
  }
}
