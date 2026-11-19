"""The portable version: build\\dist\\StellarHub (what PyInstaller made) plus the StellarHub.portable marker, zipped
into dist\\StellarHub-Portable-<version>.zip with its .sha256. Run by packaging/build.ps1 after PyInstaller.

Inside the .zip everything sits in a StellarHub\\ folder, so unzipping it anywhere (a USB drive) gives one tidy
folder. The marker makes StellarHub keep its settings in StellarHub\\Data next to it (see stellarhub/paths.py)."""
import hashlib
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "build", "dist", "StellarHub")
MARKER = """This file makes this copy of StellarHub portable.

While it is here, StellarHub keeps its settings, history and logs in the Data folder next to it (so they travel with
the folder, for example on a USB drive) and adds nothing to Windows' startup or scheduled tasks.

What StellarHub backs up before changing a PC (registry, services, the uninstaller's quarantine) stays on that PC,
in ProgramData, so those changes can always be undone there.

Delete this file to use this copy like an installed one.
"""


def main():
    ver = re.search(r'VERSION = "(.+?)"', open(os.path.join(ROOT, "stellarhub", "__init__.py"), encoding="utf-8").read()).group(1)
    if not os.path.isfile(os.path.join(SRC, "StellarHub.exe")):
        sys.exit("build\\dist\\StellarHub\\StellarHub.exe is missing: run PyInstaller first")
    out = os.path.join(ROOT, "dist", f"StellarHub-Portable-{ver}.zip")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for base, dirs, files in os.walk(SRC):
            dirs.sort()
            for f in sorted(files):
                full = os.path.join(base, f)
                z.write(full, "StellarHub/" + os.path.relpath(full, SRC).replace(os.sep, "/"))
        z.writestr("StellarHub/StellarHub.portable", MARKER)
        z.write(os.path.join(ROOT, "LICENSE"), "StellarHub/LICENSE.txt")
    h = hashlib.sha256(open(out, "rb").read()).hexdigest().upper()
    with open(out + ".sha256", "w", encoding="ascii") as fh:
        fh.write(f"{h}  {os.path.basename(out)}\n")
    print(f"{out} ({os.path.getsize(out) / 1048576:.1f} MB)\nSHA-256 {h}")


if __name__ == "__main__":
    main()
