"""Where StellarHub keeps the user's data: in their profile, or next to the program in the portable version.

The portable version is the same program with a file named `StellarHub.portable` next to StellarHub.exe. Then
the settings, logs, history and the interface cache live in a `Data` folder beside it (so they travel on the USB
drive) and StellarHub leaves nothing in Windows' startup entries or scheduled tasks.

What it saves before changing the system (registry and service backups, the uninstaller's quarantine, driver
backups) stays in ProgramData on each PC on purpose: a backup of one PC's registry belongs to that PC, so the change
can be undone there whichever drive StellarHub runs from.
"""
import os
import sys

FROZEN = bool(getattr(sys, "frozen", False))
MARKER = "StellarHub.portable"


def program_dir():
    """The folder StellarHub.exe is in (the project folder when running from source)."""
    if FROZEN:
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _portable():
    if os.environ.get("STELLARHUB_PORTABLE") == "1":  # tests run the source as if it were portable
        return True
    return FROZEN and os.path.isfile(os.path.join(program_dir(), MARKER))


PORTABLE = _portable()


def data_dir():
    """Settings, logs, history: %APPDATA%\\StellarHub, or <program>\\Data in the portable version."""
    if PORTABLE:
        return os.environ.get("STELLARHUB_PORTABLE_DATA") or os.path.join(program_dir(), "Data")
    return os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "StellarHub")


def local_dir():
    """Machine-local cache (the interface's browser profile): %LOCALAPPDATA%\\StellarHub, or <program>\\Data\\Local."""
    if PORTABLE:
        return os.path.join(data_dir(), "Local")
    return os.path.join(os.environ.get("LOCALAPPDATA") or data_dir(), "StellarHub")


def settings_file():
    return os.path.join(data_dir(), "settings.json")
