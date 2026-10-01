import CryptoKit
import Darwin
import Foundation
#if SWIFT_PACKAGE
public let bundledBackendManifestHash: String? = nil
#endif

public struct BackendInvocation {
  public let executable: URL
  public let leadingArguments: [String]
}

public struct BundledBackendValidator {
  public let directory: URL?
  public let expectedManifestHash: String?

  public init(directory: URL? = Bundle.main.resourceURL?.appendingPathComponent("Backend"), expectedManifestHash: String? = bundledBackendManifestHash) {
    self.directory = directory
    self.expectedManifestHash = expectedManifestHash
  }

  public func validatedEntryPoint() throws -> URL {
    guard let originalDirectory = directory, let expectedManifestHash else { throw CompanionFailure.missingLauncher }
    var rootInfo = stat()
    guard lstat(originalDirectory.path, &rootInfo) == 0, rootInfo.st_mode & S_IFMT == S_IFDIR
    else { throw CompanionFailure.unsafeLauncher }
    let directory = originalDirectory.resolvingSymlinksInPath()
    let manifestData = try bundleFile(directory.appendingPathComponent("release-manifest.json"), limit: 262144)
    guard digest(manifestData) == expectedManifestHash,
          let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
          manifest["schemaVersion"] as? Int == 1, manifest["name"] as? String == "pickermux",
          let version = manifest["version"] as? String, isVersion(version),
          let files = manifest["files"] as? [[String: Any]], !files.isEmpty, files.count <= 1024
    else { throw CompanionFailure.unsafeLauncher }
    var seen = Set<String>()
    var total = 0
    for record in files {
      guard let relative = record["path"] as? String,
            relative.range(of: "^(bin|src)/[A-Za-z0-9._/-]+$|^(package.json|lmstudio-picker.config.json|LICENSE)$", options: .regularExpression) != nil,
            !relative.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." || $0.isEmpty }),
            seen.insert(relative).inserted,
            let size = record["size"] as? Int, size >= 0, size <= 4 * 1024 * 1024,
            let expected = record["sha256"] as? String, expected.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
      else { throw CompanionFailure.unsafeLauncher }
      let url = directory.appendingPathComponent(relative)
      try realOwnedParents(of: url, stopAt: directory)
      let contents = try bundleFile(url, limit: size)
      total += contents.count
      guard contents.count == size, digest(contents) == expected, total <= 32 * 1024 * 1024
      else { throw CompanionFailure.unsafeLauncher }
    }
    guard ["bin/pickermux.mjs", "package.json", "lmstudio-picker.config.json", "LICENSE"].allSatisfy(seen.contains)
    else { throw CompanionFailure.unsafeLauncher }
    // Relative ESM imports cannot pick up an unmanifested file added later.
    var enumerationFailed = false
    guard let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil, errorHandler: { _, _ in
      enumerationFailed = true
      return false
    }) else { throw CompanionFailure.unsafeLauncher }
    while let url = enumerator.nextObject() as? URL {
      var info = stat()
      guard lstat(url.path, &info) == 0 else { throw CompanionFailure.unsafeLauncher }
      let type = info.st_mode & S_IFMT
      if type == S_IFDIR { continue }
      let path = url.resolvingSymlinksInPath().path
      guard path.hasPrefix(directory.path + "/") else { throw CompanionFailure.unsafeLauncher }
      let relative = String(path.dropFirst(directory.path.count + 1))
      guard type == S_IFREG, relative == "release-manifest.json" || seen.contains(relative)
      else { throw CompanionFailure.unsafeLauncher }
    }
    guard !enumerationFailed else { throw CompanionFailure.unsafeLauncher }
    return directory.appendingPathComponent("bin/pickermux.mjs")
  }
}

private func realOwnedParents(of file: URL, stopAt root: URL) throws {
  var directory = file.deletingLastPathComponent().standardizedFileURL
  while true {
    var info = stat()
    guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
          info.st_uid == 0 || info.st_uid == getuid(), info.st_mode & 0o022 == 0
    else { throw CompanionFailure.unsafeLauncher }
    if directory.path == root.standardizedFileURL.path { return }
    guard directory.path != "/" else { throw CompanionFailure.unsafeLauncher }
    directory.deleteLastPathComponent()
  }
}

private func bundleFile(_ url: URL, limit: Int) throws -> Data {
  let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
  guard descriptor >= 0 else { throw CompanionFailure.unsafeLauncher }
  defer { close(descriptor) }
  var before = stat()
  guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
        before.st_uid == 0 || before.st_uid == getuid(), before.st_mode & 0o022 == 0,
        before.st_nlink == 1, before.st_size >= 0, before.st_size <= limit
  else { throw CompanionFailure.unsafeLauncher }
  var data = Data()
  var bytes = [UInt8](repeating: 0, count: 8192)
  while true {
    let count = Darwin.read(descriptor, &bytes, bytes.count)
    if count == -1 && errno == EINTR { continue }
    guard count >= 0 else { throw CompanionFailure.unsafeLauncher }
    if count == 0 { break }
    guard data.count + count <= limit else { throw CompanionFailure.unsafeLauncher }
    data.append(contentsOf: bytes.prefix(count))
  }
  var after = stat()
  guard fstat(descriptor, &after) == 0, before.st_size == after.st_size,
        before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
        before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec
  else { throw CompanionFailure.unsafeLauncher }
  return data
}

private func digest(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
