import Foundation
import ServiceManagement
import XCTest
@testable import PickerMuxCompanionCore

@MainActor
final class LoginStartupTests: XCTestCase {
  func testNativeStatusesMapWithoutTreatingLookupFailureAsUnregistered() {
    XCTAssertEqual(CompanionLoginStartupStatus(.notRegistered), .notRegistered)
    XCTAssertEqual(CompanionLoginStartupStatus(.enabled), .enabled)
    XCTAssertEqual(CompanionLoginStartupStatus(.requiresApproval), .requiresApproval)
    XCTAssertEqual(CompanionLoginStartupStatus(.notFound), .notFound)
  }

  func testAlreadyNotRegisteredSkipsUnregisterAndSettling() async throws {
    try await unregisterCompanionLoginStartup(status: { .notRegistered },
      unregister: { XCTFail("Absent registration needs no operation") },
      pause: { XCTFail("No settling is needed") })
  }

  func testNeverSeenServiceNeedsExactAbsentJobProofBeforeNotFoundIsAccepted() async throws {
    var calls = 0
    try await unregisterCompanionLoginStartup(status: { .notFound }, unregister: {
      calls += 1
      throw NSError(domain: companionServiceManagementErrorDomain(), code: kSMErrorJobNotFound)
    }, pause: { XCTFail("Already-absent proof must not wait") })
    XCTAssertEqual(calls, 1)
  }

  func testSuccessfulUnregisterAlsoProvesAbsentFinalLookup() async throws {
    for initial in [CompanionLoginStartupStatus.notFound, .enabled, .requiresApproval] {
      var statusCalls = 0
      var calls = 0
      try await unregisterCompanionLoginStartup(status: {
        statusCalls += 1
        return statusCalls == 1 ? initial : .notFound
      }, unregister: { calls += 1 }, pause: { XCTFail("Completed absent service needs no wait") })
      XCTAssertEqual(calls, 1)
      XCTAssertEqual(statusCalls, 2)
    }
  }

  func testRegisteredAndApprovalPendingStatesWaitForBoundedSettlement() async throws {
    for initial in [CompanionLoginStartupStatus.enabled, .requiresApproval] {
      var statuses = [initial, initial, .unknown, .notRegistered]
      var waits = 0
      var unregisters = 0
      try await unregisterCompanionLoginStartup(status: { statuses.removeFirst() },
        unregister: { unregisters += 1 }, pause: { waits += 1 }, maximumChecks: 3)
      XCTAssertEqual(unregisters, 1)
      XCTAssertEqual(waits, 2)
      XCTAssertTrue(statuses.isEmpty)
    }
  }

  func testPersistentRegistrationBlocksAfterBoundedSettlementEvenWithAbsentJobError() async throws {
    for status in [CompanionLoginStartupStatus.enabled, .requiresApproval] {
      for alreadyAbsent in [false, true] {
        var waits = 0
        do {
          try await unregisterCompanionLoginStartup(status: { status }, unregister: {
            if alreadyAbsent { throw NSError(domain: companionServiceManagementErrorDomain(), code: kSMErrorJobNotFound) }
          }, pause: { waits += 1 }, maximumChecks: 3)
          XCTFail("Still-registered state must block removal")
        } catch { XCTAssertEqual(error as? CompanionLoginStartupFailure, .stillRegistered) }
        XCTAssertEqual(waits, 2)
      }
    }
  }

  func testUnknownInitialStatusFailsBeforeMutationAndUnknownFinalStatusRemainsBlocked() async throws {
    do {
      try await unregisterCompanionLoginStartup(status: { .unknown }, unregister: { XCTFail("Unknown initial state") })
      XCTFail("Unknown initial state must fail")
    } catch { XCTAssertEqual(error as? CompanionLoginStartupFailure, .unverified) }
    var reads = 0
    var waits = 0
    do {
      try await unregisterCompanionLoginStartup(status: { reads += 1; return reads == 1 ? .enabled : .unknown },
        unregister: {}, pause: { waits += 1 }, maximumChecks: 3)
      XCTFail("Unknown final state must fail")
    } catch { XCTAssertEqual(error as? CompanionLoginStartupFailure, .unverified) }
    XCTAssertEqual(reads, 4)
    XCTAssertEqual(waits, 2)
  }

  func testJobNotFoundNumberInForeignDomainsCannotAuthorizeRemoval() async throws {
    for domain in [NSPOSIXErrorDomain, NSCocoaErrorDomain, "com.example.failure", "SMAppServiceErrorDomain-extra", "kSMErrorDomainFramework"] {
      let failure = NSError(domain: domain, code: kSMErrorJobNotFound)
      XCTAssertFalse(isAbsentCompanionLoginStartupError(failure))
      var reads = 0
      do {
        try await unregisterCompanionLoginStartup(status: { reads += 1; return reads == 1 ? .notFound : .notRegistered },
          unregister: { throw failure }, pause: { XCTFail("Foreign errors cannot reach settling") })
        XCTFail("A foreign error cannot prove absence")
      } catch { XCTAssertEqual(error as? CompanionLoginStartupFailure, .unregisterFailed) }
      XCTAssertEqual(reads, 1)
    }
  }

  func testGenuineFrameworkErrorsBlockEvenIfAnotherStatusWouldLookAbsent() async throws {
    let failures: [(Int, CompanionLoginStartupFailure)] = [
      (kSMErrorInvalidSignature, .invalidSignature), (kSMErrorAuthorizationFailure, .permissionDenied),
      (kSMErrorLaunchDeniedByUser, .permissionDenied), (kSMErrorServiceUnavailable, .serviceUnavailable),
      (kSMErrorInternalFailure, .unregisterFailed), (kSMErrorJobPlistNotFound, .unregisterFailed),
      (999, .unregisterFailed),
    ]
    for (code, expected) in failures {
      var reads = 0
      let failure = NSError(domain: companionServiceManagementErrorDomain(), code: code, userInfo: [NSLocalizedDescriptionKey: "/private/secret-canary"])
      XCTAssertFalse(isAbsentCompanionLoginStartupError(failure))
      do {
        try await unregisterCompanionLoginStartup(status: { reads += 1; return reads == 1 ? .enabled : .notRegistered },
          unregister: { throw failure }, pause: { XCTFail("Genuine error cannot reach settling") })
        XCTFail("A genuine error cannot authorize purge")
      } catch { XCTAssertEqual(error as? CompanionLoginStartupFailure, expected) }
      XCTAssertEqual(reads, 1)
      let message = CompanionRemovalState.failed(expected.code).notice ?? ""
      XCTAssertTrue(message.contains("integration and CLI were retained"))
      XCTAssertFalse(message.contains("secret-canary"))
      XCTAssertFalse(message.contains("Nothing was removed"))
    }
  }

  func testCancellationBeforeUnregisterPreventsAnyStatusReadOrMutation() async {
    let task = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      do {
        try await unregisterCompanionLoginStartup(status: { XCTFail("Cancelled task must not read status"); return .enabled },
          unregister: { XCTFail("Cancelled task must not unregister") })
        XCTFail("Cancellation must propagate")
      } catch { XCTAssertTrue(error is CancellationError) }
    }
    await task.value
  }

  func testCancellationAfterUnregisterPreventsVerificationAndPurge() async {
    let task = Task {
      var reads = 0
      do {
        try await unregisterCompanionLoginStartup(status: { reads += 1; return .enabled }, unregister: {
          withUnsafeCurrentTask { $0?.cancel() }
        })
        XCTFail("Cancellation must propagate after unregister")
      } catch { XCTAssertTrue(error is CancellationError) }
      XCTAssertEqual(reads, 1)
    }
    await task.value
  }

  func testCancellationDuringFakeSettlementStopsImmediately() async {
    var waits = 0
    do {
      try await unregisterCompanionLoginStartup(status: { .enabled }, unregister: {}, pause: {
        waits += 1
        throw CancellationError()
      }, maximumChecks: 3)
      XCTFail("Cancelled settlement must fail")
    } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(waits, 1)
  }

  func testInvalidSettlementBoundsFailBeforeReadingOrUnregistering() async {
    for checks in [0, 32] {
      do {
        try await unregisterCompanionLoginStartup(status: { XCTFail("Invalid bound"); return .enabled },
          unregister: { XCTFail("Invalid bound") }, maximumChecks: checks)
        XCTFail("Invalid bound must fail")
      } catch { XCTAssertEqual(error as? CompanionLoginStartupFailure, .unverified) }
    }
  }
}
