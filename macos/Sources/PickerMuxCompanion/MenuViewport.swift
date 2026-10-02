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
    // MenuBarExtra can propose a compressed size; a maximum alone permits
    // ScrollView to collapse even when its content has a useful ideal height.
    VStack(spacing: 0) {
      ScrollView(.vertical) { content }
        .frame(maxHeight: .infinity)
      if let footer { footer }
    }
      .frame(width: 400, height: 600)
  }
}
