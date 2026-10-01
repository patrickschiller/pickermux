import Darwin
import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class NodeValidatorTests: XCTestCase {
  private let fixtureUser: uid_t = 1001
  private let fixtureAdmin: gid_t = 80

  private func directory(owner: uid_t = 0, group: gid_t = 0, mode: mode_t = 0o755) -> NodeFileMetadata {
    NodeFileMetadata(mode: mode_t(S_IFDIR) | mode, owner: owner, group: group)
  }

  private func virtualFixture(root: String = "/opt/homebrew") -> (candidate: String, resolved: String, files: [String: NodeFileMetadata]) {
    let candidate = root + "/bin/node"
    let resolved = root + "/Cellar/node/26.10.0_1/bin/node"
    var files = [String: NodeFileMetadata]()
    for file in [candidate, resolved] {
      var parent = (file as NSString).deletingLastPathComponent
      while true {
        files[parent] = directory()
        if parent == "/" { break }
        parent = (parent as NSString).deletingLastPathComponent
      }
    }
    files[root + "/Cellar"] = directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o775)
    files[root + "/bin"] = directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o775)
    files[candidate] = NodeFileMetadata(mode: mode_t(S_IFLNK) | 0o777, owner: fixtureUser)
    files[resolved] = NodeFileMetadata(mode: mode_t(S_IFREG) | 0o555, owner: fixtureUser)
    return (candidate, resolved, files)
  }

  private func validator(_ fixture: (candidate: String, resolved: String, files: [String: NodeFileMetadata]), adminGroup: gid_t? = 80) -> NodeValidator {
    NodeValidator(candidates: [fixture.candidate], currentUser: fixtureUser, adminGroup: adminGroup, metadata: { fixture.files[$0] }, resolve: { _ in fixture.resolved })
  }

  private func assertUnsafe(_ validator: NodeValidator, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertThrowsError(try validator.validatedNode(), file: file, line: line) { error in
      XCTAssertEqual(error as? CompanionFailure, .unsafeNode, file: file, line: line)
    }
  }

  func testHomebrewAdminBinAndCellarSymlinkIsAcceptedAndEveryParentIncludingRootIsChecked() throws {
    let fixture = virtualFixture()
    var inspected = [String]()
    let validator = NodeValidator(candidates: [fixture.candidate], currentUser: fixtureUser, adminGroup: fixtureAdmin, metadata: {
      inspected.append($0)
      return fixture.files[$0]
    }, resolve: { _ in fixture.resolved })
    XCTAssertEqual(try validator.validatedNode().path, fixture.resolved)
    for parent in ["/opt/homebrew/bin", "/opt/homebrew/Cellar/node/26.10.0_1/bin", "/opt/homebrew/Cellar/node/26.10.0_1", "/opt/homebrew/Cellar/node", "/opt/homebrew/Cellar", "/opt/homebrew", "/opt", "/"] {
      XCTAssertTrue(inspected.contains(parent), "Missing required parent check")
    }
    XCTAssertFalse(inspected.contains(""))
  }

  func testIntelHomebrewAndRootOwnedNodeRemainSupported() throws {
    var fixture = virtualFixture(root: "/usr/local")
    fixture.files[fixture.resolved] = NodeFileMetadata(mode: mode_t(S_IFREG) | 0o755, owner: 0)
    fixture.files["/usr/local/Cellar"] = directory(owner: 0, group: fixtureAdmin, mode: 0o775)
    XCTAssertEqual(try validator(fixture).validatedNode().path, fixture.resolved)
    let system = NodeValidator(candidates: ["/usr/bin/node"], currentUser: fixtureUser, adminGroup: nil, metadata: {
      $0 == "/usr/bin/node" ? NodeFileMetadata(mode: mode_t(S_IFREG) | 0o755, owner: 0) : self.directory()
    }, resolve: { $0 })
    XCTAssertEqual(try system.validatedNode().path, "/usr/bin/node")
  }

  func testHomebrewDirectoryExceptionIsExactOwnedNormalAndAdminOnly() {
    let cases: [(String, NodeFileMetadata)] = [
      ("/opt/homebrew/Cellar", directory(owner: fixtureUser, group: 20, mode: 0o775)),
      ("/opt/homebrew/Cellar", directory(owner: fixtureUser + 1, group: fixtureAdmin, mode: 0o775)),
      ("/opt/homebrew/Cellar", directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o777)),
      ("/opt/homebrew/Cellar", directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o1775)),
      ("/opt/homebrew/Cellar", directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o2775)),
      ("/opt/homebrew/Cellar", directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o4775)),
      ("/opt/homebrew/bin", directory(owner: fixtureUser, group: 20, mode: 0o775)),
      ("/opt/homebrew/bin", directory(owner: fixtureUser + 1, group: fixtureAdmin, mode: 0o775)),
      ("/opt/homebrew/bin", directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o777)),
      ("/opt/homebrew/bin", directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o1775)),
      ("/opt/homebrew/Cellar/node", directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o775)),
      ("/opt/homebrew/Cellar/node/26.10.0_1", directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o775)),
      ("/opt/homebrew/Cellar/node/26.10.0_1/bin", directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o775)),
      ("/opt/homebrew", directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o775)),
      ("/opt", directory(owner: fixtureUser + 1)),
      ("/", directory(mode: 0o775)),
      ("/", directory(mode: 0o1777)),
      ("/opt/homebrew/bin", NodeFileMetadata(mode: mode_t(S_IFLNK) | 0o777, owner: fixtureUser)),
    ]
    for (path, information) in cases {
      var fixture = virtualFixture()
      fixture.files[path] = information
      assertUnsafe(validator(fixture))
    }
    assertUnsafe(validator(virtualFixture(), adminGroup: nil))
    var absentRoot = virtualFixture()
    absentRoot.files.removeValue(forKey: "/")
    assertUnsafe(validator(absentRoot))
  }

  func testExecutableMustRemainOwnedRegularExecutablePrivateAndSingleLinked() {
    let cases = [
      NodeFileMetadata(mode: mode_t(S_IFREG) | 0o755, owner: fixtureUser + 1),
      NodeFileMetadata(mode: mode_t(S_IFREG) | 0o775, owner: fixtureUser),
      NodeFileMetadata(mode: mode_t(S_IFREG) | 0o777, owner: fixtureUser),
      NodeFileMetadata(mode: mode_t(S_IFREG) | 0o644, owner: fixtureUser),
      NodeFileMetadata(mode: mode_t(S_IFREG) | 0o4755, owner: fixtureUser),
      NodeFileMetadata(mode: mode_t(S_IFREG) | 0o2755, owner: fixtureUser),
      NodeFileMetadata(mode: mode_t(S_IFREG) | 0o1755, owner: fixtureUser),
      NodeFileMetadata(mode: mode_t(S_IFREG) | 0o755, owner: fixtureUser, linkCount: 2),
      NodeFileMetadata(mode: mode_t(S_IFDIR) | 0o755, owner: fixtureUser),
      NodeFileMetadata(mode: mode_t(S_IFLNK) | 0o777, owner: fixtureUser),
    ]
    for information in cases {
      var fixture = virtualFixture()
      fixture.files[fixture.resolved] = information
      assertUnsafe(validator(fixture))
    }
    var foreignLink = virtualFixture()
    foreignLink.files[foreignLink.candidate] = NodeFileMetadata(mode: mode_t(S_IFLNK) | 0o777, owner: fixtureUser + 1)
    assertUnsafe(validator(foreignLink))
  }

  func testForeignAndLookalikePrefixesCannotUseHomebrewAuthority() {
    let fixture = virtualFixture()
    for target in ["/tmp/node", "/opt/homebrew-other/bin/node", "/usr/local-other/bin/node", "/usr/bin-other/node", "relative/node"] {
      let validator = NodeValidator(candidates: [fixture.candidate], currentUser: fixtureUser, adminGroup: fixtureAdmin, metadata: { fixture.files[$0] }, resolve: { _ in target })
      assertUnsafe(validator)
    }
    var lookalike = virtualFixture()
    lookalike.resolved = "/opt/homebrew/Cellar-other/node/bin/node"
    lookalike.files[lookalike.resolved] = NodeFileMetadata(mode: mode_t(S_IFREG) | 0o755, owner: fixtureUser)
    lookalike.files["/opt/homebrew/Cellar-other/node/bin"] = directory()
    lookalike.files["/opt/homebrew/Cellar-other/node"] = directory()
    lookalike.files["/opt/homebrew/Cellar-other"] = directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o775)
    assertUnsafe(validator(lookalike))
    var aliasLookalike = virtualFixture()
    aliasLookalike.candidate = "/opt/homebrew/bin-other/node"
    aliasLookalike.files[aliasLookalike.candidate] = NodeFileMetadata(mode: mode_t(S_IFLNK) | 0o777, owner: fixtureUser)
    aliasLookalike.files["/opt/homebrew/bin-other"] = directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o775)
    assertUnsafe(validator(aliasLookalike))
    var nestedAlias = virtualFixture()
    nestedAlias.candidate = "/opt/homebrew/bin/child/node"
    nestedAlias.files[nestedAlias.candidate] = NodeFileMetadata(mode: mode_t(S_IFLNK) | 0o777, owner: fixtureUser)
    nestedAlias.files["/opt/homebrew/bin/child"] = directory(owner: fixtureUser, group: fixtureAdmin, mode: 0o775)
    assertUnsafe(validator(nestedAlias))
  }

  func testMissingRejectedAndUsableFallbackCandidatesAreDistinguished() throws {
    let absent = NodeValidator(candidates: ["/opt/homebrew/bin/node"], currentUser: fixtureUser, adminGroup: fixtureAdmin, metadata: { _ in nil }, resolve: { $0 })
    XCTAssertThrowsError(try absent.validatedNode()) { error in XCTAssertEqual(error as? CompanionFailure, .missingNode) }
    var unsafe = virtualFixture()
    unsafe.files[unsafe.resolved] = NodeFileMetadata(mode: mode_t(S_IFREG) | 0o777, owner: fixtureUser)
    assertUnsafe(validator(unsafe))
    let usable = virtualFixture(root: "/usr/local")
    let combined = unsafe.files.merging(usable.files) { first, _ in first }
    let fallback = NodeValidator(candidates: [unsafe.candidate, usable.candidate], currentUser: fixtureUser, adminGroup: fixtureAdmin, metadata: { combined[$0] }, resolve: { $0 == unsafe.candidate ? unsafe.resolved : usable.resolved })
    XCTAssertEqual(try fallback.validatedNode().path, usable.resolved)
  }

  private func realFixture() throws -> (homebrew: URL, candidate: URL, executable: URL, root: URL) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("pickermux-node-test-\(UUID().uuidString)").resolvingSymlinksInPath()
    let homebrew = root.appendingPathComponent("homebrew")
    let candidate = homebrew.appendingPathComponent("bin/node")
    let executable = homebrew.appendingPathComponent("Cellar/node/26.10.0_1/bin/node")
    try FileManager.default.createDirectory(at: candidate.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("fixture only: never execute".utf8).write(to: executable)
    XCTAssertEqual(chmod(executable.path, 0o755), 0)
    try FileManager.default.createSymbolicLink(atPath: candidate.path, withDestinationPath: "../Cellar/node/26.10.0_1/bin/node")
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    return (homebrew, candidate, executable, root)
  }

  private func realValidator(_ fixture: (homebrew: URL, candidate: URL, executable: URL, root: URL)) -> NodeValidator {
    NodeValidator(candidates: [fixture.candidate.path], roots: [fixture.homebrew.path], currentUser: getuid(), adminGroup: nil, metadata: { path in
      // Ancestors outside our owned fixture are injected, so ordinary tests
      // never depend on system temporary-directory permissions or ownership.
      if path == fixture.root.path || path.hasPrefix(fixture.root.path + "/") {
        var information = stat()
        guard lstat(path, &information) == 0 else { return nil }
        return NodeFileMetadata(mode: information.st_mode, owner: information.st_uid, group: information.st_gid, linkCount: information.st_nlink)
      }
      return self.directory()
    }, resolve: { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path })
  }

  func testActualHomebrewFixtureSymlinkReturnsCanonicalExecutableWithoutExecutingIt() throws {
    let fixture = try realFixture()
    XCTAssertEqual(try realValidator(fixture).validatedNode(), fixture.executable.resolvingSymlinksInPath())
  }

  func testActualSymlinkEscapeAndSymlinkedCandidateParentAreRejected() throws {
    let escaped = try realFixture()
    let foreign = escaped.root.appendingPathComponent("foreign-node")
    try Data("foreign fixture only".utf8).write(to: foreign)
    XCTAssertEqual(chmod(foreign.path, 0o755), 0)
    try FileManager.default.removeItem(at: escaped.candidate)
    try FileManager.default.createSymbolicLink(atPath: escaped.candidate.path, withDestinationPath: foreign.path)
    assertUnsafe(realValidator(escaped))
    let linkedParent = try realFixture()
    let bin = linkedParent.candidate.deletingLastPathComponent()
    let renamed = linkedParent.homebrew.appendingPathComponent("real-bin")
    try FileManager.default.moveItem(at: bin, to: renamed)
    try FileManager.default.createSymbolicLink(atPath: bin.path, withDestinationPath: renamed.path)
    assertUnsafe(realValidator(linkedParent))
  }

  func testVersionProbeRejectsOldNodeAndAcceptsMinimumAndCurrentVersionsWithoutRealExecution() async throws {
    let status = try Data(contentsOf: Bundle.module.url(forResource: "status", withExtension: "json", subdirectory: "Fixtures")!)
    for (version, supported) in [("v22.14.0\n", false), ("v22.15.0\n", true), ("v26.10.0\n", true)] {
      let executor = NodeVersionExecutor(version: version, status: status)
      let client = PickerMuxClient(executor: executor, launcherResolver: { URL(fileURLWithPath: "/verified/backend/bin/pickermux.mjs") }, nodeResolver: { URL(fileURLWithPath: "/verified/bin/node") })
      if supported {
        let snapshot = try await client.status()
        XCTAssertEqual(snapshot.state, "ready")
        XCTAssertEqual(executor.calls.count, 2)
      } else {
        do {
          _ = try await client.status()
          XCTFail("An old runtime must fail before the backend is called")
        } catch { XCTAssertEqual(error as? CompanionFailure, .missingNode) }
        XCTAssertEqual(executor.calls, [["--version"]])
      }
    }
  }
}

private final class NodeVersionExecutor: CompanionExecuting {
  let version: String
  let status: Data
  var calls = [[String]]()

  init(version: String, status: Data) {
    self.version = version
    self.status = status
  }

  func run(executable: URL, arguments: [String], input: Data?, environment: [String: String], timeout: TimeInterval) async throws -> ProcessOutput {
    calls.append(arguments)
    return ProcessOutput(stdout: arguments == ["--version"] ? Data(version.utf8) : status, exitCode: 0)
  }
}
