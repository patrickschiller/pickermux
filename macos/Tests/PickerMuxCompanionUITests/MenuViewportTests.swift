import AppKit
import SwiftUI
import XCTest
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
