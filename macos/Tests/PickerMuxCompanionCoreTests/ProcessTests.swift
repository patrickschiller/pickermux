import Darwin
import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class ProcessTests: XCTestCase {
  func script(_ contents: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pickermux-process-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let script = directory.appendingPathComponent("fixture")
    try Data(("#!/bin/sh\n" + contents).utf8).write(to: script)
    XCTAssertEqual(chmod(script.path, 0o700), 0)
    return script
  }

  func testStdinAndIndependentStreamsCompleteWithoutDeadlock() async throws {
    let executable = try script("i=0\nwhile [ \"$i\" -lt 2000 ]; do\n printf '01234567890123456789\\n' >&2\n i=$((i + 1))\ndone\n/bin/cat\n")
    let request = Data(#"{"schemaVersion":1,"action":"refresh"}"#.utf8)
    let result = try await ProcessExecutor().run(executable: executable, arguments: [], input: request, environment: [:], timeout: 10)
    XCTAssertEqual(result.stdout, request)
    XCTAssertEqual(result.exitCode, 0)
  }

  func testOutputOverflowTerminatesOwnedChild() async throws {
    do {
      _ = try await ProcessExecutor().run(executable: URL(fileURLWithPath: "/usr/bin/yes"), arguments: [], input: nil, environment: [:], timeout: 5)
      XCTFail("Unbounded output must be rejected")
    } catch {
      XCTAssertEqual(error as? CompanionFailure, .outputLimit)
    }
  }

  func testTimeoutAndMissingExecutableFailWithoutRawErrors() async {
    do {
      _ = try await ProcessExecutor().run(executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["3"], input: nil, environment: [:], timeout: 0.1)
      XCTFail("Timeout must fail")
    } catch { XCTAssertEqual(error as? CompanionFailure, .timeout) }
    do {
      _ = try await ProcessExecutor().run(executable: URL(fileURLWithPath: "/missing/pickermux"), arguments: [], input: nil, environment: [:], timeout: 1)
      XCTFail("Missing process must fail")
    } catch { XCTAssertEqual(error as? CompanionFailure, .processFailed) }
  }

  func testTimeoutBoundsDrainWhenExitedParentLeavesInheritedPipe() async throws {
    let executable = try script("/bin/sleep 2 &\nexit 0\n")
    let started = Date()
    do {
      _ = try await ProcessExecutor().run(executable: executable, arguments: [], input: nil, environment: [:], timeout: 0.1)
      XCTFail("Inherited open pipes must hit the bounded deadline")
    } catch { XCTAssertEqual(error as? CompanionFailure, .timeout) }
    XCTAssertLessThan(Date().timeIntervalSince(started), 1.5)
  }

  func testOversizedInputRejectedBeforeExecution() async {
    do {
      _ = try await ProcessExecutor().run(executable: URL(fileURLWithPath: "/bin/cat"), arguments: [], input: Data(repeating: 1, count: 4097), environment: [:], timeout: 1)
      XCTFail("Oversized request must fail")
    } catch { XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol) }
  }

  func testClientUsesFixedArgumentsAndDropsEnvironment() async throws {
    let runner = RecordingExecutor()
    let client = PickerMuxClient(home: URL(fileURLWithPath: "/fixture/home"), executor: runner, launcherResolver: { URL(fileURLWithPath: "/fixture/launcher") }, nodeResolver: { URL(fileURLWithPath: "/verified/bin/node") })
    _ = try await client.run(.refresh)
    XCTAssertEqual(runner.arguments, ["/fixture/launcher", "companion", "run"])
    XCTAssertEqual(runner.executable?.path, "/verified/bin/node")
    XCTAssertNil(runner.environment["CODEX_HOME"])
    XCTAssertEqual(runner.environment["PATH"], "/verified/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    XCTAssertEqual(runner.environment["HOME"], "/fixture/home")
    XCTAssertEqual(try JSONSerialization.jsonObject(with: XCTUnwrap(runner.input)) as? [String: AnyHashable], ["schemaVersion": 1, "action": "refresh"])
  }
}

private final class RecordingExecutor: CompanionExecuting {
  var executable: URL?
  var arguments = [String]()
  var environment = [String: String]()
  var input: Data?

  func run(executable: URL, arguments: [String], input: Data?, environment: [String: String], timeout: TimeInterval) async throws -> ProcessOutput {
    self.executable = executable
    self.arguments = arguments
    self.environment = environment
    self.input = input
    if arguments == ["--version"] { return ProcessOutput(stdout: Data("v22.15.0\n".utf8), exitCode: 0) }
    if Array(arguments.suffix(2)) == ["companion", "status"] {
      let data = try JSONSerialization.data(withJSONObject: [
        "schemaVersion": 1, "capabilities": ["integration-toggle-v1"], "version": "0.8.3", "state": "ready",
        "desktop": ["status": "closed"], "installation": ["status": "installed"],
        "managedConfig": ["status": "managed"], "service": ["status": "running"],
        "compatibility": ["status": "compatible"], "accountCache": ["status": "valid"],
        "recovery": ["status": "idle"], "integration": ["status": "pickermux"],
        "actions": ["refresh"], "issues": [],
      ] as [String: Any])
      return ProcessOutput(stdout: data, exitCode: 0)
    }
    return ProcessOutput(stdout: Data(#"{"schemaVersion":1,"ok":true,"code":"OK"}"#.utf8), exitCode: 0)
  }
}
