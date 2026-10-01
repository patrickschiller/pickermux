import Foundation

public enum TokenUsageAvailability: String, Decodable, Equatable {
  case available, unavailable
}

public struct TokenUsageCounts: Decodable, Equatable {
  public let inputTokens: Int
  public let outputTokens: Int
  public let totalTokens: Int

  private enum CodingKeys: String, CodingKey { case inputTokens, outputTokens, totalTokens }

  public init(from decoder: Decoder) throws {
    try requireTokenUsageKeys(decoder, ["inputTokens", "outputTokens", "totalTokens"])
    let container = try decoder.container(keyedBy: CodingKeys.self)
    inputTokens = try container.decode(Int.self, forKey: .inputTokens)
    outputTokens = try container.decode(Int.self, forKey: .outputTokens)
    totalTokens = try container.decode(Int.self, forKey: .totalTokens)
    guard [inputTokens, outputTokens, totalTokens].allSatisfy(isTokenUsageCount),
          totalTokens == inputTokens + outputTokens
    else { throw CompanionFailure.incompatibleProtocol }
  }
}

public struct TokenUsageLastRequest: Decodable, Equatable {
  public let status: TokenUsageAvailability
  public let counts: TokenUsageCounts?

  private enum CodingKeys: String, CodingKey { case status }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    status = try container.decode(TokenUsageAvailability.self, forKey: .status)
    if status == .available {
      try requireTokenUsageKeys(decoder, ["status", "inputTokens", "outputTokens", "totalTokens"])
      let fields = try decoder.container(keyedBy: TokenUsageKey.self)
      let input = try fields.decode(Int.self, forKey: TokenUsageKey("inputTokens"))
      let output = try fields.decode(Int.self, forKey: TokenUsageKey("outputTokens"))
      let total = try fields.decode(Int.self, forKey: TokenUsageKey("totalTokens"))
      guard [input, output, total].allSatisfy(isTokenUsageCount), total == input + output
      else { throw CompanionFailure.incompatibleProtocol }
      counts = TokenUsageCounts(inputTokens: input, outputTokens: output, totalTokens: total)
    } else {
      try requireTokenUsageKeys(decoder, ["status"])
      counts = nil
    }
  }
}

public struct ProviderTokenUsage: Decodable, Equatable, Identifiable {
  public let providerId: String
  public let requests: Int
  public let unavailableRequests: Int
  public let last: TokenUsageLastRequest
  public let totals: TokenUsageCounts?
  public var id: String { providerId }

  // An all-unknown aggregate has no measured zero; keep it unavailable in the UI.
  public var displayTotals: TokenUsageCounts? { requests > unavailableRequests ? totals : nil }

  public var missingUsageMessage: String? {
    guard unavailableRequests > 0 else { return nil }
    if unavailableRequests == requests {
      return "No verified usage counts are available for these requests."
    }
    return "Totals include reported usage only; \(unavailableRequests) of \(requests) requests have no usage counts."
  }

  private enum CodingKeys: String, CodingKey { case providerId, requests, unavailableRequests, last, totals }

  public init(from decoder: Decoder) throws {
    try requireTokenUsageKeys(decoder, ["providerId", "requests", "unavailableRequests", "last", "totals"])
    let container = try decoder.container(keyedBy: CodingKeys.self)
    providerId = try container.decode(String.self, forKey: .providerId)
    requests = try container.decode(Int.self, forKey: .requests)
    unavailableRequests = try container.decode(Int.self, forKey: .unavailableRequests)
    last = try container.decode(TokenUsageLastRequest.self, forKey: .last)
    totals = try container.decodeIfPresent(TokenUsageCounts.self, forKey: .totals)
    guard providerId.utf8.count <= 127,
          providerId.range(of: "^[a-z0-9](?:[a-z0-9_-]{0,125}[a-z0-9])?\\z", options: .regularExpression) != nil,
          isTokenUsageCount(requests), requests >= 1, isTokenUsageCount(unavailableRequests), unavailableRequests <= requests,
          totals != nil || requests - unavailableRequests >= 2,
          last.status == .available ? requests > unavailableRequests : unavailableRequests >= 1
    else { throw CompanionFailure.incompatibleProtocol }
    if let totals {
      if let latest = last.counts {
        guard totals.inputTokens >= latest.inputTokens, totals.outputTokens >= latest.outputTokens
        else { throw CompanionFailure.incompatibleProtocol }
        if requests - unavailableRequests == 1 {
          guard totals == latest else { throw CompanionFailure.incompatibleProtocol }
        }
      }
      if requests == unavailableRequests {
        guard totals.totalTokens == 0 else { throw CompanionFailure.incompatibleProtocol }
      }
    }
  }
}

public struct TokenUsageSnapshot: Decodable, Equatable {
  public let schemaVersion: Int
  public let status: TokenUsageAvailability
  public let providers: [ProviderTokenUsage]

  private enum CodingKeys: String, CodingKey { case schemaVersion, status, providers }

  public init(from decoder: Decoder) throws {
    try requireTokenUsageKeys(decoder, ["schemaVersion", "status", "providers"])
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
    status = try container.decode(TokenUsageAvailability.self, forKey: .status)
    providers = try container.decode([ProviderTokenUsage].self, forKey: .providers)
    guard schemaVersion == 1, providers.count <= 128,
          Set(providers.map(\.providerId)).count == providers.count,
          status == .available || providers.isEmpty
    else { throw CompanionFailure.incompatibleProtocol }
  }
}

private extension TokenUsageCounts {
  init(inputTokens: Int, outputTokens: Int, totalTokens: Int) {
    self.inputTokens = inputTokens
    self.outputTokens = outputTokens
    self.totalTokens = totalTokens
  }
}

private struct TokenUsageKey: CodingKey {
  let stringValue: String
  var intValue: Int? { nil }
  init(_ value: String) { stringValue = value }
  init?(stringValue: String) { self.init(stringValue) }
  init?(intValue: Int) { return nil }
}

private func requireTokenUsageKeys(_ decoder: Decoder, _ keys: Set<String>) throws {
  let container = try decoder.container(keyedBy: TokenUsageKey.self)
  guard Set(container.allKeys.map(\.stringValue)) == keys
  else { throw CompanionFailure.incompatibleProtocol }
}

private func isTokenUsageCount(_ value: Int) -> Bool {
  value >= 0 && value <= 9_007_199_254_740_991
}
