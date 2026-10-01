import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class BundledBackendTests: XCTestCase {
  func fixture() throws -> (directory: URL, hash: String) {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pickermux-bundled-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory.appendingPathComponent("bin"), withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    var files: [[String: Any]] = []
    for name in ["bin/pickermux.mjs", "package.json", "lmstudio-picker.config.json", "LICENSE"] {
      let data = Data("fixture: \(name)".utf8)
      let target = directory.appendingPathComponent(name)
      try data.write(to: target)
      XCTAssertEqual(chmod(target.path, 0o644), 0)
      files.append(["path": name, "size": data.count, "sha256": digest(data), "mode": "0644"])
    }
    let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "name": "pickermux", "version": "0.9.0", "files": files])
    let manifest = directory.appendingPathComponent("release-manifest.json")
    try data.write(to: manifest)
    XCTAssertEqual(chmod(manifest.path, 0o644), 0)
    return (directory, digest(data))
  }

  func testCompilerPinnedManifestAndEveryPayloadHashRequired() throws {
    let files = try fixture()
    let validator = BundledBackendValidator(directory: files.directory, expectedManifestHash: files.hash)
    XCTAssertEqual(try validator.validatedEntryPoint(), files.directory.appendingPathComponent("bin/pickermux.mjs").resolvingSymlinksInPath())
    XCTAssertThrowsError(try BundledBackendValidator(directory: files.directory, expectedManifestHash: String(repeating: "0", count: 64)).validatedEntryPoint())
    try Data("modified payload".utf8).write(to: files.directory.appendingPathComponent("bin/pickermux.mjs").resolvingSymlinksInPath())
    XCTAssertThrowsError(try validator.validatedEntryPoint())
  }

  func testAdditionalImportsAndSymlinkedPayloadsRejected() throws {
    let files = try fixture()
    try Data("unmanifested".utf8).write(to: files.directory.appendingPathComponent("bin/injected.mjs"))
    XCTAssertThrowsError(try BundledBackendValidator(directory: files.directory, expectedManifestHash: files.hash).validatedEntryPoint())
    let linked = try fixture()
    let entry = linked.directory.appendingPathComponent("bin/pickermux.mjs")
    let target = linked.directory.appendingPathComponent("other")
    try FileManager.default.moveItem(at: entry, to: target)
    try FileManager.default.createSymbolicLink(atPath: entry.path, withDestinationPath: target.path)
    XCTAssertThrowsError(try BundledBackendValidator(directory: linked.directory, expectedManifestHash: linked.hash).validatedEntryPoint())
  }

  func testUnknownOrMissingManifestNeverExecutes() throws {
    let files = try fixture()
    XCTAssertThrowsError(try BundledBackendValidator(directory: files.directory, expectedManifestHash: nil).validatedEntryPoint())
    let manifest = files.directory.appendingPathComponent("release-manifest.json")
    try Data(#"{"schemaVersion":2,"name":"pickermux"}"#.utf8).write(to: manifest)
    let hash = digest(try Data(contentsOf: manifest))
    XCTAssertThrowsError(try BundledBackendValidator(directory: files.directory, expectedManifestHash: hash).validatedEntryPoint())
  }

  func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}

final class BootstrapTests: XCTestCase {
  func testMissingLauncherUsesPinnedBackendForPreviewOnly() async throws {
    let executor = BootstrapExecutor()
    let client = PickerMuxClient(executor: executor, launcherResolver: { throw CompanionFailure.missingLauncher }, backendResolver: { BackendInvocation(executable: URL(fileURLWithPath: "/verified/node"), leadingArguments: ["/verified/backend/bin/pickermux.mjs"]) }, nodeResolver: { URL(fileURLWithPath: "/verified/node") })
    let snapshot = try await client.status()
    XCTAssertEqual(snapshot.state, "not-installed")
    XCTAssertFalse(snapshot.actions.contains(.refresh))
    XCTAssertTrue(snapshot.actions.contains(.configurationPreview))
    _ = try await client.run(.configurationPreview)
    XCTAssertEqual(executor.calls.last, ["/verified/backend/bin/pickermux.mjs", "companion", "run"])
    do {
      _ = try await client.run(.refresh)
      XCTFail("A bundled source must not bypass receipt-active mutation checks")
    } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
  }

  func testOldNodeCannotBootstrap() async throws {
    let executor = BootstrapExecutor()
    executor.nodeVersion = "v20.19.0\n"
    let client = PickerMuxClient(executor: executor, launcherResolver: { throw CompanionFailure.missingLauncher }, backendResolver: { BackendInvocation(executable: URL(fileURLWithPath: "/verified/node"), leadingArguments: ["/verified/backend/bin/pickermux.mjs"]) }, nodeResolver: { URL(fileURLWithPath: "/verified/node") })
    do {
      _ = try await client.status()
      XCTFail("Unsupported Node.js must fail before backend execution")
    } catch { XCTAssertEqual(error as? CompanionFailure, .missingNode) }
    XCTAssertEqual(executor.calls, [["--version"]])
  }

  func testUnsafeRuntimeRejectedBeforeInstalledLauncherExecutes() async {
    let executor = BootstrapExecutor()
    var launcherCalls = 0
    let client = PickerMuxClient(executor: executor, launcherResolver: {
      launcherCalls += 1
      return URL(fileURLWithPath: "/verified/launcher")
    }, nodeResolver: { throw CompanionFailure.unsafeLauncher })
    do {
      _ = try await client.status()
      XCTFail("Unsafe runtime must not execute the installed launcher")
    } catch { XCTAssertEqual(error as? CompanionFailure, .unsafeLauncher) }
    XCTAssertEqual(launcherCalls, 0)
    XCTAssertTrue(executor.calls.isEmpty)
  }

  func testMalformedActionResultIsNeverRetriedViaBundledBackend() async throws {
    let executor = BootstrapExecutor()
    executor.malformedAction = true
    var fallbackCalls = 0
    let client = PickerMuxClient(executor: executor, launcherResolver: { URL(fileURLWithPath: "/verified/launcher") }, backendResolver: {
      fallbackCalls += 1
      return BackendInvocation(executable: URL(fileURLWithPath: "/verified/node"), leadingArguments: ["/verified/backend/bin/pickermux.mjs"])
    }, nodeResolver: { URL(fileURLWithPath: "/verified/node") })
    do {
      _ = try await client.run(.refresh)
      XCTFail("Malformed action result must fail")
    } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
    XCTAssertEqual(fallbackCalls, 0)
    XCTAssertEqual(executor.calls.filter { $0.last == "run" }.count, 1)
  }
}

private final class BootstrapExecutor: CompanionExecuting {
  var calls = [[String]]()
  var nodeVersion = "v22.15.0\n"
  var malformedAction = false

  func run(executable: URL, arguments: [String], input: Data?, environment: [String: String], timeout: TimeInterval) async throws -> ProcessOutput {
    calls.append(arguments)
    if arguments == ["--version"] { return ProcessOutput(stdout: Data(nodeVersion.utf8), exitCode: 0) }
    if arguments.last == "status" {
      let data = try JSONSerialization.data(withJSONObject: [
        "schemaVersion": 1, "capabilities": ["integration-toggle-v1"], "version": "0.9.0", "state": "not-installed",
        "desktop": ["status": "closed"], "installation": ["status": "absent"],
        "managedConfig": ["status": "unavailable"], "service": ["status": "stopped"],
        "compatibility": ["status": "unknown"], "accountCache": ["status": "valid"],
        "recovery": ["status": "idle"], "integration": ["status": "ollama"],
        "actions": ["refresh", "configuration-preview"], "issues": [],
      ] as [String: Any])
      return ProcessOutput(stdout: data, exitCode: 0)
    }
    return ProcessOutput(stdout: Data((malformedAction ? "not-json" : #"{"schemaVersion":1,"ok":true,"code":"COMPLETE"}"#).utf8), exitCode: 0)
  }
}
