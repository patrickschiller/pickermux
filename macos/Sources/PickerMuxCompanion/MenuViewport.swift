import AppKit
import SwiftUI

struct CompanionMenuViewport<Content: View>: View {
  private let content: Content
  private let footer: AnyView?

  init(@ViewBuilder content: () -> Content) {
    self.content = content()
    self.footer = nil
  }

  init<Footer: View>(@ViewBuilder content: () -> Content, @ViewBuilder footer: () -> Footer) {
    self.content = content()
    self.footer = AnyView(footer())
  }

  var body: some View {
    VStack(spacing: 0) {
      AdaptiveMenuScrollView(content: content)
      if let footer { footer }
    }
    .frame(width: 320)
    .fixedSize(horizontal: false, vertical: true)
  }
}

private struct AdaptiveMenuScrollView<Content: View>: NSViewRepresentable {
  let content: Content

  func makeNSView(context: Context) -> MenuScrollView {
    MenuScrollView(content: AnyView(content))
  }

  func updateNSView(_ view: MenuScrollView, context: Context) {
    view.host.rootView = AnyView(content.frame(width: 320).fixedSize(horizontal: false, vertical: true))
    view.updateDocumentSize()
  }

  func sizeThatFits(_ proposal: ProposedViewSize, nsView: MenuScrollView, context: Context) -> CGSize? {
    nsView.updateDocumentSize()
    return nsView.intrinsicContentSize
  }
}

private final class MenuScrollView: NSScrollView {
  let host: MenuDocumentHost
  private var documentHeight: CGFloat = 0
  private var updateScheduled = false

  init(content: AnyView) {
    host = MenuDocumentHost(rootView: AnyView(content.frame(width: 320).fixedSize(horizontal: false, vertical: true)))
    host.isFlipped = true
    host.sizingOptions = [.intrinsicContentSize]
    super.init(frame: .zero)
    drawsBackground = false
    borderType = .noBorder
    hasVerticalScroller = true
    hasHorizontalScroller = false
    autohidesScrollers = true
    scrollerStyle = .overlay
    documentView = host
    host.onIntrinsicSizeChange = { [weak self] in self?.scheduleDocumentSizeUpdate() }
    updateDocumentSize()
  }

  required init?(coder: NSCoder) { nil }

  override var intrinsicContentSize: NSSize {
    NSSize(width: 320, height: min(documentHeight, 520))
  }

  func updateDocumentSize() {
    // Measure the document itself so a short menu keeps its natural height,
    // including under MenuBarExtra's compressed window proposals.
    let height = host.fittingSize.height
    let atTop = contentView.bounds.minY <= 0.5
    let documentSize = CGSize(width: 320, height: height)
    if host.frame.size != documentSize { host.setFrameSize(documentSize) }
    if documentHeight != height {
      documentHeight = height
      invalidateIntrinsicContentSize()
      if atTop { contentView.scroll(to: .zero) }
      else { contentView.scroll(to: contentView.constrainBoundsRect(contentView.bounds).origin) }
      reflectScrolledClipView(contentView)
    }
  }

  private func scheduleDocumentSizeUpdate() {
    guard !updateScheduled else { return }
    updateScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.updateScheduled = false
      self.updateDocumentSize()
    }
  }
}

private final class MenuDocumentHost: NSHostingView<AnyView> {
  var onIntrinsicSizeChange: (() -> Void)?

  override func layout() {
    super.layout()
    onIntrinsicSizeChange?()
  }

  override func invalidateIntrinsicContentSize() {
    super.invalidateIntrinsicContentSize()
    onIntrinsicSizeChange?()
  }
}
