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

  func testActualCliTokenUsagePreservesLatestPartialUnknownAndOverflowCounts() throws {
    let snapshot = try CompanionSnapshot.decode(fixture("token-status"))
    XCTAssertTrue(snapshot.supportsTokenUsage)
    let usage = try XCTUnwrap(snapshot.tokenUsage)
    XCTAssertEqual(usage.status, .available)
    XCTAssertEqual(usage.providers.count, 3)
    let lmstudio = try XCTUnwrap(usage.providers.first { $0.providerId == "lmstudio" })
    XCTAssertEqual(lmstudio.requests, 3)
    XCTAssertEqual(lmstudio.unavailableRequests, 1)
    XCTAssertEqual(lmstudio.last.counts?.inputTokens, 100)
    XCTAssertEqual(lmstudio.last.counts?.outputTokens, 20)
    XCTAssertEqual(lmstudio.last.counts?.totalTokens, 120)
    XCTAssertEqual(lmstudio.displayTotals?.inputTokens, 200)
    XCTAssertEqual(lmstudio.displayTotals?.outputTokens, 40)
    XCTAssertEqual(lmstudio.displayTotals?.totalTokens, 240)
    XCTAssertNotNil(lmstudio.missingUsageMessage)
    let unknown = try XCTUnwrap(usage.providers.first { $0.providerId == "remote-provider" })
    XCTAssertEqual(unknown.last.status, .unavailable)
    XCTAssertNil(unknown.last.counts)
    XCTAssertNil(unknown.displayTotals)
    let overflow = try XCTUnwrap(usage.providers.first { $0.providerId == "overflow-provider" })
    XCTAssertEqual(overflow.last.counts?.totalTokens, 120)
    XCTAssertNil(overflow.totals)
    XCTAssertNil(overflow.displayTotals)
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
