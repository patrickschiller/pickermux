import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class LauncherTests: XCTestCase {
  func fixture(withRuntime: Bool = false) throws -> (home: URL, launcher: URL, distribution: URL) {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent("pickermux-launcher-test-\(UUID().uuidString)")
    let distribution = home.appendingPathComponent("Library/Application Support/PickerMux")
    let launcher = home.appendingPathComponent(".local/bin/pickermux")
    var directories = [".local/bin", "Library/Application Support/PickerMux/versions/0.8.3/bin",
      "Library/Application Support/PickerMux/versions/0.8.3/src"]
    if withRuntime { directories.append("Library/Application Support/PickerMux/versions/0.8.3/runtime/mlx") }
    for name in directories {
      try FileManager.default.createDirectory(at: home.appendingPathComponent(name), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    addTeardownBlock { try? FileManager.default.removeItem(at: home) }
    let fixtureURL = try XCTUnwrap(Bundle.module.resourceURL).appendingPathComponent("Fixtures/distribution-digest.json")
    let golden = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any])
    let launcherTemplate = try XCTUnwrap(golden["launcherTemplate"] as? String)
    let contents = Data(launcherTemplate.replacingOccurrences(of: "/FIXTURE_HOME", with: home.path).utf8)
    try contents.write(to: launcher)
    XCTAssertEqual(chmod(launcher.path, 0o700), 0)
    let entry = distribution.appendingPathComponent("versions/0.8.3/bin/pickermux.mjs")
    try Data("// fixture".utf8).write(to: entry)
    XCTAssertEqual(chmod(entry.path, 0o600), 0)
    try FileManager.default.createSymbolicLink(atPath: distribution.appendingPathComponent("current").path, withDestinationPath: "versions/0.8.3")
    let versionRoot = distribution.appendingPathComponent("versions/0.8.3")
    var fixtureFiles = try XCTUnwrap(golden["files"] as? [String: String])
    var expectedDigest = try XCTUnwrap(golden["sha256"] as? String)
    if withRuntime {
      fixtureFiles.merge(try XCTUnwrap(golden["runtimeFiles"] as? [String: String])) { _, runtime in runtime }
      expectedDigest = try XCTUnwrap(golden["runtimeSha256"] as? String)
    }
    for (relative, text) in fixtureFiles {
      let url = versionRoot.appendingPathComponent(relative)
      try Data(text.utf8).write(to: url)
      XCTAssertEqual(chmod(url.path, 0o600), 0)
    }
    let receipt: [String: Any] = [
      "schemaVersion": 1, "product": "pickermux", "owner": "pickermux-cli-installer",
      "activeVersion": "0.8.3", "activeTarget": "versions/0.8.3", "launcherPath": launcher.path,
      "launcherSha256": SHA256.hash(data: contents).map { String(format: "%02x", $0) }.joined(),
      "versions": [["version": "0.8.3", "path": "versions/0.8.3", "sha256": expectedDigest]],
    ]
    let receiptURL = distribution.appendingPathComponent("install-receipt.json")
    try JSONSerialization.data(withJSONObject: receipt).write(to: receiptURL)
    XCTAssertEqual(chmod(receiptURL.path, 0o600), 0)
    return (home, launcher, distribution)
  }

  func testReceiptOwnedPrivateLauncherAccepted() throws {
    let files = try fixture()
    XCTAssertEqual(try LauncherValidator(home: files.home).validatedLauncher(), files.launcher)
  }

  func testReceiptOwnedDistributionWithReviewedMlxRuntimeAccepted() throws {
    let files = try fixture(withRuntime: true)
    XCTAssertEqual(try LauncherValidator(home: files.home).validatedEntryPoint(),
      files.distribution.appendingPathComponent("versions/0.8.3/bin/pickermux.mjs"))
  }

  func testChangedIncompleteOrUnexpectedMlxRuntimeRejected() throws {
    let changed = try fixture(withRuntime: true)
    try Data("modified runtime".utf8).write(to:
      changed.distribution.appendingPathComponent("versions/0.8.3/runtime/mlx/server.py"))
    XCTAssertThrowsError(try LauncherValidator(home: changed.home).validatedEntryPoint())

    let missing = try fixture(withRuntime: true)
    try FileManager.default.removeItem(at:
      missing.distribution.appendingPathComponent("versions/0.8.3/runtime/mlx/manage.py"))
    XCTAssertThrowsError(try LauncherValidator(home: missing.home).validatedEntryPoint())

    let unexpected = try fixture(withRuntime: true)
    try Data("unreviewed".utf8).write(to:
      unexpected.distribution.appendingPathComponent("versions/0.8.3/runtime/mlx/other.py"))
    XCTAssertThrowsError(try LauncherValidator(home: unexpected.home).validatedEntryPoint())
  }

  func testLinkedOrSharedMlxRuntimeRejected() throws {
    let linked = try fixture(withRuntime: true)
    let server = linked.distribution.appendingPathComponent("versions/0.8.3/runtime/mlx/server.py")
    XCTAssertEqual(link(server.path, linked.home.appendingPathComponent("server-hard-link").path), 0)
    XCTAssertThrowsError(try LauncherValidator(home: linked.home).validatedEntryPoint())

    let shared = try fixture(withRuntime: true)
    let runtime = shared.distribution.appendingPathComponent("versions/0.8.3/runtime")
    XCTAssertEqual(chmod(runtime.path, 0o750), 0)
    XCTAssertThrowsError(try LauncherValidator(home: shared.home).validatedEntryPoint())

    let symlinked = try fixture(withRuntime: true)
    let mlx = symlinked.distribution.appendingPathComponent("versions/0.8.3/runtime/mlx")
    let displaced = symlinked.home.appendingPathComponent("displaced-mlx")
    try FileManager.default.moveItem(at: mlx, to: displaced)
    try FileManager.default.createSymbolicLink(atPath: mlx.path, withDestinationPath: displaced.path)
    XCTAssertThrowsError(try LauncherValidator(home: symlinked.home).validatedEntryPoint())
  }

  func testChangedSharedOrLinkedLauncherRejected() throws {
    let changed = try fixture()
    try Data("#!/bin/sh\nset -eu\nexit 1\n".utf8).write(to: changed.launcher)
    XCTAssertThrowsError(try LauncherValidator(home: changed.home).validatedLauncher())
    let shared = try fixture()
    XCTAssertEqual(chmod(shared.launcher.path, 0o755), 0)
    XCTAssertThrowsError(try LauncherValidator(home: shared.home).validatedLauncher())
    let linked = try fixture()
    let target = linked.launcher.appendingPathExtension("other")
    try FileManager.default.moveItem(at: linked.launcher, to: target)
    try FileManager.default.createSymbolicLink(atPath: linked.launcher.path, withDestinationPath: target.path)
    XCTAssertThrowsError(try LauncherValidator(home: linked.home).validatedLauncher())
  }

  func testCoherentlyRehashedForeignLauncherRejected() throws {
    let files = try fixture()
    let data = Data("#!/bin/sh\nset -eu\nexit 0\n".utf8)
    try data.write(to: files.launcher)
    let receiptURL = files.distribution.appendingPathComponent("install-receipt.json")
    var receipt = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: receiptURL)) as? [String: Any])
    receipt["launcherSha256"] = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    try JSONSerialization.data(withJSONObject: receipt).write(to: receiptURL)
    XCTAssertThrowsError(try LauncherValidator(home: files.home).validatedLauncher())
  }

  func testChangedReceiptActiveEntryAndSourceRejectedBeforeExecution() throws {
    let files = try fixture()
    let source = files.distribution.appendingPathComponent("versions/0.8.3/src/control.mjs")
    try Data("modified source".utf8).write(to: source)
    XCTAssertThrowsError(try LauncherValidator(home: files.home).validatedLauncher())
    let entry = try fixture()
    try Data("modified entry".utf8).write(to: entry.distribution.appendingPathComponent("versions/0.8.3/bin/pickermux.mjs"))
    XCTAssertThrowsError(try LauncherValidator(home: entry.home).validatedLauncher())
  }

  func testForeignCurrentPointerAndReceiptRejected() throws {
    let files = try fixture()
    let current = files.distribution.appendingPathComponent("current")
    try FileManager.default.removeItem(at: current)
    try FileManager.default.createSymbolicLink(atPath: current.path, withDestinationPath: "/tmp/foreign")
    XCTAssertThrowsError(try LauncherValidator(home: files.home).validatedLauncher())
    let foreign = try fixture()
    let receipt = foreign.distribution.appendingPathComponent("install-receipt.json")
    try Data(#"{"schemaVersion":1,"owner":"foreign"}"#.utf8).write(to: receipt)
    XCTAssertThrowsError(try LauncherValidator(home: foreign.home).validatedLauncher())
  }

  func testHardLinkedReceiptAndSymlinkedParentsRejected() throws {
    let files = try fixture()
    let receipt = files.distribution.appendingPathComponent("install-receipt.json")
    try FileManager.default.linkItem(at: receipt, to: receipt.appendingPathExtension("link"))
    XCTAssertThrowsError(try LauncherValidator(home: files.home).validatedLauncher())
    let parents = try fixture()
    let bin = parents.home.appendingPathComponent(".local/bin")
    let moved = parents.home.appendingPathComponent("other-bin")
    try FileManager.default.moveItem(at: bin, to: moved)
    try FileManager.default.createSymbolicLink(atPath: bin.path, withDestinationPath: moved.path)
    XCTAssertThrowsError(try LauncherValidator(home: parents.home).validatedLauncher())
  }
}
