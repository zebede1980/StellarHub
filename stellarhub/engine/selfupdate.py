"""StellarHub's own updates, from the releases of its GitHub repository.

How an update runs (the same steps for every kind of install):
  1. The app asks GitHub for the latest release (check) and shows what is new.
  2. The user says yes: the app starts the updater, which is StellarHub.exe itself with --self-update:
       - installed for one user (in %LOCALAPPDATA%) or already running as administrator: started directly;
       - installed for everyone (in Program Files): through the "StellarHub\\Update" scheduled task the installer
         created, which runs it with administrator rights without the Windows prompt; if the task is not there,
         Windows asks once.
  3. The updater downloads the installer into <install folder>\\update (in Program Files only administrators can
     write there), checks it against the SHA-256 published with the release, and says "ready" in
     <install folder>\\update\\state.json, which the app reads to show the progress.
  4. The app leaves a note for after the update (update-pending.json), starts a small helper that will reopen it,
     and closes. The updater waits for it to be gone, starts the installer silently (/VERYSILENT) and exits so no
     file of the install folder is in use. The installer writes "done" (or "failed") to state.json when it ends;
     the helper sees it and opens StellarHub again, which then says it was updated.

The portable version (stellarhub/paths.py) takes the release's StellarHub-Portable-X.zip instead: the updater
unpacks it into <program>/update/new and says "ready"; the app closes and starts the NEW copy with --finish-update,
which waits for the old one to be gone, copies its own files over it (never the Data folder) and opens it. No script
replaces the program behind the user's back: an earlier version did that with a hidden PowerShell, and Kaspersky
flagged it as malware (PDM:Trojan.Win32.Generic), which is why it works this way.

The elevated updater never takes instructions from the user's side: it asks GitHub itself, only for this
repository, only for a newer version, and only runs a file whose hash matches. The one thing it reads from the
user's profile is a "cancel" flag.
"""
import ctypes
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.request

from .. import VERSION
from ..i18n import tr

EXPORTS = {"check", "mode", "start", "state", "cancel", "after_update", "finish"}

REPO = None  # fork: upstream releases would overwrite local changes; set to "owner/repo" to turn updates back on
API = f"https://api.github.com/repos/{REPO}/releases/latest" if REPO else None
TASK = r"StellarHub\Update"
ASSET_RE = re.compile(r"^StellarHub-Setup-(\d+(?:\.\d+){1,3})\.exe$", re.I)
PORTABLE_RE = re.compile(r"^StellarHub-Portable-(\d+(?:\.\d+){1,3})\.zip$", re.I)
NO_WINDOW = 0x08000000
DETACHED = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
NEW_GROUP, BREAKAWAY = 0x00000200, 0x01000000  # CREATE_NEW_PROCESS_GROUP, CREATE_BREAKAWAY_FROM_JOB
FROZEN = bool(getattr(sys, "frozen", False))


# ---------------------------------------------------------------- places
def _data_dir():
    from .. import paths
    return paths.data_dir()


def install_dir():
    return os.path.dirname(os.path.abspath(sys.executable))


def update_dir():
    """Where the updater downloads and reports: next to the program (STELLARHUB_UPDATE_DIR in tests)."""
    return os.environ.get("STELLARHUB_UPDATE_DIR") or os.path.join(install_dir(), "update")


def state_path():
    return os.path.join(update_dir(), "state.json")


def _cancel_flag():
    from .. import paths
    return os.path.join(paths.local_dir(), "update.cancel")


def _pending_path():
    return os.path.join(_data_dir(), "update-pending.json")


def _under(path, root):
    if not root:
        return False
    path, root = os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(root))
    return path == root or path.startswith(root.rstrip("\\/") + os.sep)


def per_machine():
    """Installed for everyone (Program Files) rather than for one user."""
    return any(_under(install_dir(), os.environ.get(k)) for k in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"))


def _admin():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


# ---------------------------------------------------------------- versions and releases
def parse_version(v):
    m = re.match(r"^\s*v?(\d+(?:\.\d+){0,3})", str(v or ""))
    if not m:
        return None
    parts = [int(x) for x in m.group(1).split(".")]
    return tuple(parts + [0] * (4 - len(parts)))


def newer(a, b):
    """True if version a is newer than version b."""
    pa, pb = parse_version(a), parse_version(b)
    return bool(pa and pb and pa > pb)


def _get(url, limit, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": "StellarHub-Updater", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(limit + 1)[:limit]


def _latest():
    """The latest release as GitHub describes it (STELLARHUB_UPDATE_URL points elsewhere in tests)."""
    url = os.environ.get("STELLARHUB_UPDATE_URL") or API
    if not url:
        return None  # pick(None) is "no release": check() and the updater both report up to date
    return json.loads(_get(url, 2 * 1024 * 1024).decode("utf-8"))


def _portable():
    from .. import paths
    return paths.PORTABLE


def pick(rel, portable=None):
    """From a GitHub release: {ver, setup: {name, url, size}, sha_url, notes, url, date}, or None when the release
    has no file for this copy for its own version (or is a draft or a pre-release). "setup" is the file this copy
    updates with: the installer, or the .zip in the portable version."""
    if not isinstance(rel, dict) or rel.get("draft") or rel.get("prerelease"):
        return None
    ver = str(rel.get("tag_name") or "").lstrip("vV")
    if not parse_version(ver):
        return None
    portable = _portable() if portable is None else portable
    pattern = PORTABLE_RE if portable else ASSET_RE
    assets = {str(a.get("name") or ""): a for a in rel.get("assets") or [] if isinstance(a, dict)}
    setup = None
    for name, a in assets.items():
        m = pattern.match(name)
        if m and parse_version(m.group(1)) == parse_version(ver):
            setup = a
            break
    if not setup or setup["name"] + ".sha256" not in assets:
        return None
    url, sha = str(setup.get("browser_download_url") or ""), str(assets[setup["name"] + ".sha256"].get("browser_download_url") or "")
    if not url.startswith("https://") or not sha.startswith("https://"):
        if not os.environ.get("STELLARHUB_UPDATE_URL"):  # tests serve plain http from this PC
            return None
    return {"ver": ver, "setup": {"name": setup["name"], "url": url, "size": int(setup.get("size") or 0)},
            "sha_url": sha, "notes": str(rel.get("body") or "")[:20000], "url": str(rel.get("html_url") or ""),
            "date": str(rel.get("published_at") or "")}


# ---------------------------------------------------------------- for the app
def mode():
    """How this copy updates: source (from the source code: no installer), direct (no administrator rights needed,
    or it already has them), task (Program Files, through the scheduled task) or uac (Program Files, Windows asks)."""
    if not FROZEN:
        return "source"
    if _portable():
        return "portable"  # replaces its own files where it is (a USB drive): no installer, no rights needed
    if not per_machine() or _admin():
        return "direct"
    return "task" if _task_exists() else "uac"


def check(force=False):
    """Read-only: is there a newer StellarHub on GitHub?"""
    out = {"current": VERSION, "mode": mode()}
    try:
        info = pick(_latest())
    except Exception as e:  # offline, GitHub down or rate-limited: say so, nothing else
        out.update(ok=False, error=str(e)[:200])
        return out
    if not info:
        # a newer release without a file for this kind of copy (e.g. no portable .zip): offer its page instead
        try:
            rel = _latest()
            any_ver = str(rel.get("tag_name") or "").lstrip("vV")
            if newer(any_ver, VERSION):
                out.update(ok=True, newer=True, latest=any_ver, notes=str(rel.get("body") or "")[:20000],
                           url=str(rel.get("html_url") or ""), date=str(rel.get("published_at") or ""), mode="page")
                return out
        except Exception:
            pass
        out.update(ok=True, newer=False)
        return out
    out.update(ok=True, newer=newer(info["ver"], VERSION), latest=info["ver"], notes=info["notes"], url=info["url"],
               date=info["date"], size=info["setup"]["size"])
    return out


def state():
    try:
        with open(state_path(), encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def cancel():
    """Asks a running updater to stop (it checks this flag while downloading and while waiting)."""
    try:
        os.makedirs(os.path.dirname(_cancel_flag()), exist_ok=True)
        with open(_cancel_flag(), "w", encoding="utf-8") as fh:
            fh.write("1")
    except OSError:
        return False
    return True


def _clear_cancel():
    try:
        os.remove(_cancel_flag())
    except OSError:
        pass


def start():
    """Starts the updater. Returns {ok, mode, at} or {ok: False, error}."""
    m = mode()
    if m == "source":
        return {"ok": False, "mode": m, "error": tr("This copy runs from the source code: download the new version from GitHub.")}
    _clear_cancel()
    at = time.time()
    exe = sys.executable
    try:
        if m in ("direct", "portable"):
            subprocess.Popen([exe, "--self-update"], creationflags=DETACHED | NO_WINDOW, close_fds=True, cwd=install_dir())
        elif m == "task":
            r = subprocess.run(["schtasks", "/run", "/tn", TASK], capture_output=True, creationflags=NO_WINDOW, timeout=20)
            if r.returncode != 0:
                m = "uac"
        if m == "uac":
            if ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, "--self-update", install_dir(), 0) <= 32:
                return {"ok": False, "mode": m, "error": tr("Windows did not give permission to install the update.")}
    except Exception as e:
        return {"ok": False, "mode": m, "error": str(e)[:200]}
    return {"ok": True, "mode": m, "at": at}


def finish(to, route=None):
    """The updater said "ready": leave a note for after the update and start the helper that reopens StellarHub
    once the installer is done. The app closes right after this."""
    note = {"from": VERSION, "to": str(to)[:20], "route": str(route or "")[:80], "at": time.time()}
    try:
        os.makedirs(_data_dir(), exist_ok=True)
        with open(_pending_path(), "w", encoding="utf-8") as fh:
            json.dump(note, fh)
    except OSError:
        pass
    new = _new_copy() if _portable() else None
    if new:
        # the new copy waits for this one to close, copies itself over it and opens it
        subprocess.Popen([os.path.join(new, "StellarHub.exe"), "--finish-update", install_dir(), str(os.getpid())],
                         cwd=new, close_fds=True, creationflags=NEW_GROUP)
        return True
    spawn_reopener()
    return True


def spawn_reopener(timeout_min=20):
    """A hidden PowerShell that waits until state.json says the installer finished, then opens StellarHub.
    It runs as the user who has the app open (not with the updater's rights)."""
    ps = (f"$f = '{_ps(state_path())}'; $exe = '{_ps(sys.executable)}'; $end = (Get-Date).AddMinutes({int(timeout_min)});"
          "do { Start-Sleep -Milliseconds 700; $s = $null;"
          " try { $s = Get-Content -Raw -LiteralPath $f -ErrorAction Stop | ConvertFrom-Json } catch {} }"
          " until (($s -and ($s.st -eq 'done' -or $s.st -eq 'failed' -or $s.st -eq 'cancelled')) -or ((Get-Date) -gt $end));"
          " Start-Sleep -Milliseconds 600; Start-Process -FilePath $exe")
    # a hidden console of its own (not DETACHED_PROCESS: PowerShell started without a console by a windowed app
    # dies right away), no inherited handles, and out of any job the app may be in, so it outlives the app
    args = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", ps]
    kw = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    try:
        subprocess.Popen(args, creationflags=NO_WINDOW | NEW_GROUP | BREAKAWAY, **kw)
    except OSError:  # the job does not allow leaving it
        subprocess.Popen(args, creationflags=NO_WINDOW | NEW_GROUP, **kw)


def _ps(s):
    return str(s).replace("'", "''")


def after_update():
    """On the first start after an update: {from, to, ok, route} once, or None."""
    p = _pending_path()
    try:
        with open(p, encoding="utf-8") as fh:
            note = json.load(fh)
    except (OSError, ValueError):
        return None
    try:
        os.remove(p)
    except OSError:
        pass
    if not isinstance(note, dict) or time.time() - float(note.get("at") or 0) > 3 * 86400:
        return None
    note["ok"] = parse_version(note.get("to")) == parse_version(VERSION)
    note["now"] = VERSION
    return note


# ---------------------------------------------------------------- the scheduled task (made by the installer)
def _task_exists():
    try:
        r = subprocess.run(["schtasks", "/query", "/tn", TASK, "/xml"], capture_output=True, timeout=10, creationflags=NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return False
    if r.returncode != 0:
        return False
    raw = r.stdout
    xml = raw.decode("utf-16", "replace") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("mbcs", "replace")
    m = re.search(r"<Command>(.*?)</Command>", xml, re.S)
    return bool(m) and os.path.normcase(m.group(1).replace("&quot;", "").strip().strip('"')) == os.path.normcase(sys.executable)


def ensure_task():
    """--update-task on (the installer, as administrator): a task that runs this StellarHub.exe --self-update with
    administrator rights for the user who installs, started on demand only (never on a schedule)."""
    r = subprocess.run(["schtasks", "/create", "/tn", TASK, "/tr", f'"{sys.executable}" --self-update', "/sc", "once",
                        "/st", "00:00", "/sd", "01/01/2000", "/rl", "highest", "/it", "/f"],
                       capture_output=True, creationflags=NO_WINDOW)
    return r.returncode == 0


def delete_task():
    subprocess.run(["schtasks", "/delete", "/tn", TASK, "/f"], capture_output=True, creationflags=NO_WINDOW)


# ---------------------------------------------------------------- the updater (--self-update)
def _write_state(**kw):
    kw["ts"] = time.time()
    os.makedirs(update_dir(), exist_ok=True)
    tmp = state_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(kw, fh)
    os.replace(tmp, state_path())


def _cancelled():
    return os.path.exists(_cancel_flag())


def _app_running():
    """Another StellarHub.exe from this folder (not this updater) is still open."""
    try:
        import psutil
    except ImportError:
        return False
    me, exe = os.getpid(), os.path.normcase(sys.executable)
    for p in psutil.process_iter(["pid", "name", "exe"]):
        try:
            if p.info["pid"] == me or (p.info["name"] or "").lower() != os.path.basename(exe).lower():
                continue
            if p.info["exe"] is None or os.path.normcase(p.info["exe"]) == exe:
                return True
        except (psutil.Error, OSError):
            continue
    return False


def _download(url, dest, size, on_progress):
    """Streams url into dest; returns the SHA-256. Stops (returns None) if the user cancels."""
    h = hashlib.sha256()
    got = 0
    req = urllib.request.Request(url, headers={"User-Agent": "StellarHub-Updater"})
    with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as fh:
        total = int(r.headers.get("Content-Length") or size or 0)
        last = 0.0
        while True:
            chunk = r.read(256 * 1024)
            if not chunk:
                break
            fh.write(chunk)
            h.update(chunk)
            got += len(chunk)
            if got > 500 * 1024 * 1024:
                raise ValueError("download too large")
            if time.monotonic() - last > .25:
                last = time.monotonic()
                if _cancelled():
                    return None
                on_progress(got, total)
        on_progress(got, total or got)
    return h.hexdigest()


def run_updater():
    """--self-update. Exit code 0 when it handed over to the installer (or there was nothing to do)."""
    d = update_dir()
    try:
        os.makedirs(d, exist_ok=True)
        for f in os.listdir(d):  # what an earlier update left behind
            if f.lower().endswith((".exe", ".part", ".log", ".zip")):
                try:
                    os.remove(os.path.join(d, f))
                except OSError:
                    pass
    except OSError:
        return 3
    if not FROZEN:
        _write_state(st="failed", why="source")
        return 2
    if per_machine() and not _admin() and not _portable():
        _write_state(st="failed", why="admin")
        return 3
    try:
        _write_state(st="checking")
        info = pick(_latest())
        if not info or not newer(info["ver"], VERSION):
            _write_state(st="uptodate", ver=VERSION)
            return 0
        ver, setup = info["ver"], info["setup"]
        part = os.path.join(d, setup["name"] + ".part")
        _write_state(st="download", ver=ver, got=0, total=setup["size"])
        digest = _download(setup["url"], part, setup["size"],
                           lambda got, total: _write_state(st="download", ver=ver, got=got, total=total))
        if digest is None:
            _write_state(st="cancelled", ver=ver)
            _rm(part)
            return 0
        _write_state(st="verify", ver=ver)
        want = re.search(r"\b([0-9a-fA-F]{64})\b", _get(info["sha_url"], 4096).decode("utf-8", "replace"))
        if not want or want.group(1).lower() != digest.lower():
            _rm(part)
            _write_state(st="failed", ver=ver, why="hash")
            return 4
        exe = os.path.join(d, setup["name"])
        os.replace(part, exe)
        portable = _portable()
        if portable:
            try:
                new = unpack_portable(exe, os.path.join(d, "new"))
            finally:
                _rm(exe)
        if portable:
            _write_state(st="ready", ver=ver, new=new)
            return 0  # the app closes and the new copy finishes the update itself (see finish and finish_update)
        _write_state(st="ready", ver=ver)
        end = time.monotonic() + 600  # the app closes as soon as it sees "ready"
        while _app_running():
            if _cancelled() or time.monotonic() > end:
                _rm(exe)
                _write_state(st="cancelled", ver=ver)
                return 0
            time.sleep(.3)
        _write_state(st="installing", ver=ver)
        args = [exe, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/NOCANCEL",
                "/LOG=" + os.path.join(d, "setup.log"), "/SELFUPDATE=" + state_path()]
        if not per_machine():
            args.append("/CURRENTUSER")
        subprocess.Popen(args, creationflags=DETACHED, close_fds=True, cwd=d)
        return 0  # and exit right away: the installer replaces this very program
    except Exception as e:
        _write_state(st="failed", why="error", error=str(e)[:200])
        return 5


def unpack_portable(zip_path, dest):
    """Unpacks the portable .zip into dest and returns the folder that holds StellarHub.exe. Refuses anything that
    would land outside dest, and a .zip without StellarHub.exe."""
    import shutil
    import zipfile
    shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(dest)
    root = os.path.realpath(dest)
    with zipfile.ZipFile(zip_path) as z:
        for n in z.namelist():
            target = os.path.realpath(os.path.join(dest, n))
            if not (target == root or target.startswith(root + os.sep)):
                raise ValueError("unsafe path in the update: " + n)
        z.extractall(dest)
    for base in (dest, *[os.path.join(dest, x) for x in os.listdir(dest)]):
        if os.path.isfile(os.path.join(base, "StellarHub.exe")):
            return base
    raise ValueError("the update has no StellarHub.exe")


def _new_copy():
    """Where the updater unpacked the new portable copy (only inside this copy's update folder)."""
    new = state().get("new") or ""
    d = os.path.realpath(update_dir())
    if new and os.path.realpath(new).startswith(d + os.sep) and os.path.isfile(os.path.join(new, "StellarHub.exe")):
        return new
    return None


def finish_update(dst, pid):
    """--finish-update <dst> <pid>, run by the NEW portable copy (unpacked in <dst>/update/new): waits for the old
    StellarHub to close, copies its own program files over the old ones (the Data folder with the settings and the
    update folder are left alone; the old files come back if something fails), then opens the updated StellarHub.
    No script and no hidden process: the updated program installs itself, as installers do."""
    import shutil
    src = install_dir()
    dst = os.path.realpath(dst)
    state_file = os.path.join(dst, "update", "state.json")
    exe = os.path.join(dst, "StellarHub.exe")

    def report(**kw):
        kw["ts"] = time.time()
        try:
            with open(state_file, "w", encoding="utf-8") as fh:
                json.dump(kw, fh)
        except OSError:
            pass
    if not os.path.isfile(exe) or not os.path.realpath(src).startswith(dst + os.sep):
        return 2  # only ever from <dst>\update\...
    try:
        import psutil
        psutil.Process(int(pid)).wait(timeout=60)
    except Exception:
        pass
    end = time.monotonic() + 30
    while time.monotonic() < end:
        try:
            with open(exe, "r+b"):
                break  # nobody holds the old program any more
        except OSError:
            time.sleep(.3)
    moved = []
    try:
        for name in os.listdir(src):
            if name.lower() in ("data", "update"):
                continue
            target = os.path.join(dst, name)
            if os.path.exists(target):
                old = target + ".old"
                if os.path.isdir(old):
                    shutil.rmtree(old, ignore_errors=True)
                elif os.path.exists(old):
                    os.remove(old)
                os.replace(target, old)
                moved.append((target, old))
            if os.path.isdir(os.path.join(src, name)):
                shutil.copytree(os.path.join(src, name), target)
            else:
                shutil.copy2(os.path.join(src, name), target)
    except Exception as e:
        for target, old in reversed(moved):  # put the old version back
            try:
                if os.path.isdir(target):
                    shutil.rmtree(target, ignore_errors=True)
                elif os.path.exists(target):
                    os.remove(target)
                os.replace(old, target)
            except OSError:
                pass
        report(st="failed", why="apply", error=str(e)[:200])
        subprocess.Popen([exe], cwd=dst, close_fds=True)
        return 5
    for _target, old in moved:
        if os.path.isdir(old):
            shutil.rmtree(old, ignore_errors=True)
        else:
            try:
                os.remove(old)
            except OSError:
                pass
    report(st="done", ver=VERSION)
    subprocess.Popen([exe], cwd=dst, close_fds=True)
    return 0


def cleanup_after_update():
    """On start: remove what a finished portable update left (the unpacked copy can't delete itself)."""
    import shutil
    d = update_dir()
    new = os.path.join(d, "new")
    if os.path.isdir(new) and state().get("st") in ("done", "failed", "cancelled", "uptodate"):
        time.sleep(4)  # the copy that finished the update is still closing
        shutil.rmtree(new, ignore_errors=True)


def _rm(p):
    try:
        os.remove(p)
    except OSError:
        pass
