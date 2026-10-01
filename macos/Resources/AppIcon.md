# PickerMux app icon

`AppIcon.png` is the versioned 1024 × 1024 RGBA master for the macOS app.
The original design represents three model sources joining a selected route.
It is an independent PickerMux mark and does not use another project's logo.

The artwork was generated with the built-in image generation tool on
2026-10-01. Native `sips` resizes the approved master for packaging; the build
creates the standard iconset and compiles `AppIcon.icns` with `iconutil`.
The generated ICNS belongs to build output. `CFBundleIconFile` declares
`AppIcon` in the application bundle.

## Generation prompt

> Use case: logo-brand. Asset type: production macOS app icon for the independent community utility PickerMux, which brings multiple model sources into one picker. Create one original square 1024 by 1024 master icon. A softly rounded square tile with subtle depth and restrained glass/enamel finish, containing a bold simple abstract routing/picker mark: three clean parallel paths converge into one selected path, with a small clear selection dot. Cohesive elegant macOS utility aesthetic, crisp silhouette readable at 16 pixels, balanced generous inner padding, slight studio highlight. Use a sophisticated cool dark tile and luminous cool accent paths, without ornate detail. Orthographic front view; no surrounding scene or presentation mockup, no text or letters, no logos from OpenAI, Codex, Ollama, LM Studio or Apple, no watermark, no tiny circuit detail. The icon tile is the only object; genuinely transparent background outside the rounded square, with no cast shadow extending outside the tile.

## Refinement prompt

> Refine this PickerMux macOS app icon. Preserve the entire rounded square tile, its exact routing symbol, palette and overall composition. Remove every stray colored pixel, fleck, line or glow outside the tile so that all surrounding padding is perfectly transparent. Clean high quality edges, no outside cast shadow. Deliver one square master asset, no text, no scene, no other changes.

Both tool calls requested a transparent background. Keep the PNG alpha channel
when converting or exporting the master.
