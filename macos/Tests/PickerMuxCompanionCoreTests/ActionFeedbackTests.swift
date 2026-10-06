import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class ActionFeedbackTests: XCTestCase {
  private func result(_ data: [String: Any] = [:], ok: Bool = true, code: String = "COMPLETE") throws -> CompanionResult {
    try CompanionResult.decode(JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "ok": ok, "code": code, "data": data]))
  }

  func testCompletedActionsGiveSpecificFeedbackAndHonorRestartAndIncompleteFlags() throws {
    let completed = try result()
    let actions: [CompanionAction] = [.refresh, .open, .diagnose, .certify, .configurationApply, .integrationDeactivate]
    let messages = actions.map { companionActionResultMessage(completed, action: $0) }
    XCTAssertEqual(Set(messages).count, actions.count)
    XCTAssertTrue(companionActionResultMessage(completed, action: .diagnose).contains("checks passed"))
    for action in [CompanionAction.fullRefresh, .recover] {
      let started = try result([
        "action": action.rawValue, "started": true, "resumed": false,
        "operationId": "1804ad9d-4eb2-43f4-95e5-a3b5a1f4b9da",
      ])
      XCTAssertTrue(companionActionResultMessage(started, action: action).contains("Config"))
      XCTAssertTrue(companionActionResultMessage(completed, action: action).contains("could not complete"))
    }
    XCTAssertFalse(companionActionResultMessage(completed, action: .refresh).contains("Reopen"))
    XCTAssertTrue(companionActionResultMessage(try result(["restartRequired": true]), action: .refresh).contains("Reopen Codex"))
    for action in [.configurationApply, .certify] as [CompanionAction] {
      let message = companionActionResultMessage(try result(["certificationIncomplete": true]), action: action)
      XCTAssertTrue(message.contains("incomplete"))
      XCTAssertTrue(message.contains("retry"))
      XCTAssertFalse(message.contains("completed"))
    }
    let lmStudio = try result([
      "action": "lmstudio-default-apply", "status": "applied", "updated": true,
      "restartRequired": true, "certificationIncomplete": false, "version": "0.30.0",
    ])
    let lmStudioMessage = companionActionResultMessage(lmStudio, action: .lmStudioDefaultApply)
    XCTAssertTrue(lmStudioMessage.contains("enabled"))
    XCTAssertTrue(lmStudioMessage.contains("reopen Codex"))
  }

  func testFailedActionNeverReportsSuccessOrDisplaysUntrustedCodes() throws {
    for action in CompanionAction.allCases {
      let message = companionActionResultMessage(try result(ok: false, code: "secret_canary"), action: action)
      XCTAssertFalse(message.contains("secret_canary"))
      XCTAssertFalse(message.contains("checks passed"))
      XCTAssertTrue(message.contains("could not complete"))
    }
  }

  func testUsageResetRequiresItsExactConsentAndRejectsPreviewReuse() throws {
    XCTAssertThrowsError(try actionRequest(.usageReset))
    XCTAssertThrowsError(try actionRequest(.usageReset, confirmed: true, previewToken: String(repeating: "a", count: 64)))
    let request = try XCTUnwrap(JSONSerialization.jsonObject(with: actionRequest(.usageReset, confirmed: true)) as? [String: Any])
    XCTAssertEqual(Set(request.keys), Set(["schemaVersion", "action", "confirmation"]))
    XCTAssertEqual(request["action"] as? String, "usage-reset")
    XCTAssertEqual(request["confirmation"] as? [String: Bool], ["resetAccumulatedUsage": true])
  }

  func testUsageResetCompletionCannotHideMalformedOrUnexpectedFields() throws {
    let base: [String: Any] = ["action": "usage-reset", "status": "reset", "resetAt": "2026-10-02T18:04:05.123Z", "lastRequestPreserved": true]
    let completed = try result(base)
    XCTAssertEqual(completed.usageReset?.resetAt, "2026-10-02T18:04:05.123Z")
    XCTAssertTrue(companionActionResultMessage(completed, action: .usageReset).contains("Last model request is unchanged"))
    for changes in [
      ["action": "foreign"], ["status": "pending"], ["resetAt": "invalid"], ["lastRequestPreserved": false],
      ["extra": "/private/canary"], ["resetAt": NSNull()], ["lastRequestPreserved": "true"],
    ] as [[String: Any]] {
      var bad = base
      bad.merge(changes) { _, value in value }
      XCTAssertThrowsError(try result(bad))
    }
    for field in base.keys {
      var missing = base
      missing.removeValue(forKey: field)
      XCTAssertThrowsError(try result(missing))
    }
    XCTAssertThrowsError(try result(base, ok: false))
  }
}
