# PickerMux explainer

A 36-second German animation without audio explains model selection, exact
provider routing, the response path, and certified web tool calls. The README
uses the looping GIF for inline playback and links to the MP4. All views and
model names are synthetic examples; the animation contains no screen capture,
real chat, local configuration, or credentials.

The local model can request a tool; Codex executes the call and returns its
result to that model. Web access uses the native Codex service and requires
internet access and native sign-in. Tool access requires the exact model's
certification. The animation explains the architecture and does not establish
live model behavior or factual accuracy.

| File | Format |
| --- | --- |
| `pickermux-explainer-de.mp4` | 1280 × 720, 36 seconds, H.264/yuv420p, 30 fps, Faststart, no audio |
| `pickermux-explainer-de.gif` | 960 × 540, 10 fps, looping README animation |
| `pickermux-explainer-de-poster.png` | 1280 × 720 title frame |

The MP4 can also be attached to a GitHub issue or pull request. Keep the GIF
and video beside this file when using the relative README links.

## Regenerate

On macOS, use the Swift compiler with AppKit and an installed `ffmpeg` with
`libx264`. No new npm runtime dependency is required. From the repository root,
choose a fresh absolute output directory:

```bash
bash scripts/explainer/render.sh /tmp/pickermux-explainer-preview
```

The renderer and compiler write only to that new directory. The script refuses
an existing output directory and does not replace the checked-in media.
Inspect the generated scenes before deliberately copying updated media here.
System font rendering can vary between macOS versions. The vector source is
in [renderer.swift](../../scripts/explainer/renderer.swift).

PickerMux is an unofficial community project, unaffiliated with OpenAI, Codex,
or LM Studio.
