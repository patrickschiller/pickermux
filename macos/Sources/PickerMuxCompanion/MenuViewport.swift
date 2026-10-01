import SwiftUI

struct CompanionMenuViewport<Content: View>: View {
  private let content: Content

  init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  var body: some View {
    // MenuBarExtra can propose a compressed size; a maximum alone permits
    // ScrollView to collapse even when its content has a useful ideal height.
    ScrollView(.vertical) { content }
      .frame(width: 400, height: 600)
  }
}
