"""App Hangar engine: pick apps and install them all at once with winget (like Ninite or winstall), for real.

- The curated catalog lives in the interface (ui/js/modules/hangar.js); the engine only ever gets winget ids.
- What is installed: `winget list` (read-only), matched by id and, for names without a version, by name. The
  result is kept on disk so reopening App Hangar is instant.
- Search: `winget search` (read-only), for apps that are not in the catalog.
- Icons: fetched once per package, normalized to a crisp 64 px PNG and cached on disk (<data>/hangar/icons).
  Sources, in order: the URL the catalog gives, winstall's icon API (keyed by winget id), UniGetUI's icon database
  (downloaded once, refreshed every two weeks), the icon of the installed program. Otherwise the UI draws a letter.
- Install: one package at a time, `winget install --id <id> --exact --silent ...` with the download and install
  phases read from winget's output; every result goes to the history (<data>/hangar/history.json).
- Dry run (STELLARHUB_HANGAR_DRYRUN=1, or opts.dry): a fake winget prints realistic output and installs nothing.
The winget plumbing (streaming, table parsing, return codes) is the Program Updater's, imported as is.
"""
import base64
import hashlib
import io
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from ..i18n import tr
from . import updater as U

EXPORTS = {"status", "cached", "icons_cached", "history", "history_clear", "history_restore", "export_kit", "import_kit"}
JOBS = {"scan_installed", "search", "fetch_icons", "install"}

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$")
STORE_RE = re.compile(r"^[0-9A-Z]{12}$")  # Microsoft Store product ids (9NKSQGP7F2NH)
UA = "StellarHub/0.2 (Windows app; icon cache)"
KIT_FORMAT = "stellarhub-hangar-kit"

# winget return codes App Hangar treats specially (the rest come from the Program Updater's table)
NO_APPLICABLE = "0x8A150010"      # no installer fits (also: the scope asked for isn't offered)
ALREADY = "0x8A150061"            # --no-upgrade and the package is installed
UP_TO_DATE = {"0x8A15002B", "0x8A15004F"}


# ---------------------------------------------------------------- data folder
def _data_dir():
    """Next to settings.json, like Autopilot (a copy of the settings, as tests use, gets its own folder)."""
    d = os.environ.get("STELLARHUB_HANGAR_DATA")
    if not d:
        app = sys.modules.get("stellarhub.app")
        sp = getattr(app, "SETTINGS", None) if app is not None else None
        if not sp:
            from .. import paths
            sp = paths.settings_file()
        stem = os.path.splitext(os.path.basename(sp))[0]
        d = os.path.join(os.path.dirname(sp), "hangar" if stem == "settings" else stem + "_hangar")
    os.makedirs(d, exist_ok=True)
    return d


_io_lock = threading.Lock()


def _read(name, default):
    try:
        with open(os.path.join(_data_dir(), name), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def _write(name, data):
    path = os.path.join(_data_dir(), name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(tmp, path)


def _dry(opts=None):
    return bool((opts or {}).get("dry")) or os.environ.get("STELLARHUB_HANGAR_DRYRUN") == "1"


def status():
    return {"admin": U._admin(), "winget": bool(U._exe("winget")), "dry": _dry()}


# ---------------------------------------------------------------- what is installed (read-only)
def _norm(s):
    return re.sub(r"[^a-z0-9]+", "", re.sub(r"\((x64|x86|64-bit|32-bit|64 bits|32 bits)\)", "", (s or "").lower()))


def match_installed(items, rows):
    """items: [[id, name], ...] (the catalog); rows: winget list rows. Returns the ids that are installed: by winget
    id, or by exact name when the name carries no version (a "Python 3.13" must not match Python 3.12; "7-Zip" may)."""
    ids = {(r.get("id") or "").lower() for r in rows}
    names = set()
    for r in rows:
        n = (r.get("name") or "").replace("…", "")
        names.add(_norm(re.sub(r"\s+v?\d+(\.\d+)+.*$", "", n)))  # "7-Zip 24.08 (x64)" -> 7zip
        names.add(_norm(n))
    names.discard("")
    out = []
    for it in items or []:
        wid, name = (it[0], it[1]) if isinstance(it, (list, tuple)) else (it.get("id"), it.get("name"))
        if not wid:
            continue
        versioned = re.search(r"(^|\s)v?\d+([.\-]\d+)*(\s|\)|$)", name or "")
        if wid.lower() in ids or (name and not versioned and _norm(name) in names):
            out.append(wid)
    return out


def _creep(job, text, until=.9):
    """winget list/search report no progress: creep forward slowly so it looks alive."""
    stop = threading.Event()

    def tick():
        p = .08
        while not stop.wait(.6):
            p = min(until, p + (until - p) * .08)
            job.progress(p, text)
    threading.Thread(target=tick, daemon=True).start()
    return stop


def scan_installed(job, items=None):
    """Read-only: `winget list`, matched against the catalog the UI sends ([[id, name], ...])."""
    if not U._exe("winget"):
        return {"winget": False, "installed": [], "ids": [], "ts": time.time()}
    job.progress(.05, tr("Checking what's installed…"))
    stop = _creep(job, tr("Checking what's installed…"))
    try:
        rows = U.parse_table(U._winget(["list"], timeout=240) or "")
    finally:
        stop.set()
    res = {"winget": True, "installed": match_installed(items, rows),
           "ids": sorted({r["id"].lower() for r in rows if r.get("id")}), "ts": time.time()}
    with _io_lock:
        _write("installed.json", res)
    return res


def cached():
    """Last known state, instantly (the UI then refreshes in the background when it's old)."""
    return {"installed": _read("installed.json", None), "status": status()}


# ---------------------------------------------------------------- winget search (read-only)
def search_rows(text):
    """winget search table to rows. Columns are Name, Id, Version, [Match], [Source] in every language, so they are
    taken by position (parse_table keeps the header order) instead of by header name."""
    out = []
    for d in U.parse_table(text):
        vals = list(d.values())
        if len(vals) < 2:
            continue
        name, wid = vals[0], vals[1]
        ver = vals[2] if len(vals) > 2 else ""
        src = vals[-1].lower() if len(vals) > 3 and vals[-1].lower() in ("winget", "msstore") else ("msstore" if STORE_RE.match(wid) else "winget")
        if not ID_RE.match(wid or ""):
            continue
        out.append({"id": wid, "name": name.replace("…", "").strip(),
                    "version": "" if ver.lower() in ("unknown", "desconocido") else ver, "source": src})
    return out


def search(job, query, limit=40):
    q = re.sub(r"\s+", " ", str(query or "")).strip()[:60]
    if len(q) < 2:
        return {"q": q, "items": []}
    if not U._exe("winget"):
        return {"q": q, "items": [], "winget": False}
    job.progress(.05, tr("Searching winget…"))
    stop = _creep(job, tr("Searching winget…"))
    try:
        out = U._winget(["search", "--query", q], timeout=120) or ""
    finally:
        stop.set()
    job.check()
    inst = set((_read("installed.json", {}) or {}).get("ids") or [])
    seen, items = set(), []
    for r in search_rows(out):
        if r["id"].lower() in seen:
            continue
        seen.add(r["id"].lower())
        r["installed"] = r["id"].lower() in inst
        items.append(r)
    return {"q": q, "items": items[:limit], "more": max(0, len(items) - limit)}


# ---------------------------------------------------------------- icons (fetched once, cached on disk)
def _icon_dir():
    d = os.path.join(_data_dir(), "icons")
    os.makedirs(d, exist_ok=True)
    return d


def _icon_file(wid):
    return os.path.join(_icon_dir(), re.sub(r"[^A-Za-z0-9._+\-]", "_", wid))


def _cached_icon(wid):
    base = _icon_file(wid)
    for ext, mime in ((".png", "image/png"), (".svg", "image/svg+xml")):
        try:
            with open(base + ext, "rb") as fh:
                return f"data:{mime};base64," + base64.b64encode(fh.read()).decode()
        except OSError:
            pass
    return None


def icons_cached(ids):
    """{id: data URI} for the icons already on disk (fast: no network)."""
    out = {}
    for wid in ids or []:
        if isinstance(wid, str) and ID_RE.match(wid):
            u = _cached_icon(wid)
            if u:
                out[wid] = u
    return out


def normalize_icon(data, size=64):
    """Any raster icon to a square PNG of `size` px: transparent margins trimmed, centred, and dark flat logos
    (black marks that would vanish on the navy tile) put on a light rounded plate. None if empty or unreadable.
    (Pillow opens an .ico at its largest size.)"""
    from PIL import Image, ImageDraw
    im = Image.open(io.BytesIO(data))
    im.load()
    im = im.convert("RGBA")
    bb = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if not bb:
        return None
    im = im.crop(bb)
    w, h = im.size
    s = max(w, h)
    sq = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    sq.paste(im, ((s - w) // 2, (s - h) // 2))
    small = sq.resize((32, 32))
    px = [p for p in (small.getpixel((x, y)) for y in range(32) for x in range(32)) if p[3] > 128]
    if not px:
        return None
    lum = sum(.2126 * r + .7152 * g + .0722 * b for r, g, b, _ in px) / len(px) / 255
    sat = sum(max(r, g, b) - min(r, g, b) for r, g, b, _ in px) / len(px) / 255
    sq = sq.resize((size, size), Image.LANCZOS)
    if lum < .22 and sat < .18:
        plate = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(plate).rounded_rectangle((0, 0, size - 1, size - 1), radius=size // 4, fill=(236, 240, 247, 255))
        inner = sq.resize((int(size * .72),) * 2, Image.LANCZOS)
        plate.paste(inner, ((size - inner.width) // 2,) * 2, inner)
        sq = plate
    buf = io.BytesIO()
    sq.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _get(url, limit=3 * 1024 * 1024, timeout=10):
    if not str(url).startswith("https://"):
        raise ValueError("https only")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ValueError("too big")
    return data


def _wiki_size(url):
    """Wikimedia only serves its standard thumbnail widths: 293px-… is refused, 250px-… works."""
    return re.sub(r"(/thumb/.+?/)(?:lang[a-z]+-)?\d+px-", r"\g<1>250px-", url) if "upload.wikimedia.org" in url else url


_udb = {"map": None}
_udb_lock = threading.Lock()
UDB_URL = "https://raw.githubusercontent.com/marticliment/UniGetUI/main/WebBasedData/screenshot-database-v2.json"


def _unigetui_db():
    """UniGetUI's community icon database ({key: icon url}), downloaded once and refreshed every two weeks."""
    with _udb_lock:
        if _udb["map"] is not None:
            return _udb["map"]
        path = os.path.join(_data_dir(), "unigetui-icons.json")
        if not (os.path.exists(path) and time.time() - os.path.getmtime(path) < 14 * 86400):
            try:
                data = _get(UDB_URL, limit=20 * 1024 * 1024, timeout=20)
                json.loads(data)
                with open(path, "wb") as fh:
                    fh.write(data)
            except Exception:
                pass
        try:
            with open(path, encoding="utf-8") as fh:
                raw = json.load(fh).get("icons_and_screenshots") or {}
            _udb["map"] = {k: v.get("icon") for k, v in raw.items() if isinstance(v, dict) and v.get("icon")}
        except (OSError, ValueError, AttributeError):
            _udb["map"] = {}
        return _udb["map"]


def udb_keys(wid, name=""):
    """Keys UniGetUI uses for a winget package (the id without the publisher, dots to dashes), then name forms."""
    parts = wid.split(".")
    ks = ["-".join(parts[1:]).lower(), parts[-1].lower(), wid.lower()]
    if name:
        n = name.lower()
        ks += [n.replace(" ", "-"), n.replace(" ", ""), re.sub(r"[^a-z0-9]", "", n)]
    out = []
    for k in ks:
        if k and k not in out:
            out.append(k)
    return out


def _sources(it):
    wid = it["id"]
    if it.get("icon"):
        yield _wiki_size(it["icon"])
    if not STORE_RE.match(wid):
        yield f"https://api.winstall.app/icons/next/{urllib.parse.quote(wid)}.webp"
    db = _unigetui_db()
    for k in udb_keys(wid, it.get("name") or ""):
        if db.get(k):
            yield _wiki_size(db[k])
            break


def _save_png(wid, png):
    with open(_icon_file(wid) + ".png", "wb") as fh:
        fh.write(png)
    return "data:image/png;base64," + base64.b64encode(png).decode()


def _fetch_one(it):
    """A data URI or None. Tries each source; the installed program's own icon is the last resort."""
    wid = it["id"]
    for url in _sources(it):
        try:
            raw = _get(url)
        except Exception:
            continue
        head = raw[:200].lstrip().lower()
        if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in raw[:2000].lower()):
            with open(_icon_file(wid) + ".svg", "wb") as fh:  # shown through <img>: scripts in it never run
                fh.write(raw)
            return "data:image/svg+xml;base64," + base64.b64encode(raw).decode()
        try:
            png = normalize_icon(raw)
        except Exception:
            png = None
        if png:
            return _save_png(wid, png)
    if it.get("name"):
        try:
            local = U.icon_for(it["name"])  # data:image/png;base64,… from the installed program
            if local and local.startswith("data:image/png;base64,"):
                png = normalize_icon(base64.b64decode(local.split(",", 1)[1]))
                if png:
                    return _save_png(wid, png)
        except Exception:
            pass
    return None


def fetch_icons(job, items):
    """items: [{id, name, icon?}]. Downloads the icons that aren't cached yet (a miss is retried after 3 days).
    Sends them in small batches as data.icons so they appear while the rest load; the result has them all."""
    items = [it for it in (items or []) if isinstance(it, dict) and ID_RE.match(str(it.get("id") or ""))]
    misses = _read("icon-misses.json", {})
    if not isinstance(misses, dict):
        misses = {}
    todo = [it for it in items if not _cached_icon(it["id"]) and time.time() - misses.get(it["id"], 0) > 3 * 86400]
    got, batch, lock = {}, {}, threading.Lock()
    done, last = [0], [time.monotonic()]

    def one(it):
        if job.cancelled:
            return
        try:
            u = _fetch_one(it)
        except Exception:
            u = None
        with lock:
            done[0] += 1
            if u:
                got[it["id"]] = batch[it["id"]] = u
                misses.pop(it["id"], None)
            else:
                misses[it["id"]] = time.time()
            if batch and (len(batch) >= 8 or time.monotonic() - last[0] > .35):
                job.progress(done[0] / max(1, len(todo)), tr("Getting app icons…"), force=True, icons=dict(batch))
                batch.clear()
                last[0] = time.monotonic()
    if todo:
        job.progress(0, tr("Getting app icons…"))
        with ThreadPoolExecutor(8) as ex:
            list(ex.map(one, todo))
        with _io_lock:
            _write("icon-misses.json", misses)
    return {"icons": got, "missing": [it["id"] for it in todo if it["id"] not in got]}


# ---------------------------------------------------------------- install (changes the system: only from the UI)
def _fake_winget(cmd, on_text=None, job=None, timeout=None):
    """Dry run: prints what winget would (download bar, hash check, install) and installs nothing.
    STELLARHUB_HANGAR_DRYRUN_FAIL=<id,id>: those fail as "the program is open";
    STELLARHUB_HANGAR_DRYRUN_NOSCOPE=<id,id>: those offer no installer for the scope asked for;
    STELLARHUB_HANGAR_DRYRUN_SPEED: >1 runs faster (tests)."""
    wid = cmd[cmd.index("--id") + 1] if "--id" in cmd else "?"
    env = lambda k: {x.strip().lower() for x in os.environ.get(k, "").split(",") if x.strip()}
    fails, noscope = env("STELLARHUB_HANGAR_DRYRUN_FAIL"), env("STELLARHUB_HANGAR_DRYRUN_NOSCOPE")
    speed = max(.1, float(os.environ.get("STELLARHUB_HANGAR_DRYRUN_SPEED", "1") or 1))
    out = []

    def say(s):
        out.append(s)
        if on_text:
            on_text(s)

    def nap(sec):
        end = time.monotonic() + sec / speed
        while time.monotonic() < end:
            if job is not None and job.cancelled:
                return False
            time.sleep(.02)
        return True
    h = int(hashlib.sha1(wid.encode()).hexdigest()[:6], 16)
    say(f"Found {wid} [{wid}] Version {1 + h % 9}.{h % 30}.{h % 7}")
    if "--scope" in cmd and wid.lower() in noscope:
        say("No applicable installer found; see logs for more details.")
        return 0x8A150010, "\n".join(out)
    if "--no-upgrade" in cmd and wid.lower() in {x.lower() for x in (_read("installed.json", {}) or {}).get("installed") or []}:
        say("Found an existing package already installed. Not upgrading because --no-upgrade was given.")
        return 0x8A150061, "\n".join(out)
    say("This application is licensed to you by its owner.")
    say(f"Downloading https://example.invalid/dry-run/{wid}.exe")
    total, steps = 4 + h % 140, 24
    for i in range(1, steps + 1):
        if not nap(.07 + total / 4000):
            return None, "\n".join(out)
        k = int(30 * i / steps)
        say(f"  {'█' * k}{'▒' * (30 - k)}  {total * i / steps:.1f} MB / {total:.1f} MB")
    say("Successfully verified installer hash")
    say("Starting package install...")
    if not nap(.8 + (h % 10) / 10):
        return None, "\n".join(out)
    if wid.lower() in fails:
        say("Installer failed with exit code: 1603")
        return 0x8A150101, "\n".join(out)
    say("Successfully installed")
    return 0, "\n".join(out)


RUNNER = None  # tests put a fake runner here (same signature as updater._stream)


def _runner(opts):
    if RUNNER is not None:
        return RUNNER
    return _fake_winget if _dry(opts) else U._stream


def _hexc(code):
    return f"0x{code & 0xFFFFFFFF:08X}" if isinstance(code, int) else "?"


def install_command(it, opts, scope=True):
    wid = it["id"]
    src = it.get("source") if it.get("source") in ("winget", "msstore") else ("msstore" if STORE_RE.match(wid) else "winget")
    cmd = [U._exe("winget") or "winget", "install", "--id", wid, "--exact", "--source", src, "--silent",
           "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"]
    if opts.get("skipInstalled", True):
        cmd.append("--no-upgrade")
    if scope and opts.get("scope") in ("user", "machine") and src == "winget":  # Store apps are always per user
        cmd += ["--scope", opts["scope"]]
    return cmd


def _install_one(job, it, opts, report):
    """(state, message, extra) with state: done | skip | fail | cancel."""
    state = {"phase": "down", "mb": None, "note": None}

    def on_text(s):
        m = re.search(r"([\d.,]+)\s*(KB|MB|GB)\s*/\s*([\d.,]+)\s*(KB|MB|GB)", s)
        if m:
            got = float(m.group(1).replace(",", ".")) * U._SIZE[m.group(2)]
            tot = float(m.group(3).replace(",", ".")) * U._SIZE[m.group(4)]
            state["mb"], state["p"] = tot, (got / tot if tot else 0)
            report("down", state["p"], mb=tot)
            return
        m = re.search(r"(\d{1,3})\s*%", s)
        if m and state["phase"] == "down":
            state["p"] = int(m.group(1)) / 100
            report("down", state["p"], mb=state["mb"])
            return
        low = s.lower()
        # progress words in the languages winget prints (it follows the Windows display language)
        if any(w in low for w in ("starting package install", "iniciando la instalación", "iniciando a instalação",
                                  "démarrage de l'installation", "avvio dell'installazione", "开始安装", "installing", "instalando")):
            state["phase"] = "inst"
            report("inst", 1, mb=state["mb"])
        job.log(s)

    def on_tick(elapsed, quiet):
        # say what is really going on when nothing moves: Windows waiting for the user's permission (its prompt
        # may sit flashing in the taskbar), or a download or installer that has gone quiet
        note = "uac" if quiet > 2 and U.consent_prompt_open() else ("quiet" if quiet > 90 else None)
        if note != state["note"]:
            state["note"] = note
            report(state["phase"], 1 if state["phase"] == "inst" else state.get("p", 0), mb=state["mb"], note=note, quiet=quiet)

    run = _runner(opts)
    kw = {"on_tick": on_tick} if run is U._stream else {}
    cmd = install_command(it, opts)
    code, out = run(cmd, on_text, job=job, timeout=3600, **kw)
    note = None
    if not job.cancelled and "--scope" in cmd and _hexc(code) == NO_APPLICABLE:
        # no installer for that scope: install it the only way the package offers
        job.log("No installer for the scope asked for; trying the package's default scope.")
        state["phase"] = "down"
        report("down", 0)
        note = tr("This app only installs for all users.") if opts.get("scope") == "user" else tr("This app only installs for your account.")
        code, out = run(install_command(it, opts, scope=False), on_text, job=job, timeout=3600, **kw)
    if job.cancelled:
        return "cancel", tr("Cancelled"), {}
    hexc = _hexc(code)
    extra = {"mb": state["mb"]}
    # success text in English and Spanish (as the Program Updater reads it)
    if code == 0 or re.search(r"Successfully installed|Instalado correctamente|se instaló correctamente", out or "", re.I):
        return "done", note, extra
    if hexc in U.WINGET_REBOOT_OK:
        extra["reboot"] = True
        return "done", tr("Installed. Restart the PC to finish."), extra
    if hexc == ALREADY:
        return "skip", tr("Already installed"), extra
    if hexc in UP_TO_DATE:
        return "skip", tr("Already installed and up to date"), extra
    if hexc in U.WINGET_CODES:
        return "fail", tr(U.WINGET_CODES[hexc]), extra
    tail = ([ln for ln in (out or "").splitlines() if ln.strip()][-1:] or [""])[0].strip()
    return "fail", tr("The installer returned {code}.", code=hexc) + (" " + tail[:120] if tail else ""), extra


def install(job, items, opts=None):
    """Installs packages one after another. items: [{id, name, source?}];
    opts: {scope: user|machine|'', skipInstalled: bool, run: <id grouping a batch in the history>, dry: bool}.
    Progress: data.items[i] = {st, p, mb, msg}."""
    opts = dict(opts or {})
    items = [it for it in (items or []) if isinstance(it, dict) and ID_RE.match(str(it.get("id") or ""))]
    states = [{"st": "queued", "p": 0, "mb": None, "msg": None, "note": None} for _ in items]
    job.data["items"] = states
    reboot = False
    run_id = str(opts.get("run") or int(time.time() * 1000))[:40]
    dry = _dry(opts) or RUNNER is not None
    for i, it in enumerate(items):
        if job.cancelled:
            for s in states[i:]:
                s["st"] = "cancel"
            break
        cur = states[i]

        def report(phase, p, mb=None, note=False, quiet=None, cur=cur, i=i, it=it):
            cur["st"], cur["p"] = phase, max(0, min(1, p))
            if note is not False:  # None clears it
                cur["note"], cur["quiet"] = note, round(quiet or 0)
            if mb:
                cur["mb"] = round(mb, 1)
            done = sum(1 for s in states if s["st"] in ("done", "skip", "fail", "cancel"))
            job.progress((done + (cur["p"] * .8 if phase == "down" else .9)) / len(states), it.get("name") or it["id"], cur=i, items=states)
        report("down", 0)
        try:
            st, msg, extra = _install_one(job, it, opts, report)
        except Exception as e:
            st, msg, extra = "fail", str(e)[:160], {}
        cur["st"], cur["msg"], cur["note"] = st, msg, None
        if extra.get("mb"):
            cur["mb"] = round(extra["mb"], 1)
        if st == "done":
            cur["p"] = 1
        reboot = reboot or bool(extra.get("reboot"))
        if st != "cancel":
            _history_add(run_id, {"id": it["id"], "name": str(it.get("name") or it["id"])[:80], "source": it.get("source") or "",
                                  "st": st, "msg": msg, "at": time.time()}, {"scope": opts.get("scope") or "", "dry": dry})
        job.progress(sum(1 for s in states if s["st"] in ("done", "skip", "fail", "cancel")) / len(states),
                     it.get("name") or it["id"], force=True, cur=i, items=states)
    ok = [it["id"] for it, s in zip(items, states) if s["st"] in ("done", "skip")]
    if ok and not dry:
        _mark_installed(ok)
    return {"items": states, "reboot": reboot, "dry": dry}


def _mark_installed(ids):
    with _io_lock:
        cur = _read("installed.json", None)
        if not isinstance(cur, dict):
            return
        cur["installed"] = sorted(set(cur.get("installed") or []) | set(ids))
        cur["ids"] = sorted(set(cur.get("ids") or []) | {i.lower() for i in ids})
        _write("installed.json", cur)


# ---------------------------------------------------------------- history
MAX_RUNS = 60


def _history_add(run_id, entry, meta):
    with _io_lock:
        runs = _read("history.json", [])
        if not isinstance(runs, list):
            runs = []
        run = next((r for r in runs if isinstance(r, dict) and r.get("run") == run_id), None)
        if run is None:
            run = {"run": run_id, "at": entry["at"], "items": [], **meta}
            runs.insert(0, run)
        run["items"] = [x for x in run.get("items") or [] if x.get("id") != entry["id"]] + [entry]
        run["end"] = entry["at"]
        _write("history.json", runs[:MAX_RUNS])


def history():
    runs = _read("history.json", [])
    return [r for r in runs if isinstance(r, dict)] if isinstance(runs, list) else []


def history_clear():
    """Empties the history and returns what it had (so the UI can undo)."""
    with _io_lock:
        old = history()
        _write("history.json", [])
    return old


def history_restore(runs):
    if not isinstance(runs, list):
        return False
    with _io_lock:
        _write("history.json", [r for r in runs if isinstance(r, dict)][:MAX_RUNS])
    return True


# ---------------------------------------------------------------- kits as files
def clean_kit(data):
    """A kit file (or a plain list of ids) to {name, apps: [{id, name, source}]}; None if it isn't one."""
    if isinstance(data, list):
        data = {"apps": data}
    if not isinstance(data, dict):
        return None
    apps, seen = [], set()
    for a in data.get("apps") or []:
        if isinstance(a, str):
            a = {"id": a}
        if not isinstance(a, dict):
            continue
        wid = str(a.get("id") or "").strip()
        if not ID_RE.match(wid) or wid.lower() in seen:
            continue
        seen.add(wid.lower())
        src = str(a.get("source") or "").lower()
        apps.append({"id": wid, "name": str(a.get("name") or wid)[:80],
                     "source": src if src in ("winget", "msstore") else ("msstore" if STORE_RE.match(wid) else "winget")})
        if len(apps) >= 300:
            break
    if not apps:
        return None
    return {"name": re.sub(r"\s+", " ", str(data.get("name") or "")).strip()[:60], "apps": apps}


def _window():
    import webview
    return webview.windows[0], webview


def export_kit(kit):
    """Save dialog, then writes the kit as JSON. {path}, None if the user cancelled, or {error}."""
    k = clean_kit(kit)
    if not k:
        return {"error": tr("The kit is empty.")}
    try:
        w, webview = _window()
        safe = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "", k["name"] or "App Hangar kit").strip() or "App Hangar kit"
        r = w.create_file_dialog(webview.SAVE_DIALOG, save_filename=f"{safe}.json", file_types=(tr("App Hangar kit") + " (*.json)",))
    except Exception:
        return None
    if not r:
        return None
    path = r if isinstance(r, str) else r[0]
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"format": KIT_FORMAT, "version": 1, "name": k["name"], "created": time.strftime("%Y-%m-%d"),
                   "apps": k["apps"]}, fh, ensure_ascii=False, indent=2)
    return {"path": path}


def import_kit():
    """Open dialog, then reads a kit file. The kit, None if cancelled, or {error}."""
    try:
        w, webview = _window()
        r = w.create_file_dialog(webview.OPEN_DIALOG, file_types=(tr("App Hangar kit") + " (*.json)",))
    except Exception:
        return None
    if not r:
        return None
    try:
        with open(r[0] if isinstance(r, (list, tuple)) else r, encoding="utf-8") as fh:
            k = clean_kit(json.load(fh))
    except (OSError, ValueError):
        k = None
    return k or {"error": tr("That file isn't an App Hangar kit.")}
