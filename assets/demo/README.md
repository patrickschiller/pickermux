# PickerMux explainer

A 36-second English animation without audio shows model selection, provider
routing, responses, and certified tools. Codex executes tool calls and returns
results to the selected model; native web access needs internet and sign-in.
All views and names are synthetic. The animation contains no private data and
does not prove live model behavior or factual accuracy.

| File | Format |
| --- | --- |
| `pickermux-explainer-en.mp4` | 1280 × 720, H.264/yuv420p, 30 fps, Faststart |
| `pickermux-explainer-en.gif` | 960 × 540, 10 fps, looping |
| `pickermux-explainer-en-poster.png` | 1280 × 720 title frame |

The main README embeds the GIF and links to the MP4. Keep these files together.

## Regenerate

On macOS with AppKit, Swift, and `ffmpeg`/`libx264`, choose a fresh directory:

```bash
bash scripts/explainer/render.sh /tmp/pickermux-explainer-preview
```

The script refuses existing output and leaves checked-in media intact. Inspect
the scenes before copying replacements. Font rendering can vary by macOS
version. Source: [renderer.swift](../../scripts/explainer/renderer.swift).

PickerMux is an unofficial community project, unaffiliated with OpenAI, Codex,
or LM Studio.
