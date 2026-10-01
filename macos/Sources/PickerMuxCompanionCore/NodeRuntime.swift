import Darwin
import Foundation

struct NodeFileMetadata {
  let mode: mode_t
  let owner: uid_t
  let group: gid_t
  let linkCount: nlink_t

  init(mode: mode_t, owner: uid_t, group: gid_t = 0, linkCount: nlink_t = 1) {
    self.mode = mode
    self.owner = owner
    self.group = group
    self.linkCount = linkCount
  }
}

private func nodeFileMetadata(at path: String) -> NodeFileMetadata? {
  var information = stat()
  guard lstat(path, &information) == 0 else { return nil }
  return NodeFileMetadata(mode: information.st_mode, owner: information.st_uid, group: information.st_gid, linkCount: information.st_nlink)
}

public struct NodeValidator {
  private static let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
  private static let trustedRoots = ["/opt/homebrew", "/usr/local", "/usr/bin"]
  private static let adminWritableDirectories = ["/opt/homebrew/bin", "/opt/homebrew/Cellar", "/usr/local/bin", "/usr/local/Cellar"]
  private let candidates: [String]
  private let roots: [String]
  private let currentUser: uid_t
  private let adminGroup: gid_t?
  private let metadata: (String) -> NodeFileMetadata?
  private let resolve: (String) -> String

  public init() {
    self.init(candidates: Self.candidates, roots: Self.trustedRoots, currentUser: getuid(), adminGroup: getgrnam("admin")?.pointee.gr_gid, metadata: nodeFileMetadata, resolve: { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path })
  }

  // Test-only dependency injection avoids relying on a real Homebrew install,
  // system ownership changes or execution of a fixture pretending to be Node.
  init(candidates: [String], roots: [String] = NodeValidator.trustedRoots, currentUser: uid_t, adminGroup: gid_t?, metadata: @escaping (String) -> NodeFileMetadata?, resolve: @escaping (String) -> String) {
    self.candidates = candidates
    self.roots = roots
    self.currentUser = currentUser
    self.adminGroup = adminGroup
    self.metadata = metadata
    self.resolve = resolve
  }

  public func validatedNode() throws -> URL {
    var rejectedPresentRuntime = false
    for candidate in candidates {
      guard candidate.hasPrefix("/"), let original = metadata(candidate) else { continue }
      rejectedPresentRuntime = true
      let originalType = original.mode & mode_t(S_IFMT)
      guard originalType == mode_t(S_IFREG) || originalType == mode_t(S_IFLNK),
            trustedOwner(original), original.linkCount == 1
      else { continue }
      let resolved = resolve(candidate)
      guard resolved.hasPrefix("/"), roots.contains(where: { resolved.hasPrefix($0 + "/") }),
            let information = metadata(resolved), information.mode & mode_t(S_IFMT) == mode_t(S_IFREG),
            trustedOwner(information), information.linkCount == 1,
            information.mode & 0o7022 == 0, information.mode & 0o111 != 0,
            trustedParents(of: candidate), trustedParents(of: resolved)
      else { continue }
      return URL(fileURLWithPath: resolved)
    }
    throw rejectedPresentRuntime ? CompanionFailure.unsafeNode : CompanionFailure.missingNode
  }

  private func trustedOwner(_ information: NodeFileMetadata) -> Bool {
    information.owner == 0 || information.owner == currentUser
  }

  private func trustedParents(of file: String) -> Bool {
    var directory = (file as NSString).deletingLastPathComponent
    while true {
      guard let information = metadata(directory), information.mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
            trustedOwner(information), information.mode & 0o7002 == 0
      else { return false }
      if information.mode & 0o020 != 0 {
        // Homebrew's bin aliases and Cellar directory are commonly 0775: admin
        // members already share their installation authority. This exception
        // is exact; version/bin children and other writable trees fail closed.
        guard Self.adminWritableDirectories.contains(directory), information.mode & 0o7777 == 0o775,
              let adminGroup, information.group == adminGroup
        else { return false }
      }
      if directory == "/" { return true }
      let parent = (directory as NSString).deletingLastPathComponent
      guard parent.hasPrefix("/"), parent != directory else { return false }
      directory = parent
    }
  }
}
