"""PyInstaller entry point. `python -m aurum_bridge` is used in development; a frozen exe needs a plain script
that imports the package (relative imports in __main__.py do not work as a top-level script)."""
import multiprocessing
import sys

from aurum_bridge.__main__ import main

if __name__ == "__main__":
    multiprocessing.freeze_support()
    sys.exit(main())
