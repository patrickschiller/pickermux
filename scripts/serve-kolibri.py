#!/usr/bin/env python3
"""Compatibility entry point for PickerMux's canonical MLX runtime."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime.mlx.kolibri import *


if __name__ == "__main__":
  main()
