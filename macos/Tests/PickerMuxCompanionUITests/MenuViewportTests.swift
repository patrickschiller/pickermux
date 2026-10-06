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
    assertViewport(host, measurements: measurements)
    let contentSize = try XCTUnwrap(measurements.contentSize)
    XCTAssertGreaterThan(contentSize.height, 0)
    XCTAssertLessThan(contentSize.height, 600)
    XCTAssertEqual(host.fittingSize.height, contentSize.height, accuracy: 0.5)
    XCTAssertLessThan(host.fittingSize.height, 200)
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
    assertViewport(host, measurements: measurements)
    XCTAssertEqual(host.fittingSize.height, 520, accuracy: 0.5)
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
        HStack { Text("Config…"); Text("Help…"); Spacer(); Text("Quit") }
          .padding(16)
      }
    })
    settle(host)
    XCTAssertEqual(host.fittingSize.width, 320, accuracy: 0.5)
    let footer = try XCTUnwrap(footerMeasurements.contentSize)
    XCTAssertGreaterThan(footer.height, 30)
    XCTAssertLessThan(footer.height, 80)
    XCTAssertEqual(footer.width, 320, accuracy: 0.5)
    XCTAssertEqual(host.fittingSize.height, 520 + footer.height, accuracy: 0.5)
  }

  func testConfigKeepsItsOwnScrollableViewport() throws {
    let measurements = Measurements()
    let host = NSHostingView(rootView: ViewportProbe(measurements: measurements) {
      CompanionConfigViewport {
        ContentProbe(measurements: measurements) {
          VStack(alignment: .leading, spacing: 12) {
            Text("PickerMux Config")
            ForEach(0..<80) { index in
              Text("Synthetic installation detail \(index)")
                .frame(height: 30)
            }
          }
          .padding(20)
        }
      }
    })
    assertFixedViewport(host, measurements: measurements, width: 500, height: 640)
    let contentSize = try XCTUnwrap(measurements.contentSize)
    XCTAssertGreaterThan(contentSize.height, host.frame.height)
    XCTAssertLessThanOrEqual(contentSize.width, host.frame.width)
  }

  func testStackedTokenSummariesFitLongProviderIdsAndLargestCounts() throws {
    let maximum = 9_007_199_254_740_991
    let provider: [String: Any] = [
      "providerId": String(repeating: "a", count: 127), "requests": 2, "unavailableRequests": 0,
      "last": ["status": "available", "inputTokens": maximum, "outputTokens": 0, "totalTokens": maximum],
      "totals": ["inputTokens": maximum, "outputTokens": 0, "totalTokens": maximum],
    ]
    let snapshot = try menuSnapshot(providers: [provider])
    let measurements = Measurements()
    let host = NSHostingView(rootView: CompanionMenuViewport {
      ContentProbe(measurements: measurements) { TokenUsageView(snapshot: snapshot).padding(14) }
    })
    settle(host)
    let size = try XCTUnwrap(measurements.contentSize)
    XCTAssertLessThanOrEqual(size.width, 320)
    XCTAssertGreaterThan(size.height, 100)
    XCTAssertLessThan(size.height, 600)
  }

  func testOutputSpeedFitsTheExistingCompactTokenPanel() throws {
    let performance: [String: Any] = ["schemaVersion": 1, "status": "available", "providers": [[
      "providerId": "lmstudio", "status": "available", "inputTokens": 14900,
      "outputTokens": 320, "totalTokens": 15220, "generationDurationMs": 1500,
    ]]]
    let snapshot = try menuSnapshot(performance: performance)
    let measurements = Measurements()
    let host = NSHostingView(rootView: CompanionMenuViewport {
      ContentProbe(measurements: measurements) { TokenUsageView(snapshot: snapshot).padding(14) }
    })
    settle(host)
    let size = try XCTUnwrap(measurements.contentSize)
    XCTAssertLessThanOrEqual(size.width, 320)
    XCTAssertGreaterThan(size.height, 100)
    XCTAssertLessThan(size.height, 600)
    XCTAssertEqual(snapshot.tokenPerformance?.outputTokensPerSecond(for: try XCTUnwrap(snapshot.tokenUsage?.providers.first)), 320_000.0 / 1500)
    XCTAssertEqual(CompanionPresentation.outputSpeedLabel, "Output speed")
    XCTAssertFalse(CompanionPresentation.outputSpeedHelp.contains("Generation"))
  }

  func testOutputSpeedRequiresConcreteProviderRateButKeepsMeasuredZeroVisible() throws {
    func provider(_ providerId: String, input: Int, output: Int) -> [String: Any] {
      [
        "providerId": providerId, "requests": 1, "unavailableRequests": 0,
        "last": ["status": "available", "inputTokens": input, "outputTokens": output,
                 "totalTokens": input + output],
        "totals": ["inputTokens": input, "outputTokens": output, "totalTokens": input + output],
      ]
    }
    let providers = [
      provider("lmstudio", input: 120, output: 0),
      provider("kolibri", input: 200, output: 40),
    ]
    let kolibriOnly: [String: Any] = ["schemaVersion": 1, "status": "available", "providers": [[
      "providerId": "kolibri", "status": "available", "inputTokens": 200,
      "outputTokens": 40, "totalTokens": 240, "generationDurationMs": 1000,
    ]]]
    let unavailable = try menuSnapshot(providers: providers, performance: kolibriOnly)
    let lmStudio = try XCTUnwrap(CompanionPresentation.visibleTokenProviders(
      try XCTUnwrap(unavailable.tokenUsage).providers).first)
    XCTAssertNil(CompanionPresentation.outputSpeed(for: lmStudio, in: unavailable))

    let measuredZero: [String: Any] = ["schemaVersion": 1, "status": "available", "providers": [[
      "providerId": "lmstudio", "status": "available", "inputTokens": 120,
      "outputTokens": 0, "totalTokens": 120, "generationDurationMs": 1000,
    ]]]
    let zero = try menuSnapshot(providers: providers, performance: measuredZero)
    let zeroProvider = try XCTUnwrap(CompanionPresentation.visibleTokenProviders(
      try XCTUnwrap(zero.tokenUsage).providers).first)
    XCTAssertEqual(CompanionPresentation.outputSpeed(for: zeroProvider, in: zero), 0)
    XCTAssertGreaterThan(tokenUsageHeight(zero), tokenUsageHeight(unavailable) + 10)
  }

  func testKolibriUsageAndPerformanceRowsStayHiddenWhileLMStudioRemains() throws {
    func provider(_ providerId: String, input: Int, output: Int) -> [String: Any] {
      [
        "providerId": providerId, "requests": 1, "unavailableRequests": 0,
        "last": ["status": "available", "inputTokens": input, "outputTokens": output, "totalTokens": input + output],
        "totals": ["inputTokens": input, "outputTokens": output, "totalTokens": input + output],
      ]
    }
    let providers = [
      provider("lmstudio", input: 100, output: 20),
      provider("kolibri", input: 200, output: 40),
    ]
    let performance: [String: Any] = ["schemaVersion": 1, "status": "available", "providers": [
      ["providerId": "lmstudio", "status": "available", "inputTokens": 100,
       "outputTokens": 20, "totalTokens": 120, "generationDurationMs": 1000],
      ["providerId": "kolibri", "status": "available", "inputTokens": 200,
       "outputTokens": 40, "totalTokens": 240, "generationDurationMs": 1000],
    ]]
    let snapshot = try menuSnapshot(providers: providers, performance: performance)
    let visible = CompanionPresentation.visibleTokenProviders(try XCTUnwrap(snapshot.tokenUsage).providers)
    XCTAssertEqual(visible.map(\.providerId), ["lmstudio"])
    XCTAssertEqual(snapshot.tokenPerformance?.outputTokensPerSecond(for: try XCTUnwrap(visible.first)), 20)
    XCTAssertTrue(CompanionPresentation.visibleTokenProviders(
      try menuSnapshot(providers: [providers[1]], performance: performance).tokenUsage?.providers ?? []).isEmpty)
  }

  func testDirectMenuUsesVerifiedHeaderAndRendersSyntheticNativePreview() throws {
    let controller = CompanionController(pollingEnabled: false, appVersion: "0.30.0")
    controller.snapshot = try menuSnapshot(version: "0.30.0")
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
    settle(host)
    XCTAssertEqual(host.fittingSize.width, 320, accuracy: 0.5)
    XCTAssertGreaterThan(host.fittingSize.height, 300)
    XCTAssertLessThan(host.fittingSize.height, 600)
    let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: bitmap)
    let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    XCTAssertGreaterThan(png.count, 1000)
    if let path = ProcessInfo.processInfo.environment["PICKERMUX_MENU_PREVIEW_PATH"] {
      try png.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
  }

  func testMenuWithoutMainActionsUsesOnlyTheFooterDividerBoundary() throws {
    let controller = CompanionController(pollingEnabled: false)
    let kolibri: [String: Any] = [
      "providerId": "kolibri", "requests": 1, "unavailableRequests": 0,
      "last": ["status": "available", "inputTokens": 200, "outputTokens": 40, "totalTokens": 240],
      "totals": ["inputTokens": 200, "outputTokens": 40, "totalTokens": 240],
    ]
    controller.snapshot = try menuSnapshot(providers: [kolibri], actions: ["diagnose", "full-refresh", "usage-reset"])
    XCTAssertTrue(CompanionPresentation.mainActions(available: try XCTUnwrap(controller.snapshot).actions).isEmpty)
    XCTAssertEqual(CompanionMenuDividerPlacement.allCases, [.footerBoundary])

    let host = NSHostingView(rootView: CompanionPanel(controller: controller))
    settle(host)
    XCTAssertEqual(host.fittingSize.width, 320, accuracy: 0.5)
    XCTAssertGreaterThan(host.fittingSize.height, 100)
    XCTAssertLessThan(host.fittingSize.height, 520)
  }

  func testNativeOnlyCompactMenuAddsOneFixedConfigWarningWithoutDuplicatingHeading() throws {
    XCTAssertEqual(CompanionPresentation.menuPrimaryHeadings, [CompanionPresentation.integrationToggleTitle])
    let nativeController = CompanionController(pollingEnabled: false)
    nativeController.snapshot = try menuSnapshot(actions: [], providerStatus: .nativeOnly)
    let externalController = CompanionController(pollingEnabled: false)
    externalController.snapshot = try menuSnapshot(actions: [], providerStatus: .external)
    XCTAssertEqual(CompanionPresentation.compactProviderNotice(for: nativeController.snapshot),
      "No external models configured")
    XCTAssertNil(CompanionPresentation.compactProviderNotice(for: externalController.snapshot))

    let native = NSHostingView(rootView: CompanionPanel(controller: nativeController))
    let external = NSHostingView(rootView: CompanionPanel(controller: externalController))
    settle(native)
    settle(external)
    XCTAssertGreaterThan(native.fittingSize.height, external.fittingSize.height + 20)
    XCTAssertEqual(native.fittingSize.width, 320, accuracy: 0.5)
  }

  func testBundledSetupPromptIsRoutedOutOfTheCompactMenu() throws {
    let controller = CompanionController(pollingEnabled: false)
    let actions = ["configuration-preview", "configuration-apply", "integration-deactivate"]
    let installed = try menuSnapshot(actions: actions)
    controller.snapshot = installed.allowingOnly(
      [.configurationPreview, .configurationApply, .integrationDeactivate], bundledBackend: true)

    XCTAssertTrue(controller.integrationState.isEnabled)
    XCTAssertTrue(controller.integrationState.needsSetupUpgrade)
    XCTAssertNil(CompanionPresentation.compactIntegrationGuidance(for: controller.integrationState))
    XCTAssertFalse(controller.bundledSetupAvailability.isEnabled)
    XCTAssertTrue(try XCTUnwrap(controller.bundledSetupAvailability.disabledReason).contains("Fully quit Codex"))

    let host = NSHostingView(rootView: CompanionPanel(controller: controller))
    settle(host)
    XCTAssertEqual(host.fittingSize.width, 320, accuracy: 0.5)
    XCTAssertGreaterThan(host.fittingSize.height, 100)
    XCTAssertLessThan(host.fittingSize.height, 520)
  }

  func testNestedStateExpansionAndCollapseUpdateDocumentHeightAndKeepFooterOutsideScrolling() throws {
    let state = ExpandingMenuState()
    let host = NSHostingView(rootView: CompanionMenuViewport {
      ExpandingMenuContent(state: state)
    } footer: {
      Text("Synthetic footer").frame(height: 28)
    })
    settle(host)
    let initialHeight = host.fittingSize.height
    let scroll = try XCTUnwrap(findScrollView(host))
    XCTAssertLessThan(initialHeight, 100)
    XCTAssertEqual(scroll.contentView.bounds.minY, 0, accuracy: 0.5)
    XCTAssertTrue(try XCTUnwrap(scroll.documentView).isFlipped)
    state.expanded = true
    settle(host)
    XCTAssertEqual(host.fittingSize.height, 548, accuracy: 0.5)
    XCTAssertGreaterThan(try XCTUnwrap(scroll.documentView).frame.height, 1000)
    XCTAssertEqual(scroll.contentView.bounds.minY, 0, accuracy: 0.5)
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 200))
    scroll.reflectScrolledClipView(scroll.contentView)
    XCTAssertGreaterThan(scroll.contentView.bounds.minY, 100)
    state.expanded = false
    settle(host)
    XCTAssertEqual(host.fittingSize.height, initialHeight, accuracy: 0.5)
    XCTAssertEqual(scroll.contentView.bounds.minY, 0, accuracy: 0.5)
  }

  func testMultipleProvidersAndLongFeedbackRemainBoundedAndScrollable() throws {
    let controller = CompanionController(pollingEnabled: false)
    let providers: [[String: Any]] = (0..<4).map { index in
      ["providerId": "synthetic-provider-\(index)", "requests": 1, "unavailableRequests": 1,
       "last": ["status": "unavailable"], "totals": ["inputTokens": 0, "outputTokens": 0, "totalTokens": 0]]
    }
    controller.snapshot = try menuSnapshot(providers: providers)
    controller.operationNoticeAction = .configurationApply
    controller.operationFailed = true
    controller.operationNotice = String(repeating: "Synthetic setup feedback. ", count: 8)
    let host = NSHostingView(rootView: CompanionPanel(controller: controller))
    settle(host)
    XCTAssertEqual(host.fittingSize.width, 320, accuracy: 0.5)
    XCTAssertLessThanOrEqual(host.fittingSize.height, 620)
    let scroll = try XCTUnwrap(findScrollView(host))
    XCTAssertGreaterThan(try XCTUnwrap(scroll.documentView).frame.height, scroll.frame.height)
    XCTAssertEqual(scroll.contentView.bounds.minY, 0, accuracy: 0.5)
    XCTAssertGreaterThan(host.frame.height - scroll.frame.height, 60)
  }

  func testBackendVersionGuidanceKeepsMenuBoundedAndFooterVisible() throws {
    let controller = CompanionController(pollingEnabled: false, appVersion: "0.22.1")
    controller.snapshot = try menuSnapshot()
    XCTAssertTrue(controller.backendUpgradeAvailable)
    let host = NSHostingView(rootView: CompanionPanel(controller: controller)
      .background(Color(nsColor: .windowBackgroundColor)).preferredColorScheme(.light))
    host.appearance = NSAppearance(named: .aqua)
    settle(host)
    XCTAssertEqual(host.fittingSize.width, 320, accuracy: 0.5)
    XCTAssertLessThanOrEqual(host.fittingSize.height, 620)
    let scroll = try XCTUnwrap(findScrollView(host))
    XCTAssertGreaterThan(host.frame.height - scroll.frame.height, 60)
    if let path = ProcessInfo.processInfo.environment["PICKERMUX_BACKEND_UPDATE_PREVIEW_PATH"] {
      let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
      host.cacheDisplay(in: host.bounds, to: bitmap)
      let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
      try png.write(to: URL(fileURLWithPath: path), options: .atomic)
    }
  }

  private func menuSnapshot(providers: [[String: Any]]? = nil, performance: [String: Any]? = nil,
                            actions: [String]? = nil,
                            providerStatus: ProviderConfigurationKind? = nil,
                            version: String = "0.22.0") throws -> CompanionSnapshot {
    let syntheticProvider: [String: Any] = [
      "providerId": "lmstudio", "requests": 8, "unavailableRequests": 0,
      "last": ["status": "available", "inputTokens": 14900, "outputTokens": 320, "totalTokens": 15220],
      "totals": ["inputTokens": 140000, "outputTokens": 3250, "totalTokens": 143250],
    ]
    var fields: [String: Any] = [
      "schemaVersion": 1, "version": version, "state": "ready",
      "capabilities": ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v2", "token-usage-reset-v1"],
      "desktop": ["status": "running"], "installation": ["status": "installed"],
      "managedConfig": ["status": "installed"], "service": ["status": "running"],
      "compatibility": ["status": "compatible"], "accountCache": ["status": "ready"],
      "integration": ["status": "pickermux"], "recovery": ["status": "idle"], "issues": [],
      "actions": actions ?? ["refresh", "full-refresh", "open", "diagnose", "certify", "recover", "usage-reset"],
      "tokenUsage": ["schemaVersion": 2, "status": "available", "resetAt": NSNull(), "providers": providers ?? [syntheticProvider]],
    ]
    if let performance {
      fields["tokenPerformance"] = performance
      fields["capabilities"] = ["integration-toggle-v1", "native-uninstall-v1", "token-usage-v2", "token-usage-reset-v1", "token-performance-v1"]
    }
    if let providerStatus {
      fields["providerConfiguration"] = ["status": providerStatus.rawValue]
      fields["capabilities"] = ["integration-toggle-v1", "native-uninstall-v1",
        "native-only-lmstudio-setup-v1", "token-usage-v2", "token-usage-reset-v1"] +
        (performance == nil ? [] : ["token-performance-v1"])
    }
    return try CompanionSnapshot.decode(JSONSerialization.data(withJSONObject: fields))
  }

  private func tokenUsageHeight(_ snapshot: CompanionSnapshot) -> CGFloat {
    let host = NSHostingView(rootView: TokenUsageView(snapshot: snapshot).frame(width: 292).padding(14))
    settle(host)
    return host.fittingSize.height
  }

  private func assertViewport<V: View>(_ host: NSHostingView<V>, measurements: Measurements,
                                             file: StaticString = #filePath, line: UInt = #line) {
    settle(host)
    let fitting = host.fittingSize
    XCTAssertEqual(fitting.width, 320, accuracy: 0.5, file: file, line: line)
    XCTAssertGreaterThan(fitting.height, 0, file: file, line: line)
    XCTAssertLessThanOrEqual(fitting.height, 520, file: file, line: line)
    XCTAssertEqual(Set(measurements.viewportSizes.keys), Set(["minimum", "tiny", "ideal", "maximum"]), file: file, line: line)
    for (proposal, size) in measurements.viewportSizes {
      XCTAssertEqual(size.width, 320, accuracy: 0.5, "Width under \(proposal) proposal", file: file, line: line)
      XCTAssertEqual(size.height, fitting.height, accuracy: 0.5, "Height under \(proposal) proposal", file: file, line: line)
    }
  }

  private func assertFixedViewport<V: View>(_ host: NSHostingView<V>, measurements: Measurements,
                                             width: CGFloat, height: CGFloat,
                                             file: StaticString = #filePath, line: UInt = #line) {
    settle(host)
    let fitting = host.fittingSize
    XCTAssertEqual(fitting.width, width, accuracy: 0.5, file: file, line: line)
    XCTAssertEqual(fitting.height, height, accuracy: 0.5, file: file, line: line)
    XCTAssertEqual(Set(measurements.viewportSizes.keys), Set(["minimum", "tiny", "ideal", "maximum"]), file: file, line: line)
    for (proposal, size) in measurements.viewportSizes {
      XCTAssertEqual(size.width, width, accuracy: 0.5, "Width under \(proposal) proposal", file: file, line: line)
      XCTAssertEqual(size.height, height, accuracy: 0.5, "Height under \(proposal) proposal", file: file, line: line)
    }
  }

  private func settle<V: View>(_ host: NSHostingView<V>) {
    for _ in 0..<5 {
      host.frame = CGRect(origin: .zero, size: host.fittingSize)
      host.layoutSubtreeIfNeeded()
      RunLoop.main.run(until: Date().addingTimeInterval(0.01))
    }
    host.frame = CGRect(origin: .zero, size: host.fittingSize)
    host.layoutSubtreeIfNeeded()
  }

  private func findScrollView(_ view: NSView) -> NSScrollView? {
    if let scroll = view as? NSScrollView { return scroll }
    return view.subviews.lazy.compactMap(findScrollView).first
  }
}

@MainActor
private final class ExpandingMenuState: ObservableObject {
  @Published var expanded = false
}

private struct ExpandingMenuContent: View {
  @ObservedObject var state: ExpandingMenuState

  var body: some View {
    VStack(spacing: 0) {
      Text("Synthetic header").frame(height: 30)
      if state.expanded {
        ForEach(0..<40) { index in Text("Synthetic expanded row \(index)").frame(height: 30) }
      }
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
