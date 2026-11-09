"""Sidecar saves keep what other windows wrote (#31).

A window saves only the slices it changed itself, merged into the file on
disk, so a window holding an older copy can't overwrite newer results.
Runs tests/sidecar_merge_runner.mjs (Node >= 22.6) on
frontend/src/utils/sidecarMerge.ts.

Run from the repo root:  python tests/sidecar_merge_check.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
out = subprocess.run(["node", str(ROOT / "tests" / "sidecar_merge_runner.mjs")],
                     capture_output=True, text=True, cwd=ROOT)
text = out.stdout.strip()
ok = out.returncode == 0 and text.startswith("OK")
print(text if ok else f"FAIL\n{text}\n{out.stderr.strip()}")
sys.exit(0 if ok else 1)
