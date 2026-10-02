import AppKit
import SwiftUI
import XCTest
import PickerMuxCompanionCore
@testable import PickerMuxCompanion

@MainActor
final class MenuViewportTests: XCTestCase {
  func testShortMenuResistsCollapsedWindowProposals() throws {
    let measurements = Measurements()
    let host = NSHostingView(rootView: ViewportProbe(measurements: measurements) {
      CompanionMenuViewport {
        ContentProbe(measurements: measurements) {
          VStack(alignment: .leading, spacing: 12) {
            Text("Use PickerMux in Codex")
            Text("Checking PickerMux…")
          }
          .padding(16)
        }
      }
    })
    assertFixedViewport(host, measurements: measurements)
    let contentSize = try XCTUnwrap(measurements.contentSize)
    XCTAssertGreaterThan(contentSize.height, 0)
    XCTAssertLessThan(contentSize.height, 600)
  }

  func testTallMenuKeepsABoundedVerticalViewport() throws {
    let measurements = Measurements()
    let host = NSHostingView(rootView: ViewportProbe(measurements: measurements) {
      CompanionMenuViewport {
        ContentProbe(measurements: measurements) {
          VStack(alignment: .leading, spacing: 12) {
            Text("Token usage")
            ForEach(0..<80) { index in
              Text("Synthetic provider \(index) · Input 120 · Output 30 · Total 150")
                .frame(height: 30)
            }
          }
          .padding(16)
        }
      }
    })
    assertFixedViewport(host, measurements: measurements)
    let contentSize = try XCTUnwrap(measurements.contentSize)
    XCTAssertGreaterThan(contentSize.height, host.frame.height)
    XCTAssertLessThanOrEqual(contentSize.width, host.frame.width)
  }

  func testPinnedFooterKeepsItsHeightWhenMenuContentScrolls() throws {
    let footerMeasurements = Measurements()
    let host = NSHostingView(rootView: CompanionMenuViewport {
      VStack {
        ForEach(0..<80) { index in Text("Synthetic row \(index)").frame(height: 30) }
      }
    } footer: {
      ContentProbe(measurements: footerMeasurements) {
        HStack { Text("Settings…"); Text("Help…"); Spacer(); Text("Quit") }
          .padding(16)
      }
    })
    host.frame = CGRect(origin: .zero, size: host.fittingSize)
    host.layoutSubtreeIfNeeded()
    XCTAssertEqual(host.fittingSize.width, 400, accuracy: 0.5)
    XCTAssertEqual(host.fittingSize.height, 600, accuracy: 0.5)
    let footer = try XCTUnwrap(footerMeasurements.contentSize)
    XCTAssertGreaterThan(footer.height, 30)
    XCTAssertLessThan(footer.height, 80)
    XCTAssertEqual(footer.width, 400, accuracy: 0.5)
  }

  func testActualTokenGridFitsLongProviderIdsAndLargestCounts() throws {
    let maximum = 9_007_199_254_740_991
    let provider: [String: Any] = [
      "providerId": String(repeating: "a", count: 127), "requests": 2, "unavailableRequests": 0,
      "last": ["status": "available", "inputTokens": maximum, "outputTokens": 0, "totalTokens": maximum],
      "totals": ["inputTokens": maximum, "outputTokens": 0, "totalTokens": maximum],
    ]
    let snapshot = try menuSnapshot(providers: [provider])
    let measurements = Measurements()
    let host = NSHostingView(rootView: CompanionMenuViewport {
      ContentProbe(measurements: measurements) { TokenUsageView(snapshot: snapshot).padding(16) }
    })
    host.frame = CGRect(origin: .zero, size: host.fittingSize)
    host.layoutSubtreeIfNeeded()
    let size = try XCTUnwrap(measurements.contentSize)
    XCTAssertLessThanOrEqual(size.width, 400)
    XCTAssertGreaterThan(size.height, 100)
    XCTAssertLessThan(size.height, 600)
  }

  func testDirectMenuUsesVerifiedHeaderAndRendersSyntheticNativePreview() throws {
    let controller = CompanionController(pollingEnabled: false)
    controller.snapshot = try menuSnapshot()
    controller.operationNoticeAction = .configurationApply
    controller.operationFailed = true
    controller.operationNotice = "Synthetic earlier setup failure."
    XCTAssertTrue(controller.lastSetupFailed)
    XCTAssertEqual(controller.integrationLabel, "Enabled in Codex")
    controller.operationNoticeAction = .diagnose
    controller.operationFailed = false
    controller.operationNotice = "Installation checks passed."
    controller.statusCheckNotice = "Status checked just now."
    let host = NSHostingView(rootView: CompanionPanel(controller: controller)
      .background(Color(nsColor: .windowBackgroundColor)).preferredColorScheme(.light))
    host.appearance = NSAppearance(named: .aqua)
    host.frame = CGRect(x: 0, y: 0, width: 400, height: 600)
    host.layoutSubtreeIfNeeded()
    XCTAssertEqual(host.fittingSize.width, 400, accuracy: 0.5)
    XCTAssertEqual(host.fittingSize.height, 600, accuracy: 0.5)
    let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: bitmap)
    let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    XCTAssertGreaterThan(png.count, 1000)
    if let path = ProcessInfo.processInfo.environment["PICKERMUX_MENU_PREVIEW_PATH"] {
      try png.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
  }

  private func menuSnapshot(providers: [[String: Any]]? = nil) throws -> CompanionSnapshot {
    let syntheticProvider: [String: Any] = [
      "providerId": "lmstudio", "requests": 8, "unavailableRequests": 0,
      "last": ["status": "available", "inputTokens": 14900, "outputTokens": 320, "totalTokens": 15220],
      "totals": ["inputTokens": 140000, "outputTokens": 3250, "totalTokens": 143250],
    ]
    return try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: [
      "schemaVersion": 1, "version": "0.21.0", "state": "ready",
      "capabilities": ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v2", "token-usage-reset-v1"],
      "desktop": ["status": "running"], "installation": ["status": "installed"],
      "managedConfig": ["status": "installed"], "service": ["status": "running"],
      "compatibility": ["status": "compatible"], "accountCache": ["status": "ready"],
      "integration": ["status": "pickermux"], "recovery": ["status": "idle"], "issues": [],
      "actions": ["refresh", "open", "diagnose", "certify", "recover", "usage-reset"],
      "tokenUsage": ["schemaVersion": 2, "status": "available", "resetAt": NSNull(), "providers": providers ?? [syntheticProvider]],
    ]))
  }

  private func assertFixedViewport<V: View>(_ host: NSHostingView<V>, measurements: Measurements,
                                             file: StaticString = #filePath, line: UInt = #line) {
    let fitting = host.fittingSize
    host.frame = CGRect(origin: .zero, size: fitting)
    host.layoutSubtreeIfNeeded()
    XCTAssertEqual(fitting.width, 400, accuracy: 0.5, file: file, line: line)
    XCTAssertEqual(fitting.height, 600, accuracy: 0.5, file: file, line: line)
    XCTAssertEqual(Set(measurements.viewportSizes.keys), Set(["minimum", "tiny", "ideal", "maximum"]), file: file, line: line)
    for (proposal, size) in measurements.viewportSizes {
      XCTAssertEqual(size.width, 400, accuracy: 0.5, "Width under \(proposal) proposal", file: file, line: line)
      XCTAssertEqual(size.height, 600, accuracy: 0.5, "Height under \(proposal) proposal", file: file, line: line)
    }
  }
}

private final class Measurements {
  var viewportSizes: [String: CGSize] = [:]
  var contentSize: CGSize?
}

private struct ViewportProbe: Layout {
  let measurements: Measurements

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    measurements.viewportSizes = [
      "minimum": subviews[0].sizeThatFits(.zero),
      "tiny": subviews[0].sizeThatFits(ProposedViewSize(width: 10, height: 10)),
      "ideal": subviews[0].sizeThatFits(.unspecified),
      "maximum": subviews[0].sizeThatFits(.infinity),
    ]
    return subviews[0].sizeThatFits(proposal)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
  }
}

private struct ContentProbe: Layout {
  let measurements: Measurements

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let size = subviews[0].sizeThatFits(proposal)
    measurements.contentSize = size
    return size
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
  }
}
