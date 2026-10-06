import Foundation

public struct LMStudioSetupReview {
  public let title: String
  public let text: String
  public let button: String
}

public enum LMStudioSetupOutcome {
  case cancelled
  case blocked
  case completed(CompanionResult)
}

public func enableDefaultLMStudioModels(
  client: any CompanionControlling,
  confirm: @MainActor (LMStudioSetupReview) async -> Bool = { _ in false }
) async throws -> LMStudioSetupOutcome {
  try Task.checkCancellation()
  let snapshot = try await client.status()
  guard canEnableDefaultLMStudioModels(snapshot) else { return .blocked }

  let result = try await client.run(.lmStudioDefaultPreview, confirmed: false, previewToken: nil)
  guard result.ok else { return .completed(result) }
  guard let preview = result.lmStudioDefaultPreview else { return .blocked }
  let review = LMStudioSetupReview(
    title: "Enable LM Studio models?",
    text: "Confirm that Codex is fully closed and the LM Studio models you want to use are loaded. Setup sends live certification prompts to those models. Existing bridge settings, user settings, and historical chats remain in place. An existing external provider configuration cannot be overwritten. Reopen Codex after setup finishes.",
    button: "Enable LM Studio"
  )
  guard await confirm(review) else { return .cancelled }

  try Task.checkCancellation()
  let current = try await client.status()
  guard canEnableDefaultLMStudioModels(current) else { return .blocked }
  return .completed(try await client.run(.lmStudioDefaultApply, confirmed: true,
    previewToken: preview.previewToken))
}

private func canEnableDefaultLMStudioModels(_ snapshot: CompanionSnapshot) -> Bool {
  !snapshot.usesBundledBackend && snapshot.supportsNativeOnlyLMStudioSetup &&
    snapshot.providerConfiguration?.status == .nativeOnly &&
    snapshot.actions.contains(.lmStudioDefaultPreview) && snapshot.actions.contains(.lmStudioDefaultApply)
}
