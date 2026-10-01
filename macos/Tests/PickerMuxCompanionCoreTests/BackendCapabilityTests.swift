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

  func testBundledBackendCannotDeactivateAnOlderInstalledBridge() async throws {
    let executor = CapabilityExecutor()
    do {
      _ = try await client(executor).run(.integrationDeactivate, confirmed: true)
      XCTFail("Bundled source must not deactivate another active backend")
    } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
    XCTAssertTrue(executor.mutations.isEmpty)
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
}

private final class CapabilityExecutor: CompanionExecuting {
  var installedCapabilities: [String]?
  var malformedMutation = false
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
        "actions": ["configuration-preview", "configuration-apply", "integration-deactivate"], "issues": [],
      ]
      if arguments.first == "/verified/current/bin/pickermux.mjs" { snapshot["capabilities"] = ["integration-toggle-v1"] }
      else if let capabilities = installedCapabilities { snapshot["capabilities"] = capabilities }
      if installedCapabilities == ["integration-toggle-v1", "native-uninstall-v1"] {
        snapshot["actions"] = ["configuration-preview", "configuration-apply", "integration-deactivate", "uninstall-preview", "uninstall"]
      }
      return ProcessOutput(stdout: try JSONSerialization.data(withJSONObject: snapshot), exitCode: 0)
    }
    mutations.append(arguments)
    if let input, let request = try JSONSerialization.jsonObject(with: input) as? [String: Any] { requests.append(request) }
    return ProcessOutput(stdout: Data((malformedMutation ? "not-json" : #"{"schemaVersion":1,"ok":true,"code":"COMPLETE"}"#).utf8), exitCode: 0)
  }
}
