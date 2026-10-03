#!/bin/bash
set -euo pipefail

if [[ $# != 1 || "$1" != /* ]]; then
  printf '%s\n' 'Usage: bash scripts/explainer/render.sh /absolute/fresh/output-directory' >&2
  exit 2
fi

explainer_sources="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
explainer_output="$1"
mkdir -m 700 "$explainer_output"
swiftc -O "$explainer_sources/renderer.swift" -o "$explainer_output/renderer" -module-cache-path "$explainer_output/module-cache"
"$explainer_output/renderer" --poster 3 "$explainer_output/pickermux-explainer-en-poster.png"
"$explainer_output/renderer" | ffmpeg -hide_banner -loglevel warning -f rawvideo -pixel_format rgba -video_size 1280x720 -framerate 30 -i pipe:0 -an -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -movflags +faststart -metadata title='PickerMux – how it works' -metadata comment='Synthetic vector explainer; no user session or private state' "$explainer_output/pickermux-explainer-en.mp4"
ffmpeg -hide_banner -loglevel warning -i "$explainer_output/pickermux-explainer-en.mp4" -filter_complex '[0:v]fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=3' -loop 0 "$explainer_output/pickermux-explainer-en.gif"
