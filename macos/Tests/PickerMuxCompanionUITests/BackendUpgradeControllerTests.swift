import Foundation
import XCTest
@testable import PickerMuxCompanionCore
@testable import PickerMuxCompanion

@MainActor
final class BackendUpgradeControllerTests: XCTestCase {
  func testNewAppWaitsForCodexToCloseThenOffersOneConfirmedPinnedUpgrade() async throws {
    let executor = BackendUpdateExecutor()
    executor.desktop = "running"
    var reviews = 0
    let controller = controller(executor) { review in
      reviews += 1
      XCTAssertTrue(review.text.contains("certification"))
      return true
    }
    await controller.refreshStatus()
    XCTAssertTrue(controller.backendUpgradeAvailable)
    XCTAssertEqual(reviews, 0)
    XCTAssertTrue(executor.requests.isEmpty)

    executor.desktop = "stopped"
    await controller.refreshStatus()
    await settle(controller)
    await controller.refreshStatus(manual: true)
    XCTAssertEqual(reviews, 1)
    XCTAssertEqual(executor.requests.map(\.action), ["configuration-preview", "configuration-apply"])
    XCTAssertEqual(executor.requests.map(\.source), ["bundled", "bundled"])
    XCTAssertEqual(executor.requests.last?.confirmed, true)
    XCTAssertEqual(executor.requests.last?.token, String(repeating: "b", count: 64))
    XCTAssertEqual(controller.snapshot?.version, "0.22.1")
    XCTAssertFalse(controller.backendUpgradeAvailable)
    XCTAssertFalse(controller.operationFailed)
  }

  func testCancelledAutomaticOfferDoesNotRepeatButConfigCanRetry() async throws {
    let executor = BackendUpdateExecutor()
    var accepted = false
    var reviews = 0
    let controller = controller(executor) { _ in reviews += 1; return accepted }
    await controller.refreshStatus()
    await settle(controller)
    for _ in 0..<3 { await controller.refreshStatus(manual: true) }
    XCTAssertEqual(reviews, 1)
    XCTAssertEqual(executor.requests.map(\.action), ["configuration-preview"])
    XCTAssertTrue(controller.backendUpgradeAvailable)
    XCTAssertTrue(controller.operationNotice?.contains("cancelled") == true)

    accepted = true
    controller.setIntegrationEnabled(true, reviewInstalledSetup: true)
    await settle(controller)
    await controller.refreshStatus(manual: true)
    XCTAssertEqual(reviews, 2)
    XCTAssertEqual(executor.requests.map(\.action), ["configuration-preview", "configuration-preview", "configuration-apply"])
    XCTAssertEqual(controller.snapshot?.version, "0.22.1")
  }

  func testFailedApplyRetainsOlderBackendAndDoesNotAutomaticallyRetry() async throws {
    let executor = BackendUpdateExecutor()
    executor.applyFailure = true
    var reviews = 0
    let controller = controller(executor) { _ in reviews += 1; return true }
    await controller.refreshStatus()
    await settle(controller)
    for _ in 0..<3 { await controller.refreshStatus(manual: true) }
    XCTAssertEqual(reviews, 1)
    XCTAssertTrue(controller.operationFailed)
    XCTAssertTrue(controller.lastSetupFailed)
    XCTAssertEqual(controller.snapshot?.version, "0.22.0")
    XCTAssertEqual(executor.requests.map(\.action), ["configuration-preview", "configuration-apply"])
  }

  func testDisabledIntegrationIsNeverAutomaticallyEnabled() async throws {
    let executor = BackendUpdateExecutor()
    executor.active = false
    let controller = controller(executor) { _ in XCTFail("An off integration must stay off"); return true }
    await controller.refreshStatus()
    XCTAssertTrue(controller.backendUpgradeAvailable)
    XCTAssertNil(controller.busy)
    XCTAssertTrue(executor.requests.isEmpty)
    XCTAssertFalse(controller.integrationState.isEnabled)
  }

  func testManualReviewConsumesTheAutomaticOfferForTheSameSession() async throws {
    let executor = BackendUpdateExecutor()
    executor.desktop = "running"
    var reviews = 0
    let controller = controller(executor) { _ in reviews += 1; return false }
    await controller.refreshStatus()
    executor.desktop = "stopped"
    controller.snapshot = try executor.snapshot(bundled: false)
    controller.setIntegrationEnabled(true, reviewInstalledSetup: true)
    await settle(controller)
    await controller.refreshStatus(manual: true)
    XCTAssertEqual(reviews, 1)
    XCTAssertEqual(executor.requests.map(\.action), ["configuration-preview"])
  }

  func testBusyControllerDefersTheOfferAndRemovalSuppressesIt() async throws {
    let executor = BackendUpdateExecutor()
    var reviews = 0
    let controller = controller(executor) { _ in reviews += 1; return false }
    controller.busy = .diagnose
    await controller.refreshStatus(manual: true)
    XCTAssertEqual(reviews, 0)
    XCTAssertTrue(executor.requests.isEmpty)
    controller.busy = nil
    controller.removalState = .reviewing
    await controller.refreshStatus()
    XCTAssertEqual(reviews, 0)
    XCTAssertTrue(executor.requests.isEmpty)
    controller.removalState = .idle
    await controller.refreshStatus()
    await settle(controller)
    XCTAssertEqual(reviews, 1)
    XCTAssertEqual(executor.requests.map(\.action), ["configuration-preview"])
  }

  private func controller(_ executor: BackendUpdateExecutor,
                          confirm: @escaping @MainActor (IntegrationReview) async -> Bool) -> CompanionController {
    let client = PickerMuxClient(executor: executor,
      launcherResolver: { URL(fileURLWithPath: "/verified/installed/bin/pickermux.mjs") },
      backendResolver: { BackendInvocation(executable: URL(fileURLWithPath: "/verified/node"), leadingArguments: ["/verified/bundled/bin/pickermux.mjs"]) },
      nodeResolver: { URL(fileURLWithPath: "/verified/node") })
    return CompanionController(pollingEnabled: false, client: client, appVersion: "0.22.1", integrationConfirmation: confirm)
  }

  private func settle(_ controller: CompanionController, file: StaticString = #filePath, line: UInt = #line) async {
    for _ in 0..<1000 {
      if controller.busy == nil { return }
      await Task.yield()
    }
    XCTFail("The injected upgrade should finish", file: file, line: line)
  }
}

private final class BackendUpdateExecutor: CompanionExecuting {
  struct Request {
    let source: String
    let action: String
    let confirmed: Bool
    let token: String?
  }
  var desktop = "stopped"
  var installedVersion = "0.22.0"
  var active = true
  var applyFailure = false
  var requests = [Request]()

  func snapshot(bundled: Bool) throws -> CompanionSnapshot {
    try CompanionSnapshot.decode(statusData(bundled: bundled))
  }

  private func statusData(bundled: Bool) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
      "schemaVersion": 1, "version": bundled ? "0.22.1" : installedVersion,
      "capabilities": ["integration-toggle-v1"], "state": active ? "ready" : "inactive",
      "desktop": ["status": desktop], "installation": ["status": "installed"],
      "managedConfig": ["status": active ? "installed" : "deactivated"],
      "service": ["status": active ? "running" : "stopped"],
      "compatibility": ["status": "compatible"], "accountCache": ["status": "ready"],
      "recovery": ["status": "idle"], "integration": ["status": active ? "pickermux" : "none"],
      "actions": ["configuration-preview", "configuration-apply", "integration-deactivate"], "issues": [],
    ])
  }

  func run(executable: URL, arguments: [String], input: Data?, environment: [String: String], timeout: TimeInterval) async throws -> ProcessOutput {
    if arguments == ["--version"] { return ProcessOutput(stdout: Data("v22.15.0\n".utf8), exitCode: 0) }
    let bundled = arguments.first == "/verified/bundled/bin/pickermux.mjs"
    if arguments.last == "status" { return ProcessOutput(stdout: try statusData(bundled: bundled), exitCode: 0) }
    let request = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(input)) as? [String: Any])
    let action = try XCTUnwrap(request["action"] as? String)
    requests.append(Request(source: bundled ? "bundled" : "installed", action: action,
      confirmed: (request["confirmation"] as? [String: Bool])?["replaceIntegration"] == true,
      token: request["previewToken"] as? String))
    var result: [String: Any] = ["schemaVersion": 1, "ok": true, "code": "COMPLETE"]
    if action == "configuration-preview" {
      result["data"] = ["status": active ? "pickermux" : "none", "canApply": true,
        "requiresConfirmation": true, "changes": ["activate-integration"], "previewToken": String(repeating: "b", count: 64)]
    } else if action == "configuration-apply" {
      if applyFailure { result["ok"] = false; result["code"] = "PREVIEW_STALE" }
      else { installedVersion = "0.22.1" }
    } else { XCTFail("Unexpected action \(action)") }
    return ProcessOutput(stdout: try JSONSerialization.data(withJSONObject: result), exitCode: 0)
  }
}
