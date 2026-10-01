import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class FixtureTests: XCTestCase {
  func fixture(_ name: String) throws -> Data {
    let directory = try XCTUnwrap(Bundle.module.resourceURL).appendingPathComponent("Fixtures")
    return try Data(contentsOf: directory.appendingPathComponent("\(name).json"))
  }

  func testActualCliSnapshotsIncludeSafePartialResults() throws {
    let ready = try CompanionSnapshot.decode(fixture("status"))
    XCTAssertEqual(ready.state, "ready")
    XCTAssertTrue(ready.actions.contains(.configurationApply))
    let partial = try CompanionSnapshot.decode(fixture("partial-status"))
    XCTAssertEqual(partial.version, "unknown")
    XCTAssertEqual(partial.state, "degraded")
  }

  func testActualCliPreviewEnvelopeHasNoNestedVersionRequirement() throws {
    let result = try CompanionResult.decode(fixture("preview"))
    XCTAssertTrue(result.ok)
    let preview = try XCTUnwrap(result.preview)
    XCTAssertTrue(preview.canApply)
    XCTAssertEqual(preview.status, "ollama")
    XCTAssertEqual(preview.previewToken, String(repeating: "a", count: 64))
    XCTAssertTrue(preview.changes.contains("preserve-user-settings"))
  }

  func testActualUpdateEnvelopePreservesIncompleteCertificationAndRestart() throws {
    let result = try CompanionResult.decode(fixture("update"))
    XCTAssertEqual(result.update?.status, "updated")
    XCTAssertTrue(result.certificationIncomplete)
    XCTAssertTrue(result.restartRequired)
  }
}
