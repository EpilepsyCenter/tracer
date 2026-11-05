"""Run every TRACER test and summarise.

Each test is a standalone script (``tests/*_check.py`` and
``tests/trains_parity.py``) that prints "OK" and exits 0 when it passes.
Parts that need lab recordings in ``sample_data/`` (not in the
repository) are skipped when those files are missing; a test that skips
entirely prints "SKIP".

Run from the repository root:  python tests/run_all.py
Exit status is 1 if any test fails. ``trains_parity.py`` needs Node 22+.
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TESTS = sorted((ROOT / "tests").glob("*_check.py")) + [ROOT / "tests" / "trains_parity.py"]


def main() -> int:
    failed, skipped = [], []
    for t in TESTS:
        t0 = time.time()
        proc = subprocess.run([sys.executable, str(t)], cwd=ROOT, capture_output=True, text=True)
        out = (proc.stdout + proc.stderr).strip()
        if proc.returncode != 0:
            status = "FAIL"
            failed.append((t.name, out))
        elif out.startswith("SKIP"):
            status = "SKIP"
            skipped.append(t.name)
        else:
            status = "ok"
        print(f"{status:4s}  {t.name:34s} {time.time() - t0:5.1f} s", flush=True)
    print(f"\n{len(TESTS) - len(failed) - len(skipped)} passed, {len(skipped)} skipped, {len(failed)} failed")
    for name, out in failed:
        print(f"\n--- {name} ---\n{out[-3000:]}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
