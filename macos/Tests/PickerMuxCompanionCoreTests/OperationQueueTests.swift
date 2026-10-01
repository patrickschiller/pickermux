import Foundation
import XCTest
@testable import PickerMuxCompanionCore

@MainActor
final class OperationQueueTests: XCTestCase {
  func testManualStatusWaitsForRunningPollRatherThanBeingDropped() async {
    let queue = CompanionOperationQueue()
    let poll = await queue.acquire(.status)
    var manualCompleted = false
    let manual = Task {
      let lease = await queue.acquire(.status)
      manualCompleted = true
      XCTAssertTrue(queue.release(lease))
    }
    await waitUntil { queue.waitingCount == 1 }
    XCTAssertFalse(manualCompleted)
    XCTAssertFalse(queue.isIdle)
    XCTAssertTrue(queue.release(poll))
    await manual.value
    XCTAssertTrue(manualCompleted)
    XCTAssertTrue(queue.isIdle)
  }

  func testPollActionAndRepeatedManualChecksExecuteInRequestedOrder() async {
    let queue = CompanionOperationQueue()
    let poll = await queue.acquire(.status)
    var completions = [String]()
    let action = Task {
      let lease = await queue.acquire(.action)
      completions.append("action")
      XCTAssertEqual(lease.kind, .action)
      queue.release(lease)
    }
    await waitUntil { queue.waitingCount == 1 }
    let first = Task {
      let lease = await queue.acquire(.status)
      completions.append("first manual check")
      queue.release(lease)
    }
    await waitUntil { queue.waitingCount == 2 }
    let second = Task {
      let lease = await queue.acquire(.status)
      completions.append("second manual check")
      queue.release(lease)
    }
    await waitUntil { queue.waitingCount == 3 }
    XCTAssertTrue(completions.isEmpty)
    queue.release(poll)
    await action.value
    await first.value
    await second.value
    XCTAssertEqual(completions, ["action", "first manual check", "second manual check"])
    XCTAssertTrue(queue.isIdle)
  }

  func testRepeatedReleaseCannotUnlockAnotherOperation() async {
    let queue = CompanionOperationQueue()
    let first = await queue.acquire(.status)
    XCTAssertTrue(queue.release(first))
    let action = await queue.acquire(.action)
    XCTAssertFalse(queue.release(first))
    XCTAssertFalse(queue.isIdle)
    XCTAssertTrue(queue.release(action))
    XCTAssertTrue(queue.isIdle)
  }

  private func waitUntil(_ predicate: () -> Bool) async {
    for _ in 0..<100 {
      if predicate() { return }
      await Task.yield()
    }
    XCTFail("Queued operation did not reach its expected state")
  }
}
