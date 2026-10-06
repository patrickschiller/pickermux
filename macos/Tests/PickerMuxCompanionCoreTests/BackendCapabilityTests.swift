import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class BackendCapabilityTests: XCTestCase {
  private func client(_ executor: CapabilityExecutor) -> PickerMuxClient {
    PickerMuxClient(executor: executor,
      launcherResolver: { URL(fileURLWithPath: "/verified/old/bin/pickermux.mjs") },
      backendResolver: { BackendInvocation(executable: URL(fileURLWithPath: "/verified/node"), leadingArguments: ["/verified/current/bin/pickermux.mjs"]) },
      nodeResolver: { URL(fileURLWithPath: "/verified/node") })
  }

  func testSameVersionLegacyBackendUsesPinnedSetupBeforeAnyMutation() async throws {
    let executor = CapabilityExecutor()
    let value = client(executor)
    let status = try await value.status()
    XCTAssertEqual(status.version, "0.9.0")
    XCTAssertTrue(status.usesBundledBackend)
    XCTAssertTrue(status.actions.contains(.configurationApply))
    XCTAssertFalse(status.actions.contains(.integrationDeactivate))
    _ = try await value.run(.configurationApply, confirmed: true, previewToken: String(repeating: "c", count: 64))
    XCTAssertEqual(executor.mutations, [["/verified/current/bin/pickermux.mjs", "companion", "run"]])
    XCTAssertEqual(executor.requests.last?["action"] as? String, "configuration-apply")
    XCTAssertEqual(executor.requests.last?["confirmation"] as? [String: Bool], ["replaceIntegration": true])
  }

  func testBundledBackendCannotControlAnOlderInstalledBridgeOrRunFullRefresh() async throws {
    let executor = CapabilityExecutor()
    for action in [CompanionAction.integrationDeactivate, .fullRefresh] {
      do {
        _ = try await client(executor).run(action, confirmed: true)
        XCTFail("Bundled source must not control another active backend with \(action)")
      } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
    }
    XCTAssertTrue(executor.mutations.isEmpty)
  }

  func testInstalledFullRefreshRequiresItsExactStartReceipt() async throws {
    for receiptAction in [nil, "recover"] as [String?] {
      let executor = CapabilityExecutor()
      executor.installedCapabilities = ["integration-toggle-v1"]
      executor.fullRefreshReceiptAction = receiptAction
      do {
        _ = try await client(executor).run(.fullRefresh, confirmed: true)
        XCTFail("A generic or mismatched success cannot prove full refresh started")
      } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
      XCTAssertEqual(executor.mutations.count, 1)
    }

    let executor = CapabilityExecutor()
    executor.installedCapabilities = ["integration-toggle-v1"]
    executor.fullRefreshReceiptAction = "full-refresh"
    let result = try await client(executor).run(.fullRefresh, confirmed: true)
    XCTAssertEqual(result.recoveryStart?.action, "full-refresh")
    XCTAssertEqual(result.recoveryStart?.operationId, "1804ad9d-4eb2-43f4-95e5-a3b5a1f4b9da")
  }

  func testMalformedPinnedMutationNeverRetriesAnyBackend() async throws {
    let executor = CapabilityExecutor()
    executor.malformedMutation = true
    do {
      _ = try await client(executor).run(.configurationApply, confirmed: true, previewToken: String(repeating: "c", count: 64))
      XCTFail("Malformed mutation output must fail")
    } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
    XCTAssertEqual(executor.mutations.count, 1)
    XCTAssertEqual(executor.mutations.first?.first, "/verified/current/bin/pickermux.mjs")
  }

  func testCurrentInstalledMarkerKeepsDeactivationOnVerifiedInstalledBackend() async throws {
    let executor = CapabilityExecutor()
    executor.installedCapabilities = ["integration-toggle-v1"]
    let value = client(executor)
    let status = try await value.status()
    XCTAssertFalse(status.usesBundledBackend)
    _ = try await value.run(.integrationDeactivate, confirmed: true)
    XCTAssertEqual(executor.mutations, [["/verified/old/bin/pickermux.mjs", "companion", "run"]])
    XCTAssertEqual(executor.requests.last?["confirmation"] as? [String: Bool], ["deactivateIntegration": true])
  }

  func testUninstallCannotUseBundledFallbackOrLegacyInstalledProtocol() async throws {
    for installed in [nil, ["integration-toggle-v1"]] as [[String]?] {
      let executor = CapabilityExecutor()
      executor.installedCapabilities = installed
      for action in [CompanionAction.uninstallPreview, .uninstall] {
        do {
          _ = try await client(executor).run(action, confirmed: true, previewToken: String(repeating: "b", count: 64))
          XCTFail("A bootstrap or older installed source cannot remove the installation")
        } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
      }
      XCTAssertTrue(executor.mutations.isEmpty)
    }
  }

  func testRemovalUsesOnlyVerifiedInstalledSourceAndNeverRetriesMalformedSuccess() async throws {
    let executor = CapabilityExecutor()
    executor.installedCapabilities = ["integration-toggle-v1", "native-uninstall-v1"]
    executor.malformedMutation = true
    do {
      _ = try await client(executor).run(.uninstall, confirmed: true, previewToken: String(repeating: "b", count: 64))
      XCTFail("Malformed removal is indeterminate and cannot be retried")
    } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
    XCTAssertEqual(executor.mutations, [["/verified/old/bin/pickermux.mjs", "companion", "run"]])
    XCTAssertEqual(executor.requests.last?["action"] as? String, "uninstall")
  }

  func testGenericSuccessCannotProveRemoval() async throws {
    let executor = CapabilityExecutor()
    executor.installedCapabilities = ["integration-toggle-v1", "native-uninstall-v1"]
    do {
      _ = try await client(executor).run(.uninstall, confirmed: true, previewToken: String(repeating: "b", count: 64))
      XCTFail("Only a full removal receipt can be accepted")
    } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
    XCTAssertEqual(executor.mutations.count, 1)
  }

  func testNativeOnlySetupUsesVerifiedInstalledSourceAndExactReceipts() async throws {
    let executor = CapabilityExecutor()
    executor.installedCapabilities = ["integration-toggle-v1", "native-uninstall-v1",
      "native-only-lmstudio-setup-v1", "token-usage-v1"]
    executor.validProviderReceipts = true
    let value = client(executor)
    let preview = try await value.run(.lmStudioDefaultPreview)
    let token = try XCTUnwrap(preview.lmStudioDefaultPreview?.previewToken)
    let applied = try await value.run(.lmStudioDefaultApply, confirmed: true, previewToken: token)
    XCTAssertTrue(try XCTUnwrap(applied.lmStudioDefaultApply?.updated))
    XCTAssertEqual(executor.mutations.map(\.first), [
      "/verified/old/bin/pickermux.mjs", "/verified/old/bin/pickermux.mjs",
    ])
    XCTAssertEqual(executor.requests.map { $0["action"] as? String },
      ["lmstudio-default-preview", "lmstudio-default-apply"])
    XCTAssertEqual(executor.requests.last?["confirmation"] as? [String: Bool],
      ["enableBundledLmStudio": true])
  }

  func testNativeOnlySetupRejectsGenericSuccessAndBundledFallback() async throws {
    for action in [CompanionAction.lmStudioDefaultPreview, .lmStudioDefaultApply] {
      let executor = CapabilityExecutor()
      executor.installedCapabilities = ["integration-toggle-v1", "native-uninstall-v1",
        "native-only-lmstudio-setup-v1", "token-usage-v1"]
      do {
        _ = try await client(executor).run(action, confirmed: action == .lmStudioDefaultApply,
          previewToken: action == .lmStudioDefaultApply ? String(repeating: "c", count: 64) : nil)
        XCTFail("Generic success cannot attest \(action)")
      } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
      XCTAssertEqual(executor.mutations.count, 1)
    }

    let fallback = CapabilityExecutor()
    do {
      _ = try await client(fallback).run(.lmStudioDefaultPreview)
      XCTFail("A bundled fallback must not configure providers")
    } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
    XCTAssertTrue(fallback.mutations.isEmpty)
  }
}

private final class CapabilityExecutor: CompanionExecuting {
  var installedCapabilities: [String]?
  var malformedMutation = false
  var fullRefreshReceiptAction: String?
  var validProviderReceipts = false
  var mutations = [[String]]()
  var requests = [[String: Any]]()

  func run(executable: URL, arguments: [String], input: Data?, environment: [String: String], timeout: TimeInterval) async throws -> ProcessOutput {
    if arguments == ["--version"] { return ProcessOutput(stdout: Data("v22.15.0\n".utf8), exitCode: 0) }
    if arguments.last == "status" {
      var snapshot: [String: Any] = [
        "schemaVersion": 1, "version": "0.9.0", "state": "ready",
        "desktop": ["status": "stopped"], "installation": ["status": "installed"],
        "managedConfig": ["status": "installed"], "service": ["status": "running"],
        "compatibility": ["status": "compatible"], "accountCache": ["status": "ready"],
        "recovery": ["status": "idle"], "integration": ["status": "pickermux"],
        "actions": ["configuration-preview", "configuration-apply", "full-refresh", "integration-deactivate"], "issues": [],
      ]
      if arguments.first == "/verified/current/bin/pickermux.mjs" { snapshot["capabilities"] = ["integration-toggle-v1"] }
      else if let capabilities = installedCapabilities { snapshot["capabilities"] = capabilities }
      if let capabilities = snapshot["capabilities"] as? [String], capabilities.contains("native-only-lmstudio-setup-v1") {
        snapshot["providerConfiguration"] = ["status": "native-only"]
        snapshot["tokenUsage"] = ["schemaVersion": 1, "status": "unavailable", "providers": []]
        snapshot["actions"] = ["configuration-preview", "configuration-apply", "full-refresh", "integration-deactivate",
          "lmstudio-default-preview", "lmstudio-default-apply"]
      }
      if installedCapabilities == ["integration-toggle-v1", "native-uninstall-v1"] {
        snapshot["actions"] = ["configuration-preview", "configuration-apply", "integration-deactivate", "uninstall-preview", "uninstall"]
      }
      return ProcessOutput(stdout: try JSONSerialization.data(withJSONObject: snapshot), exitCode: 0)
    }
    mutations.append(arguments)
    if let input, let request = try JSONSerialization.jsonObject(with: input) as? [String: Any] { requests.append(request) }
    if malformedMutation { return ProcessOutput(stdout: Data("not-json".utf8), exitCode: 0) }
    var envelope: [String: Any] = ["schemaVersion": 1, "ok": true, "code": "COMPLETE"]
    if requests.last?["action"] as? String == "full-refresh", let action = fullRefreshReceiptAction {
      envelope["data"] = [
        "action": action, "started": true, "resumed": false,
        "operationId": "1804ad9d-4eb2-43f4-95e5-a3b5a1f4b9da",
      ]
    }
    if validProviderReceipts, requests.last?["action"] as? String == "lmstudio-default-preview" {
      envelope["data"] = [
        "action": "lmstudio-default-preview", "status": "native-only", "canApply": true,
        "requiresConfirmation": true, "changes": LMStudioDefaultPreview.expectedChanges,
        "previewToken": String(repeating: "c", count: 64),
      ]
    }
    if validProviderReceipts, requests.last?["action"] as? String == "lmstudio-default-apply" {
      envelope["data"] = [
        "action": "lmstudio-default-apply", "status": "applied", "updated": true,
        "restartRequired": true, "certificationIncomplete": false, "version": "0.30.0",
      ]
    }
    return ProcessOutput(stdout: try JSONSerialization.data(withJSONObject: envelope), exitCode: 0)
  }
}
