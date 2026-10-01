import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class AppDistributionTests: XCTestCase {
  func testCanonicalVersionsCompareNumericallyAndRejectAmbiguousInput() {
    XCTAssertEqual(compareCompanionVersions("0.10.0", "0.9.6"), 1)
    XCTAssertEqual(compareCompanionVersions("0.10.0", "0.10.0"), 0)
    XCTAssertEqual(compareCompanionVersions("0.10.0", "1.0.0"), -1)
    XCTAssertEqual(compareCompanionVersions("999999.0.0", "1.0.0"), 1)
    for version in ["", "0.10", "v0.10.0", "00.10.0", "0.010.0", "0.10.00",
      "0.10.0-beta", "0.10.0\n", "-1.0.0", "+1.0.0", "1000000.0.0", "1.0.0/other"] {
      XCTAssertNil(compareCompanionVersions(version, "0.10.0"), version)
      XCTAssertNil(compareCompanionVersions("0.10.0", version), version)
    }
  }

  func testDownloadURLIsDerivedOnlyForANewerValidatedDMGRelease() throws {
    let update = try decodeUpdate(distribution: "dmg")
    XCTAssertEqual(companionDiskImageDownloadURL(update)?.absoluteString,
      "https://github.com/patrickschiller/pickermux/releases/download/v0.10.0/PickerMux-macos-universal.dmg")
    for (status, current, target, distribution) in [
      ("current", "0.9.6", "0.10.0", "dmg"),
      ("available", "0.10.0", "0.10.0", "dmg"),
      ("available", "0.11.0", "0.10.0", "dmg"),
      ("available", "0.9.6", "0.10.0", "cli-archive"),
    ] {
      let value = try decodeUpdate(status: status, current: current, target: target, distribution: distribution)
      XCTAssertNil(companionDiskImageDownloadURL(value))
    }
    XCTAssertNil(companionDiskImageDownloadURL(try decodeUpdate(distribution: nil)))
    XCTAssertNil(companionDiskImageDownloadURL(try decodeUpdate(target: nil, distribution: "dmg")))
  }

  func testBackendUpgradeRequiresAKnownInstalledOlderVersion() throws {
    let older = try snapshot(version: "0.9.6")
    XCTAssertTrue(companionBackendUpgradeAvailable(appVersion: "0.10.0", snapshot: older))
    XCTAssertFalse(companionBackendUpgradeAvailable(appVersion: "0.9.6", snapshot: older))
    XCTAssertFalse(companionBackendUpgradeAvailable(appVersion: "0.9.5", snapshot: older))
    XCTAssertFalse(companionBackendUpgradeAvailable(appVersion: "v0.10.0", snapshot: older))
    XCTAssertFalse(companionBackendUpgradeAvailable(appVersion: "0.10.0", snapshot: nil))
    XCTAssertFalse(companionBackendUpgradeAvailable(appVersion: "0.10.0",
      snapshot: older.allowingOnly([.configurationPreview, .configurationApply], bundledBackend: true)))
    for state in ["not-installed", "unknown"] {
      XCTAssertFalse(companionBackendUpgradeAvailable(appVersion: "0.10.0",
        snapshot: try snapshot(version: "0.9.6", installation: state)))
    }
    XCTAssertFalse(companionBackendUpgradeAvailable(appVersion: "0.10.0",
      snapshot: try snapshot(version: "0.9.6-beta")))
  }

  private func decodeUpdate(status: String = "available", current: String = "0.9.6",
    target: String? = "0.10.0", distribution: String?) throws -> UpdateStatus {
    var value: [String: Any] = ["status": status, "currentVersion": current]
    if let target { value["targetVersion"] = target }
    if let distribution { value["distribution"] = distribution }
    return try JSONDecoder().decode(UpdateStatus.self, from: JSONSerialization.data(withJSONObject: value))
  }

  private func snapshot(version: String, installation: String = "installed") throws -> CompanionSnapshot {
    let value: [String: Any] = [
      "schemaVersion": 1, "capabilities": ["integration-toggle-v1", "native-uninstall-v1"],
      "version": version, "state": "ready", "desktop": ["status": "stopped"],
      "installation": ["status": installation], "managedConfig": ["status": "installed"],
      "service": ["status": "running"], "compatibility": ["status": "compatible"],
      "accountCache": ["status": "ready"], "recovery": ["status": "idle"],
      "integration": ["status": "pickermux"], "actions": [], "issues": [],
    ]
    return try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: value))
  }
}
