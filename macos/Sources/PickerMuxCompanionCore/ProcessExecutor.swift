import Darwin
import Foundation

public struct ProcessOutput {
  public let stdout: Data
  public let exitCode: Int32
}

public protocol CompanionExecuting {
  func run(executable: URL, arguments: [String], input: Data?, environment: [String: String], timeout: TimeInterval) async throws -> ProcessOutput
}

public struct ProcessExecutor: CompanionExecuting {
  public init() {}

  public func run(executable: URL, arguments: [String], input: Data?, environment: [String: String], timeout: TimeInterval) async throws -> ProcessOutput {
    guard executable.path.hasPrefix("/"), (input?.count ?? 0) <= 4096, timeout > 0, timeout <= 3600
    else { throw CompanionFailure.incompatibleProtocol }
    return try await withCheckedThrowingContinuation { continuation in
      let session = ProcessSession(continuation: continuation, limit: 262144)
      session.start(executable: executable, arguments: arguments, input: input, environment: environment, timeout: timeout)
    }
  }
}

private final class ProcessSession: @unchecked Sendable {
  let process = Process()
  let output = Pipe()
  let errors = Pipe()
  let inputPipe = Pipe()
  let lock = NSLock()
  let limit: Int
  var stdout = Data()
  var totalBytes = 0
  var streamEnds = 0
  var exitCode: Int32?
  var failure: CompanionFailure?
  var continuation: CheckedContinuation<ProcessOutput, Error>?
  var readers = [DispatchSourceRead]()
  var timeoutWork: DispatchWorkItem?
  var killWork: DispatchWorkItem?

  init(continuation: CheckedContinuation<ProcessOutput, Error>, limit: Int) {
    self.continuation = continuation
    self.limit = limit
  }

  func start(executable: URL, arguments: [String], input: Data?, environment: [String: String], timeout: TimeInterval) {
    process.executableURL = executable
    process.arguments = arguments
    process.environment = environment
    process.currentDirectoryURL = FileManager.default.temporaryDirectory
    process.standardOutput = output
    process.standardError = errors
    process.standardInput = inputPipe
    process.terminationHandler = { [self] child in
      lock.lock()
      exitCode = child.terminationStatus
      killWork?.cancel()
      killWork = nil
      lock.unlock()
      child.terminationHandler = nil
      finishIfReady()
    }
    // Nonblocking independent readers can be cancelled even if a detached
    // descendant retains an inherited pipe after the CLI itself has exited.
    // A timeout must bound both process execution and output draining.
    for (pipe, isOutput) in [(output, true), (errors, false)] {
      let handle = pipe.fileHandleForReading
      let descriptor = handle.fileDescriptor
      _ = fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK)
      let reader = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: DispatchQueue.global(qos: .utility))
      reader.setEventHandler { [self, weak reader] in
        var bytes = [UInt8](repeating: 0, count: 8192)
        while true {
          let count = Darwin.read(descriptor, &bytes, bytes.count)
          if count == -1 && errno == EINTR { continue }
          if count == -1 && (errno == EAGAIN || errno == EWOULDBLOCK) { return }
          if count <= 0 { reader?.cancel(); return }
          lock.lock()
          totalBytes += count
          let overflow = totalBytes > limit
          if !overflow && isOutput { stdout.append(contentsOf: bytes.prefix(count)) }
          lock.unlock()
          if overflow { stop(with: .outputLimit); return }
        }
      }
      reader.setCancelHandler { [self] in
        try? handle.close()
        lock.lock()
        streamEnds += 1
        lock.unlock()
        finishIfReady()
      }
      readers.append(reader)
      reader.resume()
    }
    do {
      try process.run()
      // The request is capped below pipe capacity and cannot block behind a
      // large request body. No shell, user profile, or terminal is involved.
      if let input { try inputPipe.fileHandleForWriting.write(contentsOf: input) }
      try inputPipe.fileHandleForWriting.close()
      let work = DispatchWorkItem { [self] in stop(with: .timeout) }
      lock.lock()
      let alreadyFinished = continuation == nil
      if !alreadyFinished { timeoutWork = work }
      lock.unlock()
      if alreadyFinished { work.cancel() }
      else { DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: work) }
    } catch {
      lock.lock()
      failure = .processFailed
      exitCode = -1
      lock.unlock()
      try? inputPipe.fileHandleForWriting.close()
      try? output.fileHandleForWriting.close()
      try? errors.fileHandleForWriting.close()
      cancelReaders()
      finishIfReady()
    }
  }

  func stop(with reason: CompanionFailure) {
    lock.lock()
    guard continuation != nil, failure == nil else { lock.unlock(); return }
    failure = reason
    lock.unlock()
    cancelReaders()
    if process.isRunning {
      process.terminate()
      // This signal is limited to the child created by this session. Codex and
      // the independent recovery helper are never killed by the companion.
      let work = DispatchWorkItem { [self] in
        if process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
        lock.lock()
        killWork = nil
        lock.unlock()
      }
      lock.lock()
      killWork = work
      lock.unlock()
      DispatchQueue.global().asyncAfter(deadline: .now() + 2, execute: work)
    }
  }

  func cancelReaders() {
    lock.lock()
    let pending = readers
    lock.unlock()
    for reader in pending { reader.cancel() }
  }

  func finishIfReady() {
    lock.lock()
    guard let callback = continuation, streamEnds == 2, exitCode != nil || failure != nil else { lock.unlock(); return }
    continuation = nil
    timeoutWork?.cancel()
    timeoutWork = nil
    if exitCode != nil { killWork?.cancel(); killWork = nil }
    readers.removeAll()
    let capturedExitCode = exitCode ?? -1
    let capturedFailure = failure
    let capturedOutput = stdout
    lock.unlock()
    if capturedFailure == nil { process.terminationHandler = nil }
    if let capturedFailure { callback.resume(throwing: capturedFailure) }
    else { callback.resume(returning: ProcessOutput(stdout: capturedOutput, exitCode: capturedExitCode)) }
  }
}

public struct PickerMuxClient {
  public let executor: any CompanionExecuting
  public let home: URL
  private let launcherResolver: () throws -> URL
  private let backendResolver: () throws -> BackendInvocation
  private let nodeResolver: () throws -> URL

  public init(home: URL = FileManager.default.homeDirectoryForCurrentUser, executor: any CompanionExecuting = ProcessExecutor(), launcherResolver: (() throws -> URL)? = nil, backendResolver: (() throws -> BackendInvocation)? = nil, nodeResolver: (() throws -> URL)? = nil) {
    self.home = home
    self.executor = executor
    self.launcherResolver = launcherResolver ?? { try LauncherValidator(home: home).validatedEntryPoint() }
    let resolveNode = nodeResolver ?? { try NodeValidator().validatedNode() }
    self.nodeResolver = resolveNode
    self.backendResolver = backendResolver ?? {
      BackendInvocation(executable: try resolveNode(), leadingArguments: [try BundledBackendValidator().validatedEntryPoint().path])
    }
  }

  public func status() async throws -> CompanionSnapshot {
    try await resolvedStatus().snapshot
  }

  public func checkUpdatesFromBundledBackend() async throws -> CompanionResult {
    let runtime = try await validatedRuntime()
    let selected = try await resolvedBundledStatus(runtime: runtime)
    return try await run(.updateCheck, confirmed: false, previewToken: nil, selected: selected)
  }

  public func bundledSetupClient(appVersion: String) -> BundledSetupClient {
    BundledSetupClient(client: self, appVersion: appVersion)
  }

  public func run(_ action: CompanionAction, confirmed: Bool = false, previewToken: String? = nil) async throws -> CompanionResult {
    // Probe schema compatibility before a mutation. Never retry an action via a
    // different backend after a malformed response that may have changed state.
    let selected = try await resolvedStatus()
    return try await run(action, confirmed: confirmed, previewToken: previewToken, selected: selected)
  }

  private func run(_ action: CompanionAction, confirmed: Bool, previewToken: String?,
                   selected: (snapshot: CompanionSnapshot, invocation: BackendInvocation, bundled: Bool, runtime: URL)) async throws -> CompanionResult {
    guard selected.snapshot.actions.contains(action),
          !selected.bundled || [.configurationPreview, .configurationApply, .updateCheck, .diagnose].contains(action)
    else { throw CompanionFailure.incompatibleProtocol }
    if [.uninstallPreview, .uninstall].contains(action) {
      guard !selected.bundled, selected.snapshot.supportsNativeUninstall else { throw CompanionFailure.incompatibleProtocol }
    }
    let input = try actionRequest(action, confirmed: confirmed, previewToken: previewToken)
    let result = try await execute(selected.invocation, arguments: ["companion", "run"], input: input, timeout: action.timeout, runtime: selected.runtime)
    let envelope = try CompanionResult.decode(result.stdout)
    guard result.exitCode == 0 || !envelope.ok else { throw CompanionFailure.processFailed }
    if envelope.ok && action == .uninstallPreview && envelope.uninstallPreview == nil { throw CompanionFailure.incompatibleProtocol }
    if envelope.ok && action == .uninstall && envelope.uninstallCompletion == nil { throw CompanionFailure.incompatibleProtocol }
    if envelope.ok && action == .updateCheck && envelope.update == nil { throw CompanionFailure.incompatibleProtocol }
    return envelope
  }

  private func validatedRuntime() async throws -> URL {
    let runtime = try nodeResolver()
    let nodeInvocation = BackendInvocation(executable: runtime, leadingArguments: [])
    let version = try await execute(nodeInvocation, arguments: ["--version"], timeout: 10, runtime: runtime)
    guard version.exitCode == 0, let text = String(data: version.stdout, encoding: .utf8),
          text.trimmingCharacters(in: .whitespacesAndNewlines).range(of: "^v[0-9]+\\.[0-9]+\\.[0-9]+$", options: .regularExpression) != nil
    else { throw CompanionFailure.missingNode }
    let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).dropFirst().split(separator: ".").compactMap { Int($0) }
    guard parts.count == 3, parts[0] > 22 || (parts[0] == 22 && parts[1] >= 15) else { throw CompanionFailure.missingNode }
    return runtime
  }

  private func resolvedStatus() async throws -> (snapshot: CompanionSnapshot, invocation: BackendInvocation, bundled: Bool, runtime: URL) {
    let runtime = try await validatedRuntime()
    do {
      let invocation = BackendInvocation(executable: runtime, leadingArguments: [try launcherResolver().path])
      let result = try await execute(invocation, arguments: ["companion", "status"], timeout: 45, runtime: runtime)
      guard result.exitCode == 0 else { throw CompanionFailure.processFailed }
      return (try CompanionSnapshot.decode(result.stdout), invocation, false, runtime)
    } catch {
      return try await resolvedBundledStatus(runtime: runtime)
    }
  }

  private func resolvedBundledStatus(runtime: URL) async throws -> (snapshot: CompanionSnapshot, invocation: BackendInvocation, bundled: Bool, runtime: URL) {
    let invocation = try backendResolver()
    guard invocation.executable == runtime else { throw CompanionFailure.unsafeLauncher }
    let result = try await execute(invocation, arguments: ["companion", "status"], timeout: 45, runtime: runtime)
    guard result.exitCode == 0 else { throw CompanionFailure.processFailed }
    return (try CompanionSnapshot.decode(result.stdout).allowingOnly([.configurationPreview, .configurationApply, .updateCheck, .diagnose], bundledBackend: true), invocation, true, runtime)
  }

  fileprivate func bundledUpgradeStatus(appVersion: String) async throws -> (snapshot: CompanionSnapshot, invocation: BackendInvocation, bundled: Bool, runtime: URL) {
    // A newer app is setup authority only after both installed and pinned
    // sources have been verified afresh. Ordinary service/removal control stays
    // on the receipt-active installed source regardless of the app version.
    let installed = try await resolvedStatus()
    guard companionBackendUpgradeAvailable(appVersion: appVersion, snapshot: installed.snapshot) else {
      throw CompanionFailure.incompatibleProtocol
    }
    let bundled = try await resolvedBundledStatus(runtime: installed.runtime)
    guard bundled.snapshot.version == appVersion,
          compareCompanionVersions(bundled.snapshot.version, installed.snapshot.version) == 1 else {
      throw CompanionFailure.incompatibleProtocol
    }
    return (bundled.snapshot.allowingOnly([.configurationPreview, .configurationApply], bundledBackend: true),
      bundled.invocation, true, bundled.runtime)
  }

  fileprivate func runBundledUpgrade(_ action: CompanionAction, appVersion: String, confirmed: Bool, previewToken: String?) async throws -> CompanionResult {
    guard [.configurationPreview, .configurationApply].contains(action) else { throw CompanionFailure.incompatibleProtocol }
    let selected = try await bundledUpgradeStatus(appVersion: appVersion)
    return try await run(action, confirmed: confirmed, previewToken: previewToken, selected: selected)
  }

  private func execute(_ invocation: BackendInvocation, arguments: [String], input: Data? = nil, timeout: TimeInterval, runtime: URL) async throws -> ProcessOutput {
    var environment = companionEnvironment(home: home)
    // Lifecycle child commands use the verified runtime directory and system
    // binaries without consulting an inherited PATH or a login shell.
    environment["PATH"] = runtime.deletingLastPathComponent().path + ":/usr/bin:/bin:/usr/sbin:/sbin"
    return try await executor.run(executable: invocation.executable, arguments: invocation.leadingArguments + arguments,
                                  input: input, environment: environment, timeout: timeout)
  }
}

public struct BundledSetupClient: CompanionControlling {
  private let client: PickerMuxClient
  private let appVersion: String

  fileprivate init(client: PickerMuxClient, appVersion: String) {
    self.client = client
    self.appVersion = appVersion
  }

  public func status() async throws -> CompanionSnapshot {
    try await client.bundledUpgradeStatus(appVersion: appVersion).snapshot
  }

  public func run(_ action: CompanionAction, confirmed: Bool, previewToken: String?) async throws -> CompanionResult {
    try await client.runBundledUpgrade(action, appVersion: appVersion, confirmed: confirmed, previewToken: previewToken)
  }
}
