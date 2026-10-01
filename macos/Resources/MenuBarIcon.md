# PickerMux menu-bar symbol

`MenuBarIcon.png` is a transparent 1024 × 1024 RGBA master with three model
sources joining one selected route. It is separate from the Finder/Dock icon.
The app loads the compiled `MenuBarIcon.icns` as an 18-point template, allowing
macOS to apply the light/dark menu-bar tint.

The final artwork uses deterministic native vector paths from
[`render-menubar-icon.swift`](../../scripts/render-menubar-icon.swift).
Regenerate the master on macOS with full Xcode selected for this command:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun swift scripts/render-menubar-icon.swift macos/Resources/MenuBarIcon.png
```

The companion builder validates transparent RGBA artwork, converts every
standard/Retina representation with `sips` and `iconutil`, and records both
the source and packaged hashes. Generated ICNS files belong only to build
output. The existing AppIcon remains unchanged.

An exploratory bitmap draft used the built-in image generator on 2026-10-01;
the final small template glyph was drawn with native vector geometry. The
draft prompt was:

> Create a new monochrome macOS menu-bar template glyph for PickerMux, using the attached app icon only as a reference for the routing motif. Output a single square 1024 by 1024 RGBA asset on a perfectly transparent background. Design three evenly spaced small filled circular model-source nodes on the left; the top and bottom paths curve smoothly toward the middle, joining the straight middle path into one selected filled circular node on the right. Use a crisp, flat, solid white silhouette with consistent bold paths and rounded transitions. The main three-to-one routing form must be immediately legible when rendered at 18 pixels. Make the glyph fill roughly 85 percent of the square; centered, balanced, compact. Keep the selection circle modest, not a big target ring. Absolutely no rounded-square tile, no colored background, no texture, no gradients, no depth, no shadows, no glow, no text, no letters, no dotted circuit details, no mockup. Every pixel outside the standalone flat routing glyph must be transparent. Independent original PickerMux mark; do not use logos of Apple, Codex, OpenAI, Ollama or LM Studio.
