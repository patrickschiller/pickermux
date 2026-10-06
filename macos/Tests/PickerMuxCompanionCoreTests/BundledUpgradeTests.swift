import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class BundledUpgradeTests: XCTestCase {
  private func client(_ executor: UpgradeExecutor,
                      launcherResolver: (() throws -> URL)? = nil,
                      backendResolver: (() throws -> BackendInvocation)? = nil) -> PickerMuxClient {
    PickerMuxClient(executor: executor,
      launcherResolver: launcherResolver ?? { URL(fileURLWithPath: "/verified/installed/bin/pickermux.mjs") },
      backendResolver: backendResolver ?? { BackendInvocation(executable: URL(fileURLWithPath: "/verified/node"), leadingArguments: ["/verified/bundled/bin/pickermux.mjs"]) },
      nodeResolver: { URL(fileURLWithPath: "/verified/node") })
  }

  func testNewerAppKeepsStatusAndServiceRemovalActionsOnInstalledSource() async throws {
    let executor = UpgradeExecutor()
    let value = client(executor)
    let status = try await value.status()
    XCTAssertEqual(status.version, "0.9.5")
    XCTAssertFalse(status.usesBundledBackend)
    for action in [CompanionAction.refresh, .fullRefresh, .integrationDeactivate, .uninstallPreview, .uninstall] {
      _ = try await value.run(action, confirmed: true, previewToken: String(repeating: "b", count: 64))
    }
    XCTAssertEqual(executor.requests.map(\.source), Array(repeating: "installed", count: 5))
    XCTAssertEqual(executor.requests.map(\.action), ["refresh", "full-refresh", "integration-deactivate", "uninstall-preview", "uninstall"])
    XCTAssertEqual(executor.bundledStatusCalls, 0)
  }

  func testUpdateCheckAlwaysUsesPinnedPayloadRegardlessOfInstalledVersion() async throws {
    for installedVersion in ["0.9.5", "0.10.0", "0.11.0"] {
      let executor = UpgradeExecutor()
      executor.installedVersion = installedVersion
      let result = try await client(executor).checkUpdatesFromBundledBackend()
      XCTAssertEqual(result.update?.distribution, "dmg")
      XCTAssertEqual(result.update?.currentVersion, "0.10.0")
      XCTAssertEqual(executor.requests.map(\.source), ["bundled"])
      XCTAssertEqual(executor.requests.map(\.action), ["update-check"])
      XCTAssertEqual(executor.installedStatusCalls, 0)
    }
  }

  func testExplicitNewerBundledSetupRevalidatesBothSourcesAndUsesPinnedOnly() async throws {
    let executor = UpgradeExecutor()
    let setup = client(executor).bundledSetupClient(appVersion: "0.10.0")
    let status = try await setup.status()
    XCTAssertTrue(status.usesBundledBackend)
    XCTAssertEqual(status.version, "0.10.0")
    XCTAssertEqual(status.actions, [.configurationPreview, .configurationApply])
    let preview = try await setup.run(.configurationPreview, confirmed: false, previewToken: nil)
    _ = try await setup.run(.configurationApply, confirmed: true, previewToken: preview.preview?.previewToken)
    XCTAssertEqual(executor.requests.map(\.source), ["bundled", "bundled"])
    XCTAssertEqual(executor.requests.map(\.action), ["configuration-preview", "configuration-apply"])
    XCTAssertEqual(executor.installedStatusCalls, 3)
    XCTAssertEqual(executor.bundledStatusCalls, 3)
    XCTAssertEqual(executor.requests.last?.confirmed, true)
    XCTAssertEqual(executor.requests.last?.token, String(repeating: "b", count: 64))
  }

  func testBundledSetupCannotControlServicesRemovalOrOnlineActivation() async throws {
    let executor = UpgradeExecutor()
    let setup = client(executor).bundledSetupClient(appVersion: "0.10.0")
    for action in [CompanionAction.refresh, .fullRefresh, .open, .recover, .certify, .diagnose, .update, .updateCheck, .integrationDeactivate, .uninstallPreview, .uninstall] {
      do {
        _ = try await setup.run(action, confirmed: true, previewToken: String(repeating: "b", count: 64))
        XCTFail("A setup-only payload cannot run \(action)")
      } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
    }
    XCTAssertTrue(executor.requests.isEmpty)
    XCTAssertEqual(executor.installedStatusCalls, 0)
    XCTAssertEqual(executor.bundledStatusCalls, 0)
  }

  func testEqualDowngradeUnknownAndNoncanonicalVersionsCannotAuthorizeBundledSetup() async throws {
    for installedVersion in ["0.10.0", "0.11.0", "unknown", "0.9.5-beta", "00.9.5"] {
      let executor = UpgradeExecutor()
      executor.installedVersion = installedVersion
      do {
        _ = try await client(executor).bundledSetupClient(appVersion: "0.10.0")
          .run(.configurationApply, confirmed: true, previewToken: String(repeating: "b", count: 64))
        XCTFail("No newer-version proof exists for \(installedVersion)")
      } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
      XCTAssertTrue(executor.requests.isEmpty)
    }
    for appVersion in ["development", "0.10.0-beta", "00.10.0"] {
      let executor = UpgradeExecutor()
      do {
        _ = try await client(executor).bundledSetupClient(appVersion: appVersion).status()
        XCTFail("App version must be canonical")
      } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
      XCTAssertTrue(executor.requests.isEmpty)
    }
  }

  func testBundleMustMatchAppVersionAndBeTrustedBeforeSetupOrUpdateChecks() async throws {
    for bundledVersion in ["0.9.5", "0.11.0", "unknown", "0.10.0-beta"] {
      let executor = UpgradeExecutor()
      executor.bundledVersion = bundledVersion
      do {
        _ = try await client(executor).bundledSetupClient(appVersion: "0.10.0").status()
        XCTFail("Pinned version must match this app")
      } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
      XCTAssertTrue(executor.requests.isEmpty)
    }
    let executor = UpgradeExecutor()
    let rejected = client(executor, backendResolver: { throw CompanionFailure.unsafeLauncher })
    do {
      _ = try await rejected.bundledSetupClient(appVersion: "0.10.0").status()
      XCTFail("Unsafe bundle cannot authorize setup")
    } catch { XCTAssertEqual(error as? CompanionFailure, .unsafeLauncher) }
    do {
      _ = try await rejected.checkUpdatesFromBundledBackend()
      XCTFail("Unsafe bundle cannot run an update check")
    } catch { XCTAssertEqual(error as? CompanionFailure, .unsafeLauncher) }
    XCTAssertTrue(executor.requests.isEmpty)
  }

  func testUnverifiedOrMissingInstallationCannotUseUpgradeWrapper() async throws {
    let missing = UpgradeExecutor()
    missing.installed = false
    do {
      _ = try await client(missing).bundledSetupClient(appVersion: "0.10.0").status()
      XCTFail("An absent integration uses initial setup rather than backend upgrade")
    } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
    let unsafe = UpgradeExecutor()
    do {
      _ = try await client(unsafe, launcherResolver: { throw CompanionFailure.unsafeLauncher })
        .bundledSetupClient(appVersion: "0.10.0").status()
      XCTFail("Bundled fallback cannot prove an installed older version")
    } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
    XCTAssertTrue(missing.requests.isEmpty)
    XCTAssertTrue(unsafe.requests.isEmpty)
  }

  func testConcurrentInstalledUpgradeBlocksApplyAfterPreviewWithoutRetry() async throws {
    let executor = UpgradeExecutor()
    let setup = client(executor).bundledSetupClient(appVersion: "0.10.0")
    _ = try await setup.run(.configurationPreview, confirmed: false, previewToken: nil)
    executor.installedVersion = "0.10.0"
    do {
      _ = try await setup.run(.configurationApply, confirmed: true, previewToken: String(repeating: "b", count: 64))
      XCTFail("A concurrently upgraded installed version invalidates authorization")
    } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
    XCTAssertEqual(executor.requests.map(\.action), ["configuration-preview"])
  }

  func testMalformedBundledMutationNeverRetriesInstalledOrPinnedSource() async throws {
    let executor = UpgradeExecutor()
    executor.malformedApply = true
    do {
      _ = try await client(executor).bundledSetupClient(appVersion: "0.10.0")
        .run(.configurationApply, confirmed: true, previewToken: String(repeating: "b", count: 64))
      XCTFail("Malformed mutation output is indeterminate")
    } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
    XCTAssertEqual(executor.requests.map(\.source), ["bundled"])
    XCTAssertEqual(executor.requests.map(\.action), ["configuration-apply"])
  }

  @MainActor
  func testAutomaticReviewedUpgradeUsesPinnedSourceAndRevalidatesEveryPhase() async throws {
    let executor = UpgradeExecutor()
    let setup = client(executor).bundledSetupClient(appVersion: "0.10.0")
    var reviews = 0
    let outcome = try await changePickerMuxIntegration(true, reviewInstalledSetup: true, client: setup,
      consent: .automaticUpgradeReview) { review in
        reviews += 1
        XCTAssertFalse(review.text.contains("also enables"))
        return true
      }
    guard case .completed(let result) = outcome else { return XCTFail("The confirmed active upgrade should complete") }
    XCTAssertTrue(result.ok)
    XCTAssertEqual(reviews, 1)
    XCTAssertEqual(executor.requests.map(\.source), ["bundled", "bundled"])
    XCTAssertEqual(executor.requests.map(\.action), ["configuration-preview", "configuration-apply"])
    XCTAssertEqual(executor.installedStatusCalls, 5)
    XCTAssertEqual(executor.bundledStatusCalls, 5)
    XCTAssertEqual(executor.requests.last?.token, String(repeating: "b", count: 64))
  }

  @MainActor
  func testAutomaticReviewConcurrentUpgradeAndMalformedApplyNeverRetry() async throws {
    for failure in ["concurrent", "malformed"] {
      let executor = UpgradeExecutor()
      let setup = client(executor).bundledSetupClient(appVersion: "0.10.0")
      do {
        _ = try await changePickerMuxIntegration(true, reviewInstalledSetup: true, client: setup,
          consent: .automaticUpgradeReview) { _ in
            if failure == "concurrent" { executor.installedVersion = "0.10.0" }
            else { executor.malformedApply = true }
            return true
          }
        XCTFail("A concurrent or indeterminate mutation cannot report success")
      } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
      XCTAssertEqual(executor.requests.map(\.source), failure == "concurrent" ? ["bundled"] : ["bundled", "bundled"])
      XCTAssertEqual(executor.requests.map(\.action), failure == "concurrent" ? ["configuration-preview"] : ["configuration-preview", "configuration-apply"])
    }
  }
}

private final class UpgradeExecutor: CompanionExecuting {
  struct Request {
    let source: String
    let action: String
    let confirmed: Bool
    let token: String?
  }
  var installedVersion = "0.9.5"
  var bundledVersion = "0.10.0"
  var installed = true
  var malformedApply = false
  var installedStatusCalls = 0
  var bundledStatusCalls = 0
  var requests = [Request]()

  func run(executable: URL, arguments: [String], input: Data?, environment: [String: String], timeout: TimeInterval) async throws -> ProcessOutput {
    if arguments == ["--version"] { return ProcessOutput(stdout: Data("v22.15.0\n".utf8), exitCode: 0) }
    let bundled = arguments.first == "/verified/bundled/bin/pickermux.mjs"
    if arguments.last == "status" {
      if bundled { bundledStatusCalls += 1 } else { installedStatusCalls += 1 }
      let snapshot: [String: Any] = [
        "schemaVersion": 1, "capabilities": ["integration-toggle-v1", "native-uninstall-v1"],
        "version": bundled ? bundledVersion : installedVersion, "state": "ready", "desktop": ["status": "stopped"],
        "installation": ["status": installed ? "installed" : "not-installed"], "managedConfig": ["status": "installed"],
        "service": ["status": "running"], "compatibility": ["status": "compatible"], "accountCache": ["status": "ready"],
        "recovery": ["status": "idle"], "integration": ["status": "pickermux"],
        "actions": ["configuration-preview", "configuration-apply", "update-check", "refresh", "full-refresh", "integration-deactivate", "uninstall-preview", "uninstall"], "issues": [],
      ]
      return ProcessOutput(stdout: try JSONSerialization.data(withJSONObject: snapshot), exitCode: 0)
    }
    let request = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(input)) as? [String: Any])
    let action = try XCTUnwrap(request["action"] as? String)
    requests.append(Request(source: bundled ? "bundled" : "installed", action: action,
      confirmed: (request["confirmation"] as? [String: Bool])?["replaceIntegration"] == true,
      token: request["previewToken"] as? String))
    if malformedApply && action == "configuration-apply" { return ProcessOutput(stdout: Data("not-json".utf8), exitCode: 0) }
    var fields: [String: Any]?
    switch action {
    case "update-check":
      fields = ["action": action, "status": "available", "currentVersion": bundledVersion, "targetVersion": "0.11.0", "distribution": "dmg"]
    case "configuration-preview":
      fields = ["status": "pickermux", "canApply": true, "requiresConfirmation": true, "changes": ["activate-integration"], "previewToken": String(repeating: "b", count: 64)]
    case "uninstall-preview":
      fields = ["action": action, "status": "ready", "canApply": true, "previewToken": String(repeating: "b", count: 64), "changes": UninstallPreview.expectedChanges]
    case "uninstall":
      fields = ["action": action, "status": "removed", "removed": true, "nativeRestored": true, "historicalChatsPreserved": true, "restartRequired": true]
    case "full-refresh":
      fields = ["action": action, "started": true, "resumed": false, "operationId": "1804ad9d-4eb2-43f4-95e5-a3b5a1f4b9da"]
    default: break
    }
    var envelope: [String: Any] = ["schemaVersion": 1, "ok": true, "code": "COMPLETE"]
    if let fields { envelope["data"] = fields }
    return ProcessOutput(stdout: try JSONSerialization.data(withJSONObject: envelope), exitCode: 0)
  }
}
