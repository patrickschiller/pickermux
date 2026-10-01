import Foundation

public func compareCompanionVersions(_ first: String, _ second: String) -> Int? {
  func components(_ value: String) -> [Int]? {
    let pieces = value.split(separator: ".", omittingEmptySubsequences: false)
    guard pieces.count == 3 else { return nil }
    let numbers = pieces.compactMap { Int($0) }
    guard numbers.count == 3, zip(pieces, numbers).allSatisfy({ piece, number in
      number >= 0 && number <= 999999 && String(number) == piece
    }) else { return nil }
    return numbers
  }
  guard let left = components(first), let right = components(second) else { return nil }
  for (a, b) in zip(left, right) { if a != b { return a < b ? -1 : 1 } }
  return 0
}

public func companionBackendUpgradeAvailable(appVersion: String, snapshot: CompanionSnapshot?) -> Bool {
  guard let snapshot, !snapshot.usesBundledBackend, snapshot.installation.status == "installed"
  else { return false }
  return compareCompanionVersions(appVersion, snapshot.version) == 1
}

// The backend reports only a validated distribution kind and canonical version.
// No provider-controlled or response-supplied URL can open a browser.
public func companionDiskImageDownloadURL(_ update: UpdateStatus) -> URL? {
  guard update.status == "available", update.distribution == "dmg",
        let version = update.targetVersion,
        compareCompanionVersions(version, update.currentVersion) == 1 else { return nil }
  return URL(string: "https://github.com/patrickschiller/pickermux/releases/download/v\(version)/PickerMux-macos-universal.dmg")
}
