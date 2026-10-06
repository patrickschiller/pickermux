import CryptoKit
import Darwin
import Foundation

public struct LauncherValidator {
  public let home: URL

  public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
    self.home = home.standardizedFileURL
  }

  public func validatedLauncher() throws -> URL {
    try validatedInstallation().launcher
  }

  public func validatedEntryPoint() throws -> URL {
    try validatedInstallation().entryPoint
  }

  private func validatedInstallation() throws -> (launcher: URL, entryPoint: URL) {
    let launcher = home.appendingPathComponent(".local/bin/pickermux")
    let distribution = home.appendingPathComponent("Library/Application Support/PickerMux")
    do {
      try ownedDirectories([home, home.appendingPathComponent(".local"), home.appendingPathComponent(".local/bin"),
                            home.appendingPathComponent("Library"), home.appendingPathComponent("Library/Application Support"), distribution])
      let receiptData = try privateFile(distribution.appendingPathComponent("install-receipt.json"), limit: 262144)
      guard let receipt = try JSONSerialization.jsonObject(with: receiptData) as? [String: Any],
            receipt["schemaVersion"] as? Int == 1, receipt["product"] as? String == "pickermux",
            receipt["owner"] as? String == "pickermux-cli-installer",
            let version = receipt["activeVersion"] as? String, isVersion(version),
            receipt["activeTarget"] as? String == "versions/\(version)",
            receipt["launcherPath"] as? String == launcher.path,
            let expectedHash = receipt["launcherSha256"] as? String, isDigest(expectedHash),
            let versions = receipt["versions"] as? [[String: Any]], !versions.isEmpty, versions.count <= 1024
      else { throw CompanionFailure.unsafeLauncher }
      var seen = Set<String>()
      var activeDigest: String?
      for entry in versions {
        guard let entryVersion = entry["version"] as? String, isVersion(entryVersion),
              entry["path"] as? String == "versions/\(entryVersion)",
              let digest = entry["sha256"] as? String, isDigest(digest), seen.insert(entryVersion).inserted
        else { throw CompanionFailure.unsafeLauncher }
        if entryVersion == version { activeDigest = digest }
      }
      guard seen.contains(version) else { throw CompanionFailure.unsafeLauncher }
      let current = distribution.appendingPathComponent("current")
      var pointerInfo = stat()
      guard lstat(current.path, &pointerInfo) == 0,
            pointerInfo.st_mode & S_IFMT == S_IFLNK, pointerInfo.st_uid == getuid(),
            try FileManager.default.destinationOfSymbolicLink(atPath: current.path) == "versions/\(version)"
      else { throw CompanionFailure.unsafeLauncher }
      let versionDirectory = distribution.appendingPathComponent("versions/\(version)")
      try ownedDirectories([distribution.appendingPathComponent("versions"), versionDirectory, versionDirectory.appendingPathComponent("bin")])
      guard try distributionDigest(versionDirectory) == activeDigest else { throw CompanionFailure.unsafeLauncher }
      let launcherData = try privateFile(launcher, limit: 16384, executable: true)
      guard SHA256.hash(data: launcherData).map({ String(format: "%02x", $0) }).joined() == expectedHash,
            launcherData == Data(canonicalLauncher(distribution: distribution).utf8)
      else { throw CompanionFailure.unsafeLauncher }
      // Both executable content and the complete receipt-active distribution
      // are checked before process creation. The CLI remains authoritative for
      // locks, concurrent edits, configuration ownership and lifecycle changes.
      return (launcher, versionDirectory.appendingPathComponent("bin/pickermux.mjs"))
    } catch let error as CompanionFailure {
      throw error
    } catch {
      throw CompanionFailure.unsafeLauncher
    }
  }

  private func canonicalLauncher(distribution: URL) -> String {
    let current = distribution.appendingPathComponent("current")
    let config = quote(home.appendingPathComponent(".codex/model-bridge/service-config.json").path)
    let entry = quote(current.appendingPathComponent("bin/pickermux.mjs").path)
    let defaults = quote(current.appendingPathComponent("lmstudio-picker.config.json").path)
    return "#!/bin/sh\nset -eu\nif [ -f \(config) ] && [ ! -L \(config) ]; then\n  PICKERMUX_CONFIG_PATH=\(config) exec node \(entry) \"$@\"\nfi\nPICKERMUX_CONFIG_PATH=\(defaults) exec node \(entry) \"$@\"\n"
  }

  private func quote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
  }

  private func distributionDigest(_ root: URL) throws -> String {
    let required = Set(["LICENSE", "bin", "lmstudio-picker.config.json", "package.json", "src"])
    let allowed = required.union(["release-manifest.json", "runtime"])
    let mlxRuntimeFiles = Set(["kolibri.py", "manage.py", "model_store.py", "server.py"])
    let names = Set(try FileManager.default.contentsOfDirectory(atPath: root.path))
    guard required.isSubset(of: names), names.isSubset(of: allowed) else { throw CompanionFailure.unsafeLauncher }
    var files = [(String, Data)]()
    var total = 0
    for name in names {
      let target = root.appendingPathComponent(name)
      if name == "bin" || name == "src" {
        try ownedDirectories([target])
        var directoryInfo = stat()
        guard lstat(target.path, &directoryInfo) == 0, directoryInfo.st_mode & 0o077 == 0
        else { throw CompanionFailure.unsafeLauncher }
        let members = try FileManager.default.contentsOfDirectory(atPath: target.path)
        guard !members.isEmpty, members.count <= 512 else { throw CompanionFailure.unsafeLauncher }
        for member in members {
          let relative = "\(name)/\(member)"
          guard relative.range(of: "^src/[a-z0-9-]+\\.mjs$|^bin/(pickermux|lmstudio-picker)\\.mjs$", options: .regularExpression) != nil
          else { throw CompanionFailure.unsafeLauncher }
          files.append((relative, try privateFile(target.appendingPathComponent(member), limit: 4 * 1024 * 1024)))
        }
      } else if name == "runtime" {
        let mlx = target.appendingPathComponent("mlx")
        try ownedDirectories([target, mlx])
        for directory in [target, mlx] {
          var directoryInfo = stat()
          guard lstat(directory.path, &directoryInfo) == 0, directoryInfo.st_mode & 0o077 == 0
          else { throw CompanionFailure.unsafeLauncher }
        }
        let runtimeNames = Set(try FileManager.default.contentsOfDirectory(atPath: target.path))
        let mlxNames = Set(try FileManager.default.contentsOfDirectory(atPath: mlx.path))
        guard runtimeNames == ["mlx"], mlxNames == mlxRuntimeFiles
        else { throw CompanionFailure.unsafeLauncher }
        for member in mlxNames {
          let relative = "runtime/mlx/\(member)"
          files.append((relative, try privateFile(mlx.appendingPathComponent(member), limit: 4 * 1024 * 1024)))
        }
      } else {
        files.append((name, try privateFile(target, limit: 4 * 1024 * 1024)))
      }
    }
    var hash = SHA256()
    // Distribution file names are restricted to the ASCII release grammar.
    // Case-folded lexical ordering matches Node's localeCompare for that set;
    // LICENSE is the only uppercase path in the supported distribution.
    for (relative, contents) in files.sorted(by: { $0.0.lowercased() < $1.0.lowercased() }) {
      total += contents.count
      guard total <= 32 * 1024 * 1024 else { throw CompanionFailure.unsafeLauncher }
      hash.update(data: Data("\(relative.utf8.count):".utf8))
      hash.update(data: Data(relative.utf8))
      hash.update(data: Data("\(contents.count):".utf8))
      hash.update(data: contents)
    }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
  }

  private func ownedDirectories(_ urls: [URL]) throws {
    for url in urls {
      var info = stat()
      guard lstat(url.path, &info) == 0 else {
        if errno == ENOENT { throw CompanionFailure.missingLauncher }
        throw CompanionFailure.unsafeLauncher
      }
      guard info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o022 == 0
      else { throw CompanionFailure.unsafeLauncher }
    }
  }

  private func privateFile(_ url: URL, limit: Int, executable: Bool = false) throws -> Data {
    let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else {
      if errno == ENOENT { throw CompanionFailure.missingLauncher }
      throw CompanionFailure.unsafeLauncher
    }
    defer { close(descriptor) }
    var before = stat()
    guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG,
          before.st_uid == getuid(), before.st_nlink == 1, before.st_mode & 0o077 == 0,
          before.st_size >= 0, before.st_size <= limit, !executable || before.st_mode & S_IXUSR != 0
    else { throw CompanionFailure.unsafeLauncher }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
      let count = Darwin.read(descriptor, &buffer, buffer.count)
      if count == -1 && errno == EINTR { continue }
      guard count >= 0 else { throw CompanionFailure.unsafeLauncher }
      if count == 0 { break }
      guard data.count + count <= limit else { throw CompanionFailure.unsafeLauncher }
      data.append(contentsOf: buffer.prefix(count))
    }
    var after = stat()
    guard fstat(descriptor, &after) == 0, before.st_ino == after.st_ino,
          before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
          before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
          before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
          before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec
    else { throw CompanionFailure.unsafeLauncher }
    return data
  }
}

private func isDigest(_ value: String) -> Bool {
  value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
}

public func companionEnvironment(home: URL, temporaryDirectory: URL = FileManager.default.temporaryDirectory) -> [String: String] {
  // Provider secrets and Codex environment overrides never enter the GUI child.
  ["HOME": home.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
   "TMPDIR": temporaryDirectory.path, "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8"]
}
