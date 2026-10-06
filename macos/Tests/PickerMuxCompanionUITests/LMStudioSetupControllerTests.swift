import Foundation
import XCTest
@testable import PickerMuxCompanion
@testable import PickerMuxCompanionCore

@MainActor
final class LMStudioSetupControllerTests: XCTestCase {
  func testConfirmedSetupRefreshesExternalStatusAndShowsRestartGuidance() async throws {
    let executor = LMStudioControllerExecutor()
    var reviews = 0
    let client = PickerMuxClient(executor: executor,
      launcherResolver: { URL(fileURLWithPath: "/verified/installed/bin/pickermux.mjs") },
      backendResolver: { BackendInvocation(executable: URL(fileURLWithPath: "/verified/node"), leadingArguments: ["/verified/bundled/bin/pickermux.mjs"]) },
      nodeResolver: { URL(fileURLWithPath: "/verified/node") })
    let controller = CompanionController(pollingEnabled: false, client: client, appVersion: "0.30.0",
      lmStudioSetupConfirmation: { review in
        reviews += 1
        XCTAssertEqual(review.button, "Enable LM Studio")
        return true
      })
    await controller.refreshStatus()
    XCTAssertEqual(controller.snapshot?.providerConfiguration?.status, ProviderConfigurationKind.nativeOnly)
    controller.enableLMStudioModels()
    await settle(controller)

    XCTAssertEqual(reviews, 1)
    XCTAssertEqual(executor.requests.map(\.action), ["lmstudio-default-preview", "lmstudio-default-apply"])
    XCTAssertEqual(executor.requests.last?.confirmation, ["enableBundledLmStudio": true])
    XCTAssertEqual(executor.requests.last?.token, String(repeating: "c", count: 64))
    XCTAssertEqual(controller.snapshot?.providerConfiguration?.status, ProviderConfigurationKind.external)
    XCTAssertFalse(controller.operationFailed)
    XCTAssertTrue(controller.operationNotice?.contains("reopen Codex") == true)
  }

  private func settle(_ controller: CompanionController, file: StaticString = #filePath, line: UInt = #line) async {
    for _ in 0..<2000 {
      if controller.busy == nil && controller.snapshot?.providerConfiguration?.status == .external { return }
      await Task.yield()
    }
    XCTFail("The injected provider setup should finish", file: file, line: line)
  }
}

private final class LMStudioControllerExecutor: CompanionExecuting {
  struct Request {
    let action: String
    let confirmation: [String: Bool]?
    let token: String?
  }

  var configured = false
  var requests = [Request]()

  func run(executable: URL, arguments: [String], input: Data?, environment: [String: String],
           timeout: TimeInterval) async throws -> ProcessOutput {
    if arguments == ["--version"] {
      return ProcessOutput(stdout: Data("v22.15.0\n".utf8), exitCode: 0)
    }
    if arguments.last == "status" {
      return ProcessOutput(stdout: try status(), exitCode: 0)
    }
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(input)) as? [String: Any])
    let action = try XCTUnwrap(object["action"] as? String)
    requests.append(Request(action: action, confirmation: object["confirmation"] as? [String: Bool],
      token: object["previewToken"] as? String))
    let data: [String: Any]
    if action == "lmstudio-default-preview" {
      data = [
        "action": action, "status": "native-only", "canApply": true,
        "requiresConfirmation": true, "changes": LMStudioDefaultPreview.expectedChanges,
        "previewToken": String(repeating: "c", count: 64),
      ]
    } else if action == "lmstudio-default-apply" {
      configured = true
      data = [
        "action": action, "status": "applied", "updated": true, "restartRequired": true,
        "certificationIncomplete": false, "version": "0.30.0",
      ]
    } else {
      throw CompanionFailure.incompatibleProtocol
    }
    return ProcessOutput(stdout: try JSONSerialization.data(withJSONObject: [
      "schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": data,
    ]), exitCode: 0)
  }

  private func status() throws -> Data {
    let actions = configured ? [] : ["lmstudio-default-preview", "lmstudio-default-apply"]
    return try JSONSerialization.data(withJSONObject: [
      "schemaVersion": 1, "version": "0.30.0", "state": "ready",
      "capabilities": ["integration-toggle-v1", "native-uninstall-v1",
        "native-only-lmstudio-setup-v1", "token-usage-v1"],
      "desktop": ["status": "stopped"], "installation": ["status": "installed"],
      "managedConfig": ["status": "installed"], "service": ["status": "running"],
      "compatibility": ["status": "compatible"], "accountCache": ["status": "ready"],
      "recovery": ["status": "idle"], "integration": ["status": "pickermux"],
      "providerConfiguration": ["status": configured ? "external" : "native-only"],
      "actions": actions, "issues": [],
      "tokenUsage": ["schemaVersion": 1, "status": "unavailable", "providers": []],
    ])
  }
}
