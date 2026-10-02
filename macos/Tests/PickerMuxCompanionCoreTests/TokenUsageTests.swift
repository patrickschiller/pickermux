import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class TokenUsageTests: XCTestCase {
  private let capability = "token-usage-v1"

  private func counts(_ input: Int = 120, _ output: Int = 30) -> [String: Any] {
    ["inputTokens": input, "outputTokens": output, "totalTokens": input + output]
  }

  private func provider(_ changes: [String: Any] = [:]) -> [String: Any] {
    var last = counts()
    last["status"] = "available"
    var value: [String: Any] = [
      "providerId": "lmstudio", "requests": 1, "unavailableRequests": 0,
      "last": last, "totals": counts(),
    ]
    value.merge(changes) { _, new in new }
    return value
  }

  private func usage(_ providers: [[String: Any]] = [], status: String = "available") -> [String: Any] {
    ["schemaVersion": 1, "status": status, "providers": providers]
  }

  private func snapshot(_ usage: [String: Any]? = nil, capabilities: [String]? = nil) throws -> Data {
    let directory = try XCTUnwrap(Bundle.module.resourceURL).appendingPathComponent("Fixtures")
    var root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("status.json"))) as? [String: Any])
    let advertised = capabilities ?? ["integration-toggle-v1", "native-uninstall-v1", capability]
    root["capabilities"] = advertised
    if !advertised.contains("native-uninstall-v1") {
      root["actions"] = (root["actions"] as? [String])?.filter { !["uninstall", "uninstall-preview"].contains($0) }
    }
    root["tokenUsage"] = usage
    return try JSONSerialization.data(withJSONObject: root)
  }

  private func decode(_ usage: [String: Any]) throws -> CompanionSnapshot {
    try CompanionSnapshot.decode(snapshot(usage))
  }

  private func rejects(_ usage: [String: Any], file: StaticString = #filePath, line: UInt = #line) throws {
    XCTAssertThrowsError(try decode(usage), file: file, line: line) { error in
      XCTAssertEqual(error as? CompanionFailure, .incompatibleProtocol, file: file, line: line)
    }
  }

  func testAdditiveCapabilityPreservesLegacyBackendStatus() throws {
    for capabilities in [["integration-toggle-v1"], ["integration-toggle-v1", "native-uninstall-v1"]] {
      let value = try CompanionSnapshot.decode(snapshot(capabilities: capabilities))
      XCTAssertNil(value.tokenUsage)
      XCTAssertFalse(value.supportsTokenUsage)
      let current = try CompanionSnapshot.decode(snapshot(usage(), capabilities: capabilities + [capability]))
      XCTAssertTrue(current.supportsTokenUsage)
      XCTAssertEqual(current.tokenUsage?.status, .available)
      XCTAssertEqual(current.tokenUsage?.providers, [])
    }
    let unavailable = try decode(usage(status: "unavailable"))
    XCTAssertEqual(unavailable.tokenUsage?.status, .unavailable)
    XCTAssertEqual(unavailable.tokenUsage?.providers, [])
  }

  func testUsageAndCapabilityMustAgreeAndRemainCanonical() throws {
    XCTAssertThrowsError(try CompanionSnapshot.decode(snapshot()))
    XCTAssertThrowsError(try CompanionSnapshot.decode(snapshot(usage(), capabilities: ["integration-toggle-v1"])))
    for capabilities in [
      [capability, "integration-toggle-v1"],
      ["integration-toggle-v1", capability, "native-uninstall-v1"],
      ["integration-toggle-v1", capability, capability],
      ["integration-toggle-v1", "token-usage-v2"],
    ] {
      XCTAssertThrowsError(try CompanionSnapshot.decode(snapshot(usage(), capabilities: capabilities)))
    }
    var root = try XCTUnwrap(JSONSerialization.jsonObject(with: snapshot()) as? [String: Any])
    root["tokenUsage"] = NSNull()
    XCTAssertThrowsError(try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: root)))
    root["capabilities"] = ["integration-toggle-v1"]
    XCTAssertThrowsError(try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: root)))
  }

  func testLatestAndAccumulatedCountsStayDistinctIncludingMeasuredZero() throws {
    let value = try XCTUnwrap(try decode(usage([provider(["requests": 3, "totals": counts(600, 80)])])).tokenUsage?.providers.first)
    XCTAssertEqual(value.last.counts?.inputTokens, 120)
    XCTAssertEqual(value.last.counts?.outputTokens, 30)
    XCTAssertEqual(value.last.counts?.totalTokens, 150)
    XCTAssertEqual(value.displayTotals?.inputTokens, 600)
    XCTAssertEqual(value.displayTotals?.outputTokens, 80)
    XCTAssertEqual(value.displayTotals?.totalTokens, 680)
    XCTAssertNil(value.missingUsageMessage)
    var zero = counts(0, 0)
    zero["status"] = "available"
    let measuredZero = try XCTUnwrap(try decode(usage([provider(["last": zero, "totals": counts(0, 0)])])).tokenUsage?.providers.first)
    XCTAssertEqual(measuredZero.last.counts?.totalTokens, 0)
    XCTAssertEqual(measuredZero.displayTotals?.totalTokens, 0)
  }

  func testMissingLatestUsageKeepsPriorMeasuredTotalsAndExplainsPartialCounts() throws {
    let value = try XCTUnwrap(try decode(usage([provider([
      "requests": 3, "unavailableRequests": 1, "last": ["status": "unavailable"], "totals": counts(600, 80),
    ])])).tokenUsage?.providers.first)
    XCTAssertNil(value.last.counts)
    XCTAssertEqual(value.displayTotals?.totalTokens, 680)
    XCTAssertTrue(value.missingUsageMessage?.contains("reported usage only") == true)
    XCTAssertTrue(value.missingUsageMessage?.contains("1 of 3") == true)
  }

  func testAllUnknownAndOverflowedTotalsDisplayUnavailable() throws {
    let unknown = try XCTUnwrap(try decode(usage([provider([
      "requests": 2, "unavailableRequests": 2, "last": ["status": "unavailable"], "totals": counts(0, 0),
    ])])).tokenUsage?.providers.first)
    XCTAssertNil(unknown.last.counts)
    XCTAssertNil(unknown.displayTotals)
    XCTAssertTrue(unknown.missingUsageMessage?.contains("No verified usage counts") == true)
    let overflow = try XCTUnwrap(try decode(usage([provider(["requests": 2, "totals": NSNull()])])).tokenUsage?.providers.first)
    XCTAssertEqual(overflow.last.counts?.totalTokens, 150)
    XCTAssertNil(overflow.displayTotals)
  }

  func testUsageRejectsUnknownSchemaStatusAndAdditionalNestedData() throws {
    for changes in [
      ["schemaVersion": 2], ["status": "unknown"], ["providers": NSNull()],
      ["metadata": ["path": "/private/secret-canary"]],
    ] as [[String: Any]] {
      var malformed = usage()
      malformed.merge(changes) { _, new in new }
      try rejects(malformed)
    }
    try rejects(usage([provider()], status: "unavailable"))
    try rejects(usage([provider(["model": "private/model-canary"])]))
    var latest = counts()
    latest["status"] = "available"
    latest["privatePrompt"] = "secret-canary"
    try rejects(usage([provider(["last": latest])]))
    var totals = counts()
    totals["cachedTokens"] = 10
    try rejects(usage([provider(["totals": totals])]))
    try rejects(usage([provider(["last": ["status": "unavailable", "inputTokens": NSNull()]])]))
    var missing = provider()
    missing.removeValue(forKey: "totals")
    try rejects(usage([missing]))
  }

  func testOnlySafeNonnegativeIntegerCountsCrossTheProtocolBoundary() throws {
    let maximum = 9_007_199_254_740_991
    var largest = counts(maximum, 0)
    largest["status"] = "available"
    let valid = try decode(usage([provider(["last": largest, "totals": counts(maximum, 0), "requests": maximum])]))
    XCTAssertEqual(valid.tokenUsage?.providers.first?.displayTotals?.totalTokens, maximum)
    for invalid in [-1, 1.5, true, "10", NSNull(), maximum + 1] as [Any] {
      for key in ["requests", "unavailableRequests"] {
        try rejects(usage([provider([key: invalid])]))
      }
      for key in ["inputTokens", "outputTokens", "totalTokens"] {
        var latest = counts()
        latest["status"] = "available"
        latest[key] = invalid
        try rejects(usage([provider(["last": latest])]))
        var totals = counts()
        totals[key] = invalid
        try rejects(usage([provider(["totals": totals])]))
      }
    }
  }

  func testInconsistentSumsStatusesAndRequestCountsFailClosed() throws {
    for changes in [
      ["requests": 0], ["unavailableRequests": 2], ["unavailableRequests": 1],
      ["last": ["status": "unavailable"]],
      ["totals": ["inputTokens": 120, "outputTokens": 30, "totalTokens": 151]],
      ["totals": counts(119, 31)], ["totals": counts(121, 29)],
      ["totals": counts(121, 31)], ["totals": NSNull()],
      ["last": ["status": "available", "inputTokens": 120, "outputTokens": 30, "totalTokens": 149]],
    ] as [[String: Any]] {
      try rejects(usage([provider(changes)]))
    }
    try rejects(usage([provider([
      "unavailableRequests": 1, "last": ["status": "unavailable"], "totals": counts(1, 0),
    ])]))
    try rejects(usage([provider([
      "unavailableRequests": 1, "last": ["status": "unavailable"], "totals": NSNull(),
    ])]))
  }

  func testProviderIdsAreCanonicalBoundedAndUnique() throws {
    for id in ["lmstudio", "remote-provider", "local_provider2", "2", String(repeating: "a", count: 127)] {
      let value = try decode(usage([provider(["providerId": id])]))
      XCTAssertEqual(value.tokenUsage?.providers.first?.providerId, id)
    }
    for id in ["", "LMStudio", "provider/model", "/private/path", "provider_", "-provider", "provider-", "provider\n", "_", "ä", String(repeating: "a", count: 128)] {
      try rejects(usage([provider(["providerId": id])]))
    }
    try rejects(usage([provider(), provider()]))
    let providers = (0..<128).map { provider(["providerId": "provider-\($0)"]) }
    XCTAssertEqual(try decode(usage(providers)).tokenUsage?.providers.count, 128)
    try rejects(usage(providers + [provider(["providerId": "extra"])]))
  }

  func testCounterChangesDoNotTriggerTransitionsAndSurviveActionFiltering() throws {
    let initial = try decode(usage([provider()]))
    let later = try decode(usage([provider(["requests": 2, "totals": counts(240, 60)])]))
    XCTAssertEqual(initial.transitionIdentity, later.transitionIdentity)
    XCTAssertFalse(shouldNotifyRecoveryCompletion(previous: initial, next: later))
    let filtered = later.allowingOnly([.refresh], bundledBackend: true)
    XCTAssertEqual(filtered.tokenUsage, later.tokenUsage)
    XCTAssertTrue(filtered.supportsTokenUsage)
    XCTAssertTrue(filtered.usesBundledBackend)
    XCTAssertEqual(filtered.actions, [.refresh])
  }

  private func persistentUsage(_ providers: [[String: Any]] = [], resetAt: Any = NSNull()) -> [String: Any] {
    ["schemaVersion": 2, "status": "available", "providers": providers, "resetAt": resetAt]
  }

  private func decodePersistent(_ usage: [String: Any], resetCapability: Bool = true) throws -> CompanionSnapshot {
    let capabilities = ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v2"] +
      (resetCapability ? ["token-usage-reset-v1"] : [])
    return try CompanionSnapshot.decode(snapshot(usage, capabilities: capabilities))
  }

  func testPersistentUsageKeepsLastRequestWhenAccumulatedCountsReset() throws {
    let resetAt = "2026-10-02T18:04:05.123Z"
    let reset = provider(["requests": 0, "unavailableRequests": 0, "totals": counts(0, 0)])
    let value = try decodePersistent(persistentUsage([reset], resetAt: resetAt))
    let usage = try XCTUnwrap(value.tokenUsage)
    XCTAssertTrue(value.supportsTokenUsage)
    XCTAssertTrue(value.supportsTokenUsageReset)
    XCTAssertTrue(usage.isPersistent)
    XCTAssertEqual(usage.resetAt, resetAt)
    XCTAssertNotNil(usage.resetDate)
    XCTAssertEqual(usage.providers.first?.last.counts?.totalTokens, 150)
    XCTAssertEqual(usage.providers.first?.displayTotals?.totalTokens, 0)
    XCTAssertNil(usage.providers.first?.missingUsageMessage)
    let neverReset = try decodePersistent(persistentUsage([provider()]), resetCapability: false)
    XCTAssertNil(neverReset.tokenUsage?.resetDate)
    XCTAssertFalse(neverReset.supportsTokenUsageReset)
  }

  func testPersistentUsageRequiresMatchingCanonicalCapabilitiesAndMetadata() throws {
    let valid = persistentUsage([provider()])
    for capabilities in [
      ["integration-toggle-v1", "token-usage-v1"],
      ["integration-toggle-v1", "token-usage-v1", "token-usage-v2"],
      ["integration-toggle-v1", "token-usage-reset-v1"],
      ["integration-toggle-v1", "token-usage-reset-v1", "token-usage-v2"],
      ["integration-toggle-v1", "token-usage-v2", "token-usage-reset-v1", "token-usage-reset-v1"],
    ] {
      XCTAssertThrowsError(try CompanionSnapshot.decode(snapshot(valid, capabilities: capabilities)))
    }
    XCTAssertThrowsError(try decodePersistent(usage([provider()])))
    var missing = valid
    missing.removeValue(forKey: "resetAt")
    XCTAssertThrowsError(try decodePersistent(missing))
    var extra = valid
    extra["privateMetadata"] = "/private/secret-canary"
    XCTAssertThrowsError(try decodePersistent(extra))
    for invalid in [
      "2026-10-02T18:04:05Z", "2026-10-02T18:04:05.123+00:00",
      "2026-02-30T18:04:05.123Z", "2026-13-02T18:04:05.123Z", "2026-10-02T25:04:05.123Z",
      "2026-10-02T18:04:05.123Z\n", "/private/date-canary", true, 123,
    ] as [Any] {
      XCTAssertThrowsError(try decodePersistent(persistentUsage([provider()], resetAt: invalid)))
    }
  }

  func testPersistentZeroWindowAllowsOnlyMeasuredZeroTotalsAndRetainsMissingLastUsage() throws {
    let base = provider(["requests": 0, "unavailableRequests": 0, "last": ["status": "unavailable"], "totals": counts(0, 0)])
    let clean = try decodePersistent(persistentUsage([base]))
    XCTAssertNil(clean.tokenUsage?.providers.first?.last.counts)
    XCTAssertEqual(clean.tokenUsage?.providers.first?.displayTotals?.totalTokens, 0)
    for changes in [
      ["requests": -1], ["unavailableRequests": 1], ["totals": counts(1, 0)], ["totals": NSNull()],
    ] as [[String: Any]] {
      var bad = base
      bad.merge(changes) { _, value in value }
      XCTAssertThrowsError(try decodePersistent(persistentUsage([bad])))
    }
    for changes in [
      ["requests": 1, "totals": counts(0, 0)],
      ["requests": 1, "totals": counts(120, 31)],
      ["requests": 1, "unavailableRequests": 1],
      ["requests": 1, "last": ["status": "unavailable"]],
    ] as [[String: Any]] {
      XCTAssertThrowsError(try decodePersistent(persistentUsage([provider(changes)])))
    }
  }

  func testPersistentUsageSurvivesBundledActionFilteringWithoutGrantingReset() throws {
    var root = try XCTUnwrap(JSONSerialization.jsonObject(with: snapshot(persistentUsage([provider()]),
      capabilities: ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v2", "token-usage-reset-v1"])) as? [String: Any])
    root["actions"] = ["configuration-preview", "configuration-apply", "usage-reset"]
    let value = try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: root))
    let filtered = value.allowingOnly([.configurationPreview, .configurationApply], bundledBackend: true)
    XCTAssertTrue(filtered.supportsTokenUsageReset)
    XCTAssertFalse(filtered.actions.contains(.usageReset))
    XCTAssertEqual(value.tokenUsage, filtered.tokenUsage)
    XCTAssertEqual(value.transitionIdentity, filtered.transitionIdentity)
    root["capabilities"] = ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v2"]
    XCTAssertThrowsError(try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: root)))
  }
}
