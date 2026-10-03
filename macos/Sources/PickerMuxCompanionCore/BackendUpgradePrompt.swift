import Foundation

public struct BackendUpgradePrompt {
  private struct VersionPair: Hashable {
    let app: String
    let backend: String
  }

  private var reviewed = Set<VersionPair>()

  public init() {}

  // Reserve before awaiting backend validation so polling cannot repeat a
  // cancelled, failed, or still-running review during this app process.
  public mutating func reserveReview(appVersion: String, snapshot: CompanionSnapshot?, busy: Bool = false) -> Bool {
    guard !busy, let snapshot, let pair = versionPair(appVersion: appVersion, snapshot: snapshot),
          snapshot.state == "ready", snapshot.compatibility.status == "compatible" else { return false }
    let state = IntegrationToggleState(snapshot: snapshot)
    guard state.isEnabled, state.canReviewSetup else { return false }
    return reviewed.insert(pair).inserted
  }

  public mutating func markReviewed(appVersion: String, snapshot: CompanionSnapshot?) {
    guard let snapshot, let pair = versionPair(appVersion: appVersion, snapshot: snapshot) else { return }
    reviewed.insert(pair)
  }

  private func versionPair(appVersion: String, snapshot: CompanionSnapshot) -> VersionPair? {
    guard companionBackendUpgradeAvailable(appVersion: appVersion, snapshot: snapshot) else { return nil }
    return VersionPair(app: appVersion, backend: snapshot.version)
  }
}
