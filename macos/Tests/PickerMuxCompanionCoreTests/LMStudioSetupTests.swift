import Foundation
import XCTest
@testable import PickerMuxCompanionCore

@MainActor
final class LMStudioSetupTests: XCTestCase {
  func testConfirmedNativeOnlySetupUsesExactPreviewTokenAndConsent() async throws {
    let client = LMStudioSetupClient()
    var captured: LMStudioSetupReview?
    let outcome = try await enableDefaultLMStudioModels(client: client) { review in
      captured = review
      return true
    }
    guard case .completed(let result) = outcome else { return XCTFail("Expected completed setup") }
    XCTAssertTrue(result.ok)
    XCTAssertEqual(client.requests.map(\.action), [.lmStudioDefaultPreview, .lmStudioDefaultApply])
    XCTAssertEqual(client.requests.map(\.confirmed), [false, true])
    XCTAssertNil(client.requests.first?.token)
    XCTAssertEqual(client.requests.last?.token, String(repeating: "c", count: 64))
    let review = try XCTUnwrap(captured)
    XCTAssertEqual(review.title, "Enable LM Studio models?")
    XCTAssertEqual(review.button, "Enable LM Studio")
    for required in ["Codex is fully closed", "models you want to use are loaded", "live certification prompts",
                     "Existing bridge settings", "external provider configuration cannot be overwritten"] {
      XCTAssertTrue(review.text.contains(required), required)
    }
    XCTAssertFalse(review.text.contains("127.0.0.1"))
  }

  func testCancelledSetupNeverAppliesThePreview() async throws {
    let client = LMStudioSetupClient()
    let outcome = try await enableDefaultLMStudioModels(client: client) { _ in false }
    guard case .cancelled = outcome else { return XCTFail("Expected cancelled setup") }
    XCTAssertEqual(client.requests.map(\.action), [.lmStudioDefaultPreview])
    XCTAssertEqual(client.statusCalls, 1)
  }

  func testExternalConfigurationBeforeOrAfterPreviewIsNeverOverwritten() async throws {
    let external = LMStudioSetupClient()
    external.initial = try setupSnapshot(provider: .external)
    var confirmed = false
    let initialOutcome = try await enableDefaultLMStudioModels(client: external) { _ in
      confirmed = true
      return true
    }
    guard case .blocked = initialOutcome else { return XCTFail("Expected external setup to be blocked") }
    XCTAssertFalse(confirmed)
    XCTAssertTrue(external.requests.isEmpty)

    let changed = LMStudioSetupClient()
    changed.afterPreview = try setupSnapshot(provider: .external)
    let changedOutcome = try await enableDefaultLMStudioModels(client: changed) { _ in true }
    guard case .blocked = changedOutcome else { return XCTFail("Expected changed setup to be blocked") }
    XCTAssertEqual(changed.requests.map(\.action), [.lmStudioDefaultPreview])
  }

  func testStaleApplyFailureIsReturnedWithoutRetry() async throws {
    let client = LMStudioSetupClient()
    client.applyResult = try CompanionResult.decode(Data(
      #"{"schemaVersion":1,"ok":false,"code":"PREVIEW_STALE"}"#.utf8))
    let outcome = try await enableDefaultLMStudioModels(client: client) { _ in true }
    guard case .completed(let result) = outcome else { return XCTFail("Expected failed result") }
    XCTAssertFalse(result.ok)
    XCTAssertEqual(result.code, "PREVIEW_STALE")
    XCTAssertEqual(client.requests.map(\.action), [.lmStudioDefaultPreview, .lmStudioDefaultApply])
  }
}

private func setupSnapshot(provider: ProviderConfigurationKind = .nativeOnly) throws -> CompanionSnapshot {
  let actions = provider == .nativeOnly ?
    ["lmstudio-default-preview", "lmstudio-default-apply"] : []
  return try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: [
    "schemaVersion": 1,
    "capabilities": ["integration-toggle-v1", "native-uninstall-v1",
      "native-only-lmstudio-setup-v1", "token-usage-v1"],
    "version": "0.30.0", "state": "ready",
    "desktop": ["status": "stopped"], "installation": ["status": "installed"],
    "managedConfig": ["status": "installed"], "service": ["status": "running"],
    "compatibility": ["status": "compatible"], "accountCache": ["status": "ready"],
    "recovery": ["status": "idle"], "integration": ["status": "pickermux"],
    "providerConfiguration": ["status": provider.rawValue], "actions": actions, "issues": [],
    "tokenUsage": ["schemaVersion": 1, "status": "unavailable", "providers": []],
  ]))
}

private final class LMStudioSetupClient: CompanionControlling {
  struct Request {
    let action: CompanionAction
    let confirmed: Bool
    let token: String?
  }

  var initial = try! setupSnapshot()
  var afterPreview: CompanionSnapshot?
  var statusCalls = 0
  var requests = [Request]()
  var previewResult = try! CompanionResult.decode(Data("""
    {"schemaVersion":1,"ok":true,"code":"COMPLETE","data":{"action":"lmstudio-default-preview","status":"native-only","canApply":true,"requiresConfirmation":true,"changes":["enable-bundled-lmstudio","preserve-bridge-settings","preserve-user-settings","preserve-historical-chats","restore-on-failure"],"previewToken":"\(String(repeating: "c", count: 64))"}}
    """.utf8))
  var applyResult = try! CompanionResult.decode(Data(
    #"{"schemaVersion":1,"ok":true,"code":"COMPLETE","data":{"action":"lmstudio-default-apply","status":"applied","updated":true,"restartRequired":true,"certificationIncomplete":false,"version":"0.30.0"}}"#.utf8))

  func status() async throws -> CompanionSnapshot {
    statusCalls += 1
    return statusCalls > 1 ? (afterPreview ?? initial) : initial
  }

  func run(_ action: CompanionAction, confirmed: Bool, previewToken: String?) async throws -> CompanionResult {
    requests.append(Request(action: action, confirmed: confirmed, token: previewToken))
    switch action {
    case .lmStudioDefaultPreview: return previewResult
    case .lmStudioDefaultApply: return applyResult
    default: throw CompanionFailure.incompatibleProtocol
    }
  }
}
