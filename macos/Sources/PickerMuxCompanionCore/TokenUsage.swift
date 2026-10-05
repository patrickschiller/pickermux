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
  public var displayTotals: TokenUsageCounts? { requests == 0 || requests > unavailableRequests ? totals : nil }

  public var missingUsageMessage: String? {
    guard unavailableRequests > 0 else { return nil }
    if unavailableRequests == requests {
      return "No verified usage counts are available for these requests."
    }
    return "Totals include reported usage only; \(unavailableRequests) of \(requests) requests have no usage counts."
  }

  private enum CodingKeys: String, CodingKey { case providerId, requests, unavailableRequests, last, totals }

  public init(from decoder: Decoder) throws {
    try self.init(from: decoder, schemaVersion: 1)
  }

  fileprivate init(from decoder: Decoder, schemaVersion: Int) throws {
    try requireTokenUsageKeys(decoder, ["providerId", "requests", "unavailableRequests", "last", "totals"])
    let container = try decoder.container(keyedBy: CodingKeys.self)
    providerId = try container.decode(String.self, forKey: .providerId)
    requests = try container.decode(Int.self, forKey: .requests)
    unavailableRequests = try container.decode(Int.self, forKey: .unavailableRequests)
    last = try container.decode(TokenUsageLastRequest.self, forKey: .last)
    totals = try container.decodeIfPresent(TokenUsageCounts.self, forKey: .totals)
    guard providerId.utf8.count <= 127,
          providerId.range(of: "^[a-z0-9](?:[a-z0-9_-]{0,125}[a-z0-9])?\\z", options: .regularExpression) != nil,
          isTokenUsageCount(requests), requests >= (schemaVersion == 1 ? 1 : 0),
          isTokenUsageCount(unavailableRequests), unavailableRequests <= requests,
          totals != nil || requests - unavailableRequests >= 2,
          (schemaVersion == 2 && requests == 0) || (last.status == .available ? requests > unavailableRequests : unavailableRequests >= 1)
    else { throw CompanionFailure.incompatibleProtocol }
    if let totals {
      if schemaVersion == 1 || requests > 0, let latest = last.counts {
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
  public let resetAt: String?
  public var isPersistent: Bool { schemaVersion == 2 }
  public var resetDate: Date? { resetAt.flatMap(canonicalTokenUsageDate) }

  private enum CodingKeys: String, CodingKey { case schemaVersion, status, providers, resetAt }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
    guard [1, 2].contains(schemaVersion) else { throw CompanionFailure.incompatibleProtocol }
    try requireTokenUsageKeys(decoder, schemaVersion == 1 ? ["schemaVersion", "status", "providers"] :
      ["schemaVersion", "status", "providers", "resetAt"])
    status = try container.decode(TokenUsageAvailability.self, forKey: .status)
    resetAt = schemaVersion == 2 ? try container.decodeIfPresent(String.self, forKey: .resetAt) : nil
    if let resetAt, canonicalTokenUsageDate(resetAt) == nil { throw CompanionFailure.incompatibleProtocol }
    var elements = try container.nestedUnkeyedContainer(forKey: .providers)
    var decodedProviders: [ProviderTokenUsage] = []
    while !elements.isAtEnd {
      guard decodedProviders.count < 128 else { throw CompanionFailure.incompatibleProtocol }
      decodedProviders.append(try ProviderTokenUsage(from: elements.superDecoder(), schemaVersion: schemaVersion))
    }
    providers = decodedProviders
    guard providers.count <= 128,
          Set(providers.map(\.providerId)).count == providers.count,
          status == .available || providers.isEmpty
    else { throw CompanionFailure.incompatibleProtocol }
  }
}

public struct ProviderTokenPerformance: Decodable, Equatable, Identifiable {
  public let providerId: String
  public let status: TokenUsageAvailability
  public let counts: TokenUsageCounts?
  public let generationDurationMs: Int?
  public var id: String { providerId }

  private enum CodingKeys: String, CodingKey {
    case providerId, status, inputTokens, outputTokens, totalTokens, generationDurationMs
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    providerId = try container.decode(String.self, forKey: .providerId)
    status = try container.decode(TokenUsageAvailability.self, forKey: .status)
    guard providerId.utf8.count <= 127,
          providerId.range(of: "^[a-z0-9](?:[a-z0-9_-]{0,125}[a-z0-9])?\\z", options: .regularExpression) != nil
    else { throw CompanionFailure.incompatibleProtocol }
    if status == .available {
      try requireTokenUsageKeys(decoder, ["providerId", "status", "inputTokens", "outputTokens", "totalTokens", "generationDurationMs"])
      let input = try container.decode(Int.self, forKey: .inputTokens)
      let output = try container.decode(Int.self, forKey: .outputTokens)
      let total = try container.decode(Int.self, forKey: .totalTokens)
      let duration = try container.decode(Int.self, forKey: .generationDurationMs)
      guard [input, output, total].allSatisfy(isTokenUsageCount), total == input + output,
            duration > 0, duration <= 3_600_000
      else { throw CompanionFailure.incompatibleProtocol }
      counts = TokenUsageCounts(inputTokens: input, outputTokens: output, totalTokens: total)
      generationDurationMs = duration
    } else {
      try requireTokenUsageKeys(decoder, ["providerId", "status"])
      counts = nil
      generationDurationMs = nil
    }
  }
}

public struct TokenPerformanceSnapshot: Decodable, Equatable {
  public let schemaVersion: Int
  public let status: TokenUsageAvailability
  public let providers: [ProviderTokenPerformance]

  private enum CodingKeys: String, CodingKey { case schemaVersion, status, providers }

  public init(from decoder: Decoder) throws {
    try requireTokenUsageKeys(decoder, ["schemaVersion", "status", "providers"])
    let container = try decoder.container(keyedBy: CodingKeys.self)
    schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
    status = try container.decode(TokenUsageAvailability.self, forKey: .status)
    var elements = try container.nestedUnkeyedContainer(forKey: .providers)
    var decodedProviders: [ProviderTokenPerformance] = []
    while !elements.isAtEnd {
      guard decodedProviders.count < 128 else { throw CompanionFailure.incompatibleProtocol }
      decodedProviders.append(try elements.decode(ProviderTokenPerformance.self))
    }
    providers = decodedProviders
    guard schemaVersion == 1, Set(providers.map(\.providerId)).count == providers.count,
          status == .available || providers.isEmpty
    else { throw CompanionFailure.incompatibleProtocol }
  }

  // Durable counts may predate this process or become unavailable after a
  // failed write. Never attach a volatile rate to a different latest count.
  public func outputTokensPerSecond(for provider: ProviderTokenUsage) -> Double? {
    guard status == .available, let latest = provider.last.counts,
          let measurement = providers.first(where: { $0.providerId == provider.providerId }),
          measurement.status == .available, measurement.counts == latest,
          let duration = measurement.generationDurationMs
    else { return nil }
    return Double(latest.outputTokens) * 1000 / Double(duration)
  }
}

func canonicalTokenUsageDate(_ value: String) -> Date? {
  guard value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", options: .regularExpression) != nil
  else { return nil }
  let formatter = DateFormatter()
  formatter.locale = Locale(identifier: "en_US_POSIX")
  formatter.calendar = Calendar(identifier: .gregorian)
  formatter.timeZone = TimeZone(secondsFromGMT: 0)
  formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
  formatter.isLenient = false
  guard let date = formatter.date(from: value), formatter.string(from: date) == value else { return nil }
  return date
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
