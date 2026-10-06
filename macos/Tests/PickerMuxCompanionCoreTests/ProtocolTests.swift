import Foundation
import XCTest
@testable import PickerMuxCompanionCore

final class ProtocolTests: XCTestCase {
  func testNodeFailureGuidanceDistinguishesAbsentAndRejectedInstallations() {
    XCTAssertNotEqual(CompanionFailure.missingNode.message, CompanionFailure.unsafeNode.message)
    XCTAssertTrue(CompanionFailure.missingNode.message.contains("22.15"))
    XCTAssertTrue(CompanionFailure.unsafeNode.message.contains("installed"))
    XCTAssertTrue(CompanionFailure.unsafeNode.message.contains("review"))
    XCTAssertFalse(CompanionFailure.unsafeNode.message.contains("Install Node"))
    XCTAssertFalse(CompanionFailure.unsafeNode.message.contains("/"))
  }

  func snapshot(_ changes: [String: Any] = [:]) throws -> Data {
    var value: [String: Any] = [
      "schemaVersion": 1, "capabilities": ["integration-toggle-v1"], "version": "0.8.3", "state": "ready",
      "desktop": ["status": "closed"], "installation": ["status": "installed"],
      "managedConfig": ["status": "managed"], "service": ["status": "running"],
      "compatibility": ["status": "compatible"], "accountCache": ["status": "valid"],
      "recovery": ["status": "idle", "phase": NSNull(), "operationId": NSNull()],
      "integration": ["status": "pickermux"], "actions": ["refresh", "open"], "issues": [],
    ]
    value.merge(changes) { _, new in new }
    return try JSONSerialization.data(withJSONObject: value)
  }

  func testCurrentSchemaAcceptsOnlyBoundedPublicFields() throws {
    let value = try CompanionSnapshot.decode(snapshot())
    XCTAssertEqual(value.actions, [.refresh, .open])
    XCTAssertEqual(value.state, "ready")
    for changes in [
      ["schemaVersion": 2], ["version": "/private/config"], ["unexpected": "value"],
      ["capabilities": []], ["capabilities": ["integration-toggle-v2"]],
      ["capabilities": ["integration-toggle-v1", "integration-toggle-v1"]], ["usesBundledBackend": true],
      ["actions": ["refresh", "refresh"]], ["actions": ["shell"]],
      ["service": ["status": "http://127.0.0.1/private"]],
      ["recovery": ["status": "active", "phase": "unknown"]],
    ] as [[String: Any]] {
      XCTAssertThrowsError(try CompanionSnapshot.decode(snapshot(changes)))
    }
  }

  func testNativeOnlyProviderConfigurationIsCapabilityBoundAndRedacted() throws {
    let capabilities = ["integration-toggle-v1", "native-uninstall-v1",
      "native-only-lmstudio-setup-v1", "token-usage-v1"]
    let tokenUsage: [String: Any] = ["schemaVersion": 1, "status": "unavailable", "providers": []]
    let actions = ["lmstudio-default-preview", "lmstudio-default-apply"]
    let value = try CompanionSnapshot.decode(snapshot([
      "capabilities": capabilities, "providerConfiguration": ["status": "native-only"],
      "tokenUsage": tokenUsage, "actions": actions,
    ]))
    XCTAssertTrue(value.supportsNativeOnlyLMStudioSetup)
    XCTAssertEqual(value.providerConfiguration?.status, .nativeOnly)
    XCTAssertEqual(value.actions, [.lmStudioDefaultPreview, .lmStudioDefaultApply])

    for changes in [
      ["capabilities": capabilities, "tokenUsage": tokenUsage],
      ["providerConfiguration": ["status": "native-only"]],
      ["capabilities": capabilities, "providerConfiguration": ["status": "native-only", "model": "secret-model"], "tokenUsage": tokenUsage],
      ["capabilities": capabilities, "providerConfiguration": ["status": "future"], "tokenUsage": tokenUsage],
      ["capabilities": capabilities, "providerConfiguration": ["status": "native-only"], "tokenUsage": tokenUsage, "actions": ["lmstudio-default-preview"]],
      ["capabilities": capabilities, "providerConfiguration": ["status": "external"], "tokenUsage": tokenUsage, "actions": actions],
    ] as [[String: Any]] {
      XCTAssertThrowsError(try CompanionSnapshot.decode(snapshot(changes)))
    }
  }

  func testLMStudioSetupRequiresExactPreviewReceiptAndConsent() throws {
    let token = String(repeating: "c", count: 64)
    let preview: [String: Any] = [
      "action": "lmstudio-default-preview", "status": "native-only", "canApply": true,
      "requiresConfirmation": true, "changes": LMStudioDefaultPreview.expectedChanges,
      "previewToken": token,
    ]
    let envelope: [String: Any] = ["schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": preview]
    let decoded = try CompanionResult.decode(JSONSerialization.data(withJSONObject: envelope))
    XCTAssertNil(decoded.preview)
    XCTAssertEqual(decoded.lmStudioDefaultPreview?.changes, LMStudioDefaultPreview.expectedChanges)
    XCTAssertEqual(decoded.lmStudioDefaultPreview?.previewToken, token)

    for changes in [
      ["status": "external"], ["canApply": false], ["requiresConfirmation": false],
      ["changes": Array(LMStudioDefaultPreview.expectedChanges.reversed())],
      ["changes": ["enable-bundled-lmstudio"]], ["previewToken": String(repeating: "C", count: 64)],
      ["previewToken": String(repeating: "c", count: 63)], ["endpoint": "http://127.0.0.1/private"],
      ["action": "future-provider-preview"],
    ] as [[String: Any]] {
      var invalid = preview
      invalid.merge(changes) { _, new in new }
      XCTAssertThrowsError(try CompanionResult.decode(JSONSerialization.data(withJSONObject: [
        "schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": invalid,
      ])))
    }
    var missingToken = preview
    missingToken.removeValue(forKey: "previewToken")
    XCTAssertThrowsError(try CompanionResult.decode(JSONSerialization.data(withJSONObject: [
      "schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": missingToken,
    ])))

    XCTAssertThrowsError(try actionRequest(.lmStudioDefaultPreview, confirmed: true))
    XCTAssertThrowsError(try actionRequest(.lmStudioDefaultPreview, previewToken: token))
    let previewRequest = try XCTUnwrap(JSONSerialization.jsonObject(with:
      actionRequest(.lmStudioDefaultPreview)) as? [String: Any])
    XCTAssertEqual(previewRequest as NSDictionary,
      ["schemaVersion": 1, "action": "lmstudio-default-preview"] as NSDictionary)
    XCTAssertThrowsError(try actionRequest(.lmStudioDefaultApply, confirmed: true))
    XCTAssertThrowsError(try actionRequest(.lmStudioDefaultApply, confirmed: false, previewToken: token))
    XCTAssertThrowsError(try actionRequest(.lmStudioDefaultApply, confirmed: true,
      previewToken: String(repeating: "C", count: 64)))
    let request = try XCTUnwrap(JSONSerialization.jsonObject(with:
      actionRequest(.lmStudioDefaultApply, confirmed: true, previewToken: token)) as? [String: Any])
    XCTAssertEqual(Set(request.keys), Set(["schemaVersion", "action", "confirmation", "previewToken"]))
    XCTAssertEqual(request["confirmation"] as? [String: Bool], ["enableBundledLmStudio": true])
    XCTAssertEqual(request["previewToken"] as? String, token)
  }

  func testLMStudioApplyRequiresExactCompletionReceiptAndRejectsUnknownActions() throws {
    let completion: [String: Any] = [
      "action": "lmstudio-default-apply", "status": "applied", "updated": true,
      "restartRequired": true, "certificationIncomplete": false, "version": "0.30.0",
    ]
    let result = try CompanionResult.decode(JSONSerialization.data(withJSONObject: [
      "schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": completion,
    ]))
    XCTAssertEqual(result.lmStudioDefaultApply?.status, "applied")
    XCTAssertTrue(try XCTUnwrap(result.lmStudioDefaultApply?.restartRequired))
    XCTAssertEqual(result.lmStudioDefaultApply?.version, "0.30.0")

    for changes in [
      ["status": "ready"], ["updated": false], ["restartRequired": false],
      ["version": "0.30.0/private"], ["model": "secret-model"],
      ["version": NSNull()], ["certificationIncomplete": NSNull()],
      ["action": "future-provider-apply"],
    ] as [[String: Any]] {
      var invalid = completion
      invalid.merge(changes) { _, new in new }
      XCTAssertThrowsError(try CompanionResult.decode(JSONSerialization.data(withJSONObject: [
        "schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": invalid,
      ])))
    }
    for field in ["action", "status", "updated", "restartRequired"] {
      var invalid = completion
      invalid.removeValue(forKey: field)
      XCTAssertThrowsError(try CompanionResult.decode(JSONSerialization.data(withJSONObject: [
        "schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": invalid,
      ])), "Missing \(field)")
    }
    XCTAssertThrowsError(try CompanionResult.decode(Data(
      #"{"schemaVersion":1,"ok":true,"code":"COMPLETE","data":{"action":"future-action"}}"#.utf8)))
  }

  func testRecoveryConfirmationCannotBeImplicitOrReused() throws {
    for action in [CompanionAction.recover, .fullRefresh] {
      XCTAssertThrowsError(try actionRequest(action))
      let data = try actionRequest(action, confirmed: true)
      let request = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
      XCTAssertEqual(request["action"] as? String, action.rawValue)
      XCTAssertEqual(request["confirmation"] as? [String: Bool], ["quitCodexTwice": true, "interruptTasks": true, "invalidateCompaction": true])
      XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("FULL"))
      XCTAssertThrowsError(try actionRequest(action))
    }
    XCTAssertEqual(CompanionAction.fullRefresh.label, "Full refresh…")
    XCTAssertEqual(CompanionAction.fullRefresh.timeout, 600)
  }

  func testCurrentSchemaAcceptsExplicitFullRefreshAction() throws {
    let value = try CompanionSnapshot.decode(snapshot(["actions": ["refresh", "full-refresh"]]))
    XCTAssertEqual(value.actions, [.refresh, .fullRefresh])
  }

  func testRecoveryStartReceiptRequiresExactSafeFields() throws {
    let operationId = "1804ad9d-4eb2-43f4-95e5-a3b5a1f4b9da"
    for action in ["full-refresh", "recover"] {
      let fields: [String: Any] = [
        "action": action, "started": true, "resumed": false, "operationId": operationId,
      ]
      let encoded = try JSONSerialization.data(withJSONObject: [
        "schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": fields,
      ])
      let result = try CompanionResult.decode(encoded)
      XCTAssertEqual(result.recoveryStart?.action, action)
      XCTAssertEqual(result.recoveryStart?.operationId, operationId)
      for changes in [
        ["started": false], ["started": "true"], ["resumed": "false"],
        ["operationId": "private-path"], ["action": "refresh"], ["unexpected": "/private/canary"],
      ] as [[String: Any]] {
        var invalid = fields
        invalid.merge(changes) { _, value in value }
        let data = try JSONSerialization.data(withJSONObject: [
          "schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": invalid,
        ])
        XCTAssertThrowsError(try CompanionResult.decode(data), "\(action): \(changes)")
      }
      for field in fields.keys {
        var missing = fields
        missing.removeValue(forKey: field)
        let data = try JSONSerialization.data(withJSONObject: [
          "schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": missing,
        ])
        XCTAssertThrowsError(try CompanionResult.decode(data), "\(action) missing \(field)")
      }
    }
  }

  func testNativeUninstallRequiresItsCapabilityBoundPreviewAndExactConsent() throws {
    let capabilities = ["integration-toggle-v1", "native-uninstall-v1"]
    let value = try CompanionSnapshot.decode(snapshot(["capabilities": capabilities, "actions": ["uninstall-preview", "uninstall"]]))
    XCTAssertTrue(value.supportsNativeUninstall)
    XCTAssertThrowsError(try CompanionSnapshot.decode(snapshot(["actions": ["uninstall"]])))
    XCTAssertThrowsError(try CompanionSnapshot.decode(snapshot(["capabilities": capabilities.reversed().map { $0 }])))
    XCTAssertThrowsError(try actionRequest(.uninstall))
    XCTAssertThrowsError(try actionRequest(.uninstall, confirmed: true))
    XCTAssertThrowsError(try actionRequest(.uninstall, confirmed: false, previewToken: String(repeating: "a", count: 64)))
    let request = try XCTUnwrap(JSONSerialization.jsonObject(with: actionRequest(.uninstall, confirmed: true, previewToken: String(repeating: "a", count: 64))) as? [String: Any])
    XCTAssertEqual(Set(request.keys), Set(["schemaVersion", "action", "confirmation", "previewToken"]))
    XCTAssertEqual(request["confirmation"] as? [String: Bool], ["removePickerMux": true, "restoreNativeCodex": true, "deleteProviderCredentials": true, "deleteBackups": true])
  }

  func testRemovalCompletionRejectsPartialFlagsAndUnexpectedPublicFields() throws {
    let base: [String: Any] = ["action": "uninstall", "status": "removed", "removed": true, "nativeRestored": true, "historicalChatsPreserved": true, "restartRequired": true]
    for changes in [["removed": false], ["nativeRestored": false], ["historicalChatsPreserved": false], ["restartRequired": false], ["action": "configuration-apply"], ["unexpected": "/private/secret"]] as [[String: Any]] {
      var data = base
      data.merge(changes) { _, new in new }
      XCTAssertThrowsError(try CompanionResult.decode(JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": data])))
    }
    var preview: [String: Any] = ["action": "uninstall-preview", "status": "ready", "canApply": true, "previewToken": String(repeating: "b", count: 64), "changes": UninstallPreview.expectedChanges]
    preview["changes"] = ["delete-unrelated-files"]
    XCTAssertThrowsError(try CompanionResult.decode(JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "ok": true, "code": "PREVIEW_READY", "data": preview])))
  }

  func testConfigurationApplyRequiresBoundPreviewAndConfirmation() throws {
    XCTAssertThrowsError(try actionRequest(.configurationApply, confirmed: true))
    XCTAssertThrowsError(try actionRequest(.configurationApply, confirmed: false, previewToken: String(repeating: "a", count: 64)))
    let token = String(repeating: "a", count: 64)
    let request = try JSONSerialization.jsonObject(with: actionRequest(.configurationApply, confirmed: true, previewToken: token)) as? [String: Any]
    XCTAssertEqual(request?["previewToken"] as? String, token)
    XCTAssertEqual(request?["confirmation"] as? [String: Bool], ["replaceIntegration": true])
  }

  func testIntegrationDeactivationHasItsOwnExplicitConsent() throws {
    XCTAssertThrowsError(try actionRequest(.integrationDeactivate))
    let request = try XCTUnwrap(JSONSerialization.jsonObject(with: actionRequest(.integrationDeactivate, confirmed: true)) as? [String: Any])
    XCTAssertEqual(Set(request.keys), Set(["schemaVersion", "action", "confirmation"]))
    XCTAssertEqual(request["action"] as? String, "integration-deactivate")
    XCTAssertEqual(request["confirmation"] as? [String: Bool], ["deactivateIntegration": true])
  }

  func testActionableFailuresUseFixedSafeGuidance() {
    XCTAssertTrue(companionActionFailureMessage("PROVIDER_UNAVAILABLE").contains("could not be reached during setup"))
    XCTAssertTrue(companionActionFailureMessage("NO_LOADED_MODELS").contains("Load"))
    XCTAssertTrue(companionActionFailureMessage("ACCOUNT_CACHE_REFRESH_REQUIRED").contains("signed in"))
    XCTAssertTrue(companionActionFailureMessage("DEACTIVATION_ROLLBACK_FAILED").contains("Check status"))
    XCTAssertFalse(companionActionFailureMessage("token=private-value").contains("private-value"))
  }

  func testProviderFailureGuidanceDistinguishesReachabilityTimeoutPermissionAuthAndResponse() throws {
    let remedies = [
      "PROVIDER_UNAVAILABLE": "configured server",
      "PROVIDER_TIMEOUT": "did not respond in time",
      "PROVIDER_PERMISSION_DENIED": "Privacy & Security",
      "PROVIDER_AUTH_REQUIRED": "credentials",
      "PROVIDER_RESPONSE_INVALID": "API compatibility",
      "NO_LOADED_MODELS": "Load a model",
    ]
    XCTAssertEqual(Set(remedies.keys.map(companionActionFailureMessage)).count, remedies.count)
    for (code, remedy) in remedies {
      let message = companionActionFailureMessage(code)
      XCTAssertTrue(message.contains(remedy), "Each fixed failure needs its specific remedy")
      XCTAssertTrue(message.contains("during setup") || code == "PROVIDER_PERMISSION_DENIED")
      XCTAssertFalse(message.contains("LM Studio"), "The configured provider must not be guessed")
      let result = try CompanionResult.decode(JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "ok": false, "code": code]))
      XCTAssertEqual(result.code, code)
      XCTAssertFalse(result.ok)
    }
    for canary in ["/private/provider-secret", "http://127.0.0.1/private-capability", "PROVIDER_TIMEOUT token=secret-canary", "provider/model-canary"] {
      let message = companionActionFailureMessage(canary)
      XCTAssertFalse(message.contains(canary))
      XCTAssertFalse(message.contains("secret-canary"))
      XCTAssertFalse(message.contains("model-canary"))
      XCTAssertFalse(message.contains("unavailable"), "An unknown failure must not invent a reachability diagnosis")
    }
  }

  func testPreviewAndUpdateDecodePublicDataOnly() throws {
    let token = String(repeating: "b", count: 64)
    let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "ok": true, "code": "PREVIEW_READY", "data": ["schemaVersion": 1, "status": "ollama", "canApply": true, "requiresConfirmation": true, "changes": ["activate-pickermux"], "previewToken": token]])
    XCTAssertEqual(try CompanionResult.decode(data).preview?.previewToken, token)
    let update = Data(#"{"schemaVersion":1,"ok":true,"code":"UPDATE_AVAILABLE","data":{"status":"available","currentVersion":"0.8.3","targetVersion":"0.9.0"}}"#.utf8)
    XCTAssertEqual(try CompanionResult.decode(update).update?.targetVersion, "0.9.0")
    XCTAssertThrowsError(try CompanionResult.decode(Data(#"{"schemaVersion":2,"ok":true,"code":"OK"}"#.utf8)))
    XCTAssertThrowsError(try CompanionResult.decode(Data(#"{"schemaVersion":1,"ok":false,"code":"token=private"}"#.utf8)))
  }

  func testUpdateDistributionAcceptsOnlyKnownKindsAndRejectsMalformedOptionalDecode() throws {
    let base: [String: Any] = ["action": "update-check", "status": "available", "currentVersion": "0.10.0", "targetVersion": "0.11.0"]
    for distribution in ["dmg", "cli-archive"] {
      var fields = base
      fields["distribution"] = distribution
      let result = try CompanionResult.decode(JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": fields]))
      XCTAssertEqual(result.update?.distribution, distribution)
    }
    for changes in [
      ["distribution": "https://evil.example/download.dmg"], ["distribution": "cli"], ["distribution": true], ["distribution": ["dmg"]],
      ["url": "https://evil.example/download.dmg"], ["downloadUrl": "https://evil.example/download.dmg"],
      ["currentVersion": 10], ["targetVersion": "0.11.0/private"], ["status": false],
    ] as [[String: Any]] {
      var fields = base
      fields.merge(changes) { _, new in new }
      XCTAssertThrowsError(try CompanionResult.decode(JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": fields])))
    }
    let legacy = try CompanionResult.decode(JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": base]))
    XCTAssertNil(legacy.update?.distribution)
    for changes in [["targetVersion": NSNull()], ["targetVersion": "0.10.0"], ["targetVersion": "0.9.6"],
      ["targetVersion": "0.11.0-beta"], ["targetVersion": "00.11.0"], ["currentVersion": "0.10.0-beta"],
      ["currentVersion": "00.10.0"]] as [[String: Any]] {
      var fields = base
      fields["distribution"] = "dmg"
      fields.merge(changes) { _, new in new }
      XCTAssertThrowsError(try CompanionResult.decode(JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "ok": true, "code": "COMPLETE", "data": fields])))
    }
    XCTAssertTrue(companionActionFailureMessage("DOWNLOAD_REQUIRED").contains("DMG"))
    XCTAssertFalse(companionActionFailureMessage("DOWNLOAD_REQUIRED").contains("force"))
  }

  func testUnknownStatusDoesNotExposeRawContent() {
    XCTAssertEqual(statusLabel("/private/secret"), "Needs review")
    XCTAssertEqual(statusLabel("future-safe-token"), "Needs review")
  }

  func testRecoveryCompletionNoticeSurvivesCheckpointCleanupAndStaysQuietInitially() throws {
    let ready = try CompanionSnapshot.decode(snapshot())
    let pending = try CompanionSnapshot.decode(snapshot(["state": "recovery-pending", "recovery": ["status": "pending", "phase": "reactivated", "operationId": "f395a074-1550-4f7d-b749-1e911eb333b8"]]))
    XCTAssertFalse(shouldNotifyRecoveryCompletion(previous: nil, next: ready))
    XCTAssertFalse(shouldNotifyRecoveryCompletion(previous: ready, next: ready))
    XCTAssertFalse(shouldNotifyRecoveryCompletion(previous: pending, next: pending))
    XCTAssertTrue(shouldNotifyRecoveryCompletion(previous: pending, next: ready))
  }

  func testEnvironmentDropsCredentialAndCodexOverrides() {
    let environment = companionEnvironment(home: URL(fileURLWithPath: "/temporary/home"), temporaryDirectory: URL(fileURLWithPath: "/temporary/cache"))
    XCTAssertEqual(Set(environment.keys), Set(["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL"]))
    XCTAssertFalse(environment["PATH"]!.contains(".local"))
    XCTAssertNil(environment["CODEX_HOME"])
    XCTAssertNil(environment["OPENAI_API_KEY"])
  }
}
