"""Freeze the bridge into a single executable with PyInstaller.

Windows (release): pip install MetaTrader5 pyinstaller && python bridge/build_exe.py
Output: apps/desktop/resources/bridge/aurum-bridge(.exe), which electron-builder ships as extraResources.

The MetaTrader5 wheel only exists for Windows, so the real product exe MUST be built on Windows. On Linux the
script still works for a smoke test of the freeze mechanics if a stand-in MetaTrader5 module is on PYTHONPATH
(the output is then a Linux binary and is never shipped).
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "apps" / "desktop" / "resources" / "bridge"
WORK = ROOT / "build"


def main() -> int:
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile",
        "--name", "aurum-bridge",
        "--console",  # stdout/stderr are piped to Electron; the child is spawned with windowsHide
        "--paths", str(ROOT),
        "--hidden-import", "MetaTrader5",
        "--collect-all", "MetaTrader5",  # native DLL bridge + numpy dependency
        "--distpath", str(OUT),
        "--workpath", str(WORK),
        "--specpath", str(WORK),
        str(ROOT / "run_bridge.py"),
    ]
    print(" ".join(cmd), flush=True)
    rc = subprocess.call(cmd)
    if rc:
        return rc
    exe = OUT / ("aurum-bridge.exe" if sys.platform == "win32" else "aurum-bridge")
    if not exe.is_file():
        print(f"expected {exe} was not produced", file=sys.stderr)
        return 1
    print(f"built {exe} ({exe.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
