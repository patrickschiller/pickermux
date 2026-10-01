import Foundation

public enum CompanionOperationKind: Equatable {
  case status
  case action
}

public struct CompanionOperationLease: Equatable {
  private let id = UUID()
  public let kind: CompanionOperationKind

  fileprivate init(kind: CompanionOperationKind) { self.kind = kind }
}

// Polls, manual checks and actions share one lane so an older observation cannot
// replace a newer action result. Manual checks wait rather than disappearing.
@MainActor
public final class CompanionOperationQueue {
  private var active: CompanionOperationLease?
  private var waiting = [(CompanionOperationLease, CheckedContinuation<CompanionOperationLease, Never>)]()

  public init() {}
  public var isIdle: Bool { active == nil }
  public var waitingCount: Int { waiting.count }

  public func acquire(_ kind: CompanionOperationKind) async -> CompanionOperationLease {
    let lease = CompanionOperationLease(kind: kind)
    guard active != nil else { active = lease; return lease }
    return await withCheckedContinuation { waiting.append((lease, $0)) }
  }

  @discardableResult
  public func release(_ lease: CompanionOperationLease) -> Bool {
    guard active == lease else { return false }
    if waiting.isEmpty {
      active = nil
    } else {
      let next = waiting.removeFirst()
      active = next.0
      next.1.resume(returning: next.0)
    }
    return true
  }
}
