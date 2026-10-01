import Foundation
import ServiceManagement

public enum CompanionLoginStartupStatus: Equatable {
  case notRegistered, enabled, requiresApproval, notFound, unknown

  public init(_ status: SMAppService.Status) {
    switch status {
    case .notRegistered: self = .notRegistered
    case .enabled: self = .enabled
    case .requiresApproval: self = .requiresApproval
    case .notFound: self = .notFound
    @unknown default: self = .unknown
    }
  }
}

public enum CompanionLoginStartupFailure: Error, Equatable {
  case unregisterFailed, invalidSignature, permissionDenied, serviceUnavailable, stillRegistered, unverified

  public var code: String {
    switch self {
    case .unregisterFailed: return "LOGIN_UNREGISTER_FAILED"
    case .invalidSignature: return "LOGIN_SIGNATURE_INVALID"
    case .permissionDenied: return "LOGIN_PERMISSION_DENIED"
    case .serviceUnavailable: return "LOGIN_SERVICE_UNAVAILABLE"
    case .stillRegistered: return "LOGIN_STARTUP_STILL_REGISTERED"
    case .unverified: return "LOGIN_STARTUP_UNVERIFIED"
    }
  }
}

public func companionServiceManagementErrorDomain() -> String {
  if #available(macOS 15.0, *) { return SMAppServiceErrorDomain }
  // macOS 13/14 use this same runtime domain, before Apple exposed its named
  // constant in the SDK. Do not broaden this check to numeric codes alone.
  return "SMAppServiceErrorDomain"
}

public func isAbsentCompanionLoginStartupError(_ error: Error) -> Bool {
  let failure = error as NSError
  return failure.domain == companionServiceManagementErrorDomain() && failure.code == kSMErrorJobNotFound
}

private func loginStartupFailure(_ error: Error) -> CompanionLoginStartupFailure {
  let failure = error as NSError
  guard failure.domain == companionServiceManagementErrorDomain() else { return .unregisterFailed }
  switch failure.code {
  case kSMErrorInvalidSignature: return .invalidSignature
  case kSMErrorAuthorizationFailure, kSMErrorLaunchDeniedByUser: return .permissionDenied
  case kSMErrorServiceUnavailable: return .serviceUnavailable
  default: return .unregisterFailed
  }
}

// A missing lookup alone is ambiguous. Only a completed unregister or Apple's
// exact already-absent error authorizes accepting a subsequent notFound state.
@MainActor
public func unregisterCompanionLoginStartup(
  status: () -> CompanionLoginStartupStatus,
  unregister: () async throws -> Void,
  pause: () async throws -> Void = { try await Task.sleep(nanoseconds: 100_000_000) },
  maximumChecks: Int = 11
) async throws {
  guard (1...31).contains(maximumChecks) else { throw CompanionLoginStartupFailure.unverified }
  try Task.checkCancellation()
  let initial = status()
  if initial == .notRegistered { return }
  guard initial != .unknown else { throw CompanionLoginStartupFailure.unverified }
  do {
    try await unregister()
  } catch is CancellationError {
    throw CancellationError()
  } catch {
    guard isAbsentCompanionLoginStartupError(error) else { throw loginStartupFailure(error) }
  }
  var last = CompanionLoginStartupStatus.unknown
  for index in 0..<maximumChecks {
    try Task.checkCancellation()
    last = status()
    if last == .notRegistered || last == .notFound { return }
    if index + 1 < maximumChecks {
      try await pause()
      try Task.checkCancellation()
    }
  }
  throw last == .unknown ? CompanionLoginStartupFailure.unverified : CompanionLoginStartupFailure.stillRegistered
}
