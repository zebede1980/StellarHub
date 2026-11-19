"""Games: the frame rate of whatever is being played, measured by Intel PresentMon (MIT, not bundled).

PresentMon listens to Windows' event tracing (ETW) for every frame a process presents; nothing is injected into the
game. It runs as a child process (--output_stdout) and this module turns its CSV rows into:
  - frame rate: average, slowest and fastest second, 1 % and 0.1 % lows (the average of the slowest frames);
  - hitches: single frames several times longer than the ones around them;
  - dips: several seconds in a row well below the run's usual frame rate;
  - pauses: frames of a second or more (loading screens, alt-tab), listed but kept out of the statistics;
  - what limits the frame rate (graphics card, processor or a frame cap), from how long the GPU was busy in each
    frame plus the telemetry samples taken meanwhile.

Column names changed between PresentMon versions (FrameTime, CPUBusy... then MsCPUBusy...), so columns are found by
name, with or without the "Ms" prefix. Anything missing or "NA" is None: no number is made up.

For the Games module, Monitor keeps PresentMon running and decides what the game is: the program in front that
covers its whole screen for a few seconds, or one the user picked. When that program closes, its run is saved
to games.json as a session. Everything PresentMon measures is kept in memory only until then.

Try it without the app:  python -m stellarhub.engine.games [--process game.exe] [--seconds 60] [--csv saved.csv]
"""
import csv
import ctypes
import glob
import json
import math
import os
import shutil
import statistics
import subprocess
import sys
import threading
import time
from array import array
from collections import deque, namedtuple
from ctypes import wintypes

import psutil

EXPORTS = {"status", "start", "stop", "live", "track", "history", "save_session", "delete_session", "clear_history"}

DATA_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "StellarHub")
HISTORY = os.path.join(DATA_DIR, "games.json")
MAX_SESSIONS = 200
RELEASES = "https://github.com/GameTechDev/PresentMon/releases"

NO_WINDOW = 0x08000000
UNKNOWN = "<unknown>"  # PresentMon without administrator rights cannot name another account's processes (dwm.exe)
SESSION = "StellarHubGames"  # the ETW session name: PresentMon's own app keeps the default one

PAUSE_MS = 1000.0     # a frame this long is a loading screen or an alt-tab, not a slow frame
HITCH_RATIO = 2.5     # a frame this many times longer than the recent median...
HITCH_MIN_MS = 8.0    # ...and at least this much longer, is a hitch
HITCH_WINDOW = 120    # frames the median is taken over
HITCH_REFRESH = 30    # frames between two medians
HITCH_GAP_S = 1.0     # hitches closer than this are one event
DIP_RATIO = 0.7       # a second below this share of the usual frame rate...
DIP_MIN_S = 3         # ...for this many seconds in a row, is a dip
MAX_EVENTS = 500
RECENT_FRAMES = 20000  # frames the live 1 % low is taken over (a few minutes): sorting a whole evening is too slow
GPU_WINDOW = 600      # frames the live GPU share is taken over
SERIES_MAX = 600      # points of the frame-rate chart kept with a session

GAME_AFTER_S = 3      # in front and covering its whole screen for this many seconds in a row: it is a game
SESSION_MIN_S = 60    # shorter runs are not saved
GONE_AFTER_S = 15     # no frames for this long and the process is gone: the session is over
TELE_EVERY_S = 2      # seconds between two telemetry samples while a game is being measured
STALE_AFTER_S = 600   # runs of other programs with no frames for this long are forgotten

# Thresholds for diagnose(). First guesses: they still need checking against real games.
GPU_BOUND = 0.92      # GPU busy for this share of every frame: it is the limit
GPU_IDLE = 0.75       # below this the GPU is waiting for something else
CPU_PEGGED = 0.9      # the busiest thread at this load: the processor is the limit
VRAM_FULL = 0.95

# They present frames all the time and are never the game (msedgewebview2 is this app's own window).
IGNORED = {"dwm.exe", "explorer.exe", "msedgewebview2.exe", "searchhost.exe", "startmenuexperiencehost.exe",
           "shellexperiencehost.exe", "textinputhost.exe", "applicationframehost.exe", "lockapp.exe"}

Frame = namedtuple("Frame", "app pid chain ms gpu")


# ---------------------------------------------------------------- PresentMon's CSV
def _norm(name):
    n = name.strip().lower()
    return n[2:] if n.startswith("ms") else n


def _num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


class Parser:
    """CSV lines -> Frame. The first line with an Application column is the header; lines before it are skipped."""

    def __init__(self):
        self.cols = None

    def feed(self, line):
        row = next(csv.reader([line]), None)
        if not row:
            return None
        if self.cols is None:
            cols = {_norm(c): i for i, c in enumerate(row)}
            if "application" in cols:
                self.cols = cols
            return None

        def get(key):
            i = self.cols.get(key)
            return row[i] if i is not None and i < len(row) else None

        # frame time: from one frame's CPU start to the next (2.x), or between two Present() calls (1.x)
        ms = _num(get("frametime"))
        if ms is None:
            busy, wait = _num(get("cpubusy")), _num(get("cpuwait"))
            ms = busy + wait if busy is not None and wait is not None else None
        if ms is None:
            ms = _num(get("betweenappstart"))
        if ms is None:
            ms = _num(get("betweenpresents"))
        app = get("application")
        if not app or ms is None or ms <= 0:
            return None
        pid = _num(get("processid"))
        return Frame(app, int(pid) if pid is not None else 0, get("swapchainaddress") or "", ms, _num(get("gpubusy")))


# ---------------------------------------------------------------- statistics
def low(worst_first, share):
    """Frame rate of the slowest `share` of the frames (0.01 = the 1 % low)."""
    n = max(1, math.ceil(len(worst_first) * share))
    return 1000 * n / sum(worst_first[:n])


def dips(secs, at):
    """Runs of DIP_MIN_S or more seconds below DIP_RATIO of the median second."""
    if len(secs) < DIP_MIN_S * 2:
        return []
    floor = statistics.median(secs) * DIP_RATIO
    out, start = [], None
    for i in range(len(secs) + 1):
        if i < len(secs) and secs[i] < floor:
            start = i if start is None else start
        elif start is not None:
            if i - start >= DIP_MIN_S:
                out.append({"kind": "dip", "at": round(at[start], 1), "seconds": i - start,
                            "fps": round(min(secs[start:i]), 1)})
            start = None
    return out


def thin(values, most):
    """(values, step): at most `most` of them, each the average of `step` neighbours."""
    step = max(1, math.ceil(len(values) / most))
    if step == 1:
        return [round(v, 1) for v in values], 1
    return [round(sum(values[i:i + step]) / len(values[i:i + step]), 1) for i in range(0, len(values), step)], step


def _event(e):
    return {"kind": e["kind"], "at": round(e["at"], 1), "seconds": round(e["end"] - e["at"], 2),
            "frames": e["frames"], "worst": round(e["worst"], 1)}


class Run:
    """Everything measured for one swap chain of one process."""

    def __init__(self, app, pid):
        self.app, self.pid = app, pid
        self.ms = array("f")      # every frame time: 4 bytes a frame, about 2 MB an hour at 144 fps
        self.t = 0.0              # seconds since the first frame, pauses included
        self.secs = array("f")    # frame rate of each second of rendering
        self.sec_at = array("f")  # when each of those seconds started
        self.gpu_ms = 0.0         # time the GPU was busy...
        self.gpu_of = 0.0         # ...out of this much frame time
        self.events = []
        self.dropped = 0          # events beyond MAX_EVENTS
        self.seen = time.monotonic()  # when the last frame arrived
        self._sum = 0.0
        self._recent = deque(maxlen=HITCH_WINDOW)
        self._gpu = deque(maxlen=GPU_WINDOW)  # (GPU busy, frame time) of the last frames
        self._median = None
        self._since = 0
        self._n, self._acc, self._acc_at = 0, 0.0, 0.0

    def add(self, ms, gpu=None):
        at = self.t
        self.t += ms / 1000
        self.seen = time.monotonic()
        if ms >= PAUSE_MS:
            self._mark("pause", at, ms)
            self._recent.clear()
            self._median, self._since = None, 0
            return
        self.ms.append(ms)
        self._sum += ms
        if gpu is not None:
            self.gpu_ms += min(gpu, ms)
            self.gpu_of += ms
            self._gpu.append((min(gpu, ms), ms))
        if not self._n:
            self._acc_at = at
        self._n += 1
        self._acc += ms
        if self._acc >= 1000:
            self.secs.append(self._n * 1000 / self._acc)
            self.sec_at.append(self._acc_at)
            self._n, self._acc = 0, 0.0
        med = self._median
        if med and ms >= med * HITCH_RATIO and ms - med >= HITCH_MIN_MS:
            self._mark("hitch", at, ms)
        self._recent.append(ms)
        self._since += 1
        if self._since >= HITCH_REFRESH:
            self._median, self._since = statistics.median(self._recent), 0

    def _mark(self, kind, at, ms):
        last = self.events[-1] if self.events else None
        if kind == "hitch" and last and last["kind"] == "hitch" and at - last["end"] <= HITCH_GAP_S:
            last.update(end=self.t, frames=last["frames"] + 1, worst=max(last["worst"], ms))
        elif len(self.events) < MAX_EVENTS:
            self.events.append({"kind": kind, "at": at, "end": self.t, "frames": 1, "worst": ms})
        else:
            self.dropped += 1

    def now(self):
        """Frame rate of the last whole second, or None in the first second."""
        return round(self.secs[-1], 1) if self.secs else None

    def live(self):
        """The numbers for a screen that refreshes every second: nothing here looks at every frame of the run.
        low1 and gpuNow cover the last minutes only; summary() has them for the whole run."""
        n = len(self.ms)
        if not n:
            return None
        gpu_of = sum(ms for _, ms in self._gpu)
        return {
            "app": self.app, "pid": self.pid, "frames": n, "seconds": round(self.t, 1),
            "now": self.now(), "fps": round(1000 * n / self._sum, 1),
            "min": round(min(self.secs), 1) if self.secs else None,
            "max": round(max(self.secs), 1) if self.secs else None,
            "low1": round(low(sorted(self.ms[-RECENT_FRAMES:], reverse=True), 0.01), 1),
            "ms": round(statistics.median(self._recent), 1) if self._recent else None,
            "gpuNow": round(sum(g for g, _ in self._gpu) / gpu_of, 3) if gpu_of else None,
            "series": [round(v, 1) for v in self.secs[-180:]],
            "events": [_event(e) for e in self.events[-8:]],
        }

    def summary(self):
        n = len(self.ms)
        if not n:
            return None
        worst = sorted(self.ms, reverse=True)
        series, step = thin(self.secs, SERIES_MAX)
        return {
            "app": self.app, "pid": self.pid, "frames": n, "seconds": round(self.t, 1),
            "fps": round(1000 * n / self._sum, 1),
            "min": round(min(self.secs), 1) if self.secs else None,
            "max": round(max(self.secs), 1) if self.secs else None,
            "low1": round(low(worst, 0.01), 1), "low01": round(low(worst, 0.001), 1),
            "worstMs": round(worst[0], 1),
            "gpuBusy": round(self.gpu_ms / self.gpu_of, 3) if self.gpu_of else None,
            "events": sorted([_event(e) for e in self.events] + dips(self.secs, self.sec_at), key=lambda e: e["at"]),
            "eventsDropped": self.dropped,
            "series": series, "seriesStep": step,
        }


def diagnose(fps, gpu_busy, tele=(), target=60):
    """What limits the frame rate. gpu_busy: share of each frame the GPU was working (Run.summary()['gpuBusy']);
    tele: telemetry samples taken during the run (telemetry.Sampler.sample()); target: the frame rate wanted.

    limit: 'gpu', 'cpu', 'cap' (neither is busy: a frame limiter or vsync), 'other' (the GPU is busy, but not
    with this game: another program has it) or None (in between, or unknown).
    tooHigh: the GPU is the limit and the frame rate is under the target: the settings ask too much of it."""
    def avg(values):
        values = [v for v in values if v is not None]
        return sum(values) / len(values) if values else None

    usage = avg(s.get("gpu") for s in tele)  # of the whole card, every program together: what Task Manager shows
    usage = usage / 100 if usage is not None else None
    gpu = gpu_busy if gpu_busy is not None else usage  # no per-frame GPU time with an old PresentMon
    thread = avg(max(s["threads"]) for s in tele if s.get("threads"))
    vram = max((s["vram"] / s["vramTotal"] for s in tele if s.get("vram") and s.get("vramTotal")), default=None)
    limit = None
    if gpu is not None and gpu >= GPU_BOUND:
        limit = "gpu"
    elif gpu is not None and gpu < GPU_IDLE and usage is not None and usage >= GPU_BOUND:
        limit = "other"
    elif gpu is not None and gpu < GPU_IDLE and thread is not None:
        limit = "cpu" if thread >= CPU_PEGGED else "cap"
    return {"limit": limit, "tooHigh": limit == "gpu" and fps < target,
            "vramFull": vram is not None and vram >= VRAM_FULL,
            "gpu": round(gpu, 3) if gpu is not None else None,
            "gpuAll": round(usage, 3) if usage is not None else None,
            "thread": round(thread, 3) if thread is not None else None,
            "vram": round(vram, 3) if vram is not None else None}


def process_name(pid):
    try:
        return psutil.Process(pid).name()
    except (psutil.Error, OSError, ValueError):
        return UNKNOWN


class Tracker:
    """Frames from every process, sorted into runs. Safe to feed from one thread and read from another."""

    def __init__(self):
        self.runs = {}
        self._names = {}
        self._lock = threading.Lock()

    def add(self, f):
        app = f.app
        if app == UNKNOWN:
            app = self._names.get(f.pid)
            if app is None:
                app = self._names[f.pid] = process_name(f.pid)
        if app.lower() in IGNORED:
            return
        with self._lock:
            run = self.runs.get((f.pid, f.chain))
            if run is None:
                run = self.runs[(f.pid, f.chain)] = Run(app, f.pid)
            run.add(f.ms, f.gpu)

    def busiest(self):
        """The run with the most frames: the game, unless something else is drawing more."""
        with self._lock:
            return max(self.runs.values(), key=lambda r: len(r.ms), default=None)

    def summary(self):
        run = self.busiest()
        with self._lock:
            return run.summary() if run else None

    def _of(self, pid):
        return max((r for r in self.runs.values() if r.pid == pid), key=lambda r: len(r.ms), default=None)

    def seen(self, pid):
        """When the last frame of this process arrived (time.monotonic()), or None if it never drew anything."""
        with self._lock:
            run = self._of(pid)
            return run.seen if run else None

    def live(self, pid):
        with self._lock:
            run = self._of(pid)
            return run.live() if run else None

    def take(self, pid):
        """The summary of this process' run, which is then forgotten."""
        with self._lock:
            run = self._of(pid)
            for key in [k for k, r in self.runs.items() if r.pid == pid]:
                del self.runs[key]
            return run.summary() if run else None

    def others(self, since, skip=None):
        """What else drew something after `since`, fastest first: the programs the user can pick by hand."""
        with self._lock:
            found = {}
            for r in self.runs.values():
                if r.pid != skip and r.seen >= since and r.now() and r.now() > found.get(r.pid, ("", 0))[1]:
                    found[r.pid] = (r.app, r.now())
        return [{"app": app, "pid": pid, "fps": fps}
                for pid, (app, fps) in sorted(found.items(), key=lambda kv: -kv[1][1])[:6]]

    def forget(self, before, keep=None):
        with self._lock:
            for key in [k for k, r in self.runs.items() if r.seen < before and r.pid != keep]:
                del self.runs[key]


# ---------------------------------------------------------------- PresentMon as a child process
def find_presentmon():
    """The PresentMon console program: STELLARHUB_PRESENTMON, a tools folder next to the package, or PATH."""
    env = os.environ.get("STELLARHUB_PRESENTMON")
    if env and os.path.isfile(env):
        return env
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    found = sorted(glob.glob(os.path.join(root, "tools", "PresentMon*.exe")))
    return found[-1] if found else shutil.which("PresentMon")


class Capture:
    """Runs PresentMon and calls on_frame(Frame) from a reader thread. PresentMon needs to be allowed to start an
    ETW session (administrator); when it is not, it exits at once and `notes` holds what it said."""

    def __init__(self, on_frame, exe=None, process=None):
        self.on_frame = on_frame
        self.exe = exe or find_presentmon()
        self.process = process
        self.notes = deque(maxlen=20)  # lines that were not frames: PresentMon's warnings and errors
        self.proc = None

    def start(self):
        if not self.exe:
            return False
        cmd = [self.exe, "--output_stdout", "--no_console_stats", "--stop_existing_session", "--session_name", SESSION]
        if self.process:
            cmd += ["--process_name", self.process]
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                     text=True, encoding="utf-8", errors="replace", bufsize=1, creationflags=NO_WINDOW)
        threading.Thread(target=self._read, daemon=True, name="presentmon").start()
        return True

    def _read(self):
        parser = Parser()
        for line in self.proc.stdout:
            frame = parser.feed(line)
            if frame:
                self.on_frame(frame)
            elif line.strip() and parser.cols is None:
                self.notes.append(line.strip())

    def running(self):
        return bool(self.proc and self.proc.poll() is None)

    def stop(self):
        if not self.proc:
            return
        if self.running():
            self.proc.terminate()
        try:  # a killed PresentMon leaves its ETW session open: close it
            subprocess.run([self.exe, "--terminate_existing_session", "--session_name", SESSION],
                           capture_output=True, creationflags=NO_WINDOW, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            pass


# ---------------------------------------------------------------- which program is the game
class _MonitorInfo(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD)]


def foreground():
    """(pid, full) of the window in front. full: it covers its whole monitor, taskbar included, which is what a
    game does in fullscreen or borderless mode and a maximized window does not."""
    u = ctypes.windll.user32
    u.GetForegroundWindow.restype = wintypes.HWND
    u.MonitorFromWindow.restype = wintypes.HANDLE
    u.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    u.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_MonitorInfo)]
    hwnd = u.GetForegroundWindow()
    if not hwnd:
        return 0, False
    pid, rect, info = wintypes.DWORD(), wintypes.RECT(), _MonitorInfo()
    info.cbSize = ctypes.sizeof(info)
    u.GetWindowThreadProcessId(wintypes.HWND(hwnd), ctypes.byref(pid))
    if not u.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect)):
        return pid.value, False
    if not u.GetMonitorInfoW(u.MonitorFromWindow(hwnd, 2), ctypes.byref(info)):  # 2: the nearest monitor
        return pid.value, False
    m = info.rcMonitor
    return pid.value, rect.left <= m.left and rect.top <= m.top and rect.right >= m.right and rect.bottom >= m.bottom


TELE_KEYS = ("cpu", "cpuTemp", "gpu", "gpuTemp", "vram", "vramTotal", "ram", "threads")


def session_of(summary, tele, target):
    """What is kept of a finished run: its summary, the diagnosis and what the hardware did meanwhile."""
    def values(key):
        return [s[key] for s in tele if s.get(key) is not None]

    def mean(key):
        v = values(key)
        return round(sum(v) / len(v), 1) if v else None

    def peak(key):
        v = values(key)
        return round(max(v), 1) if v else None

    return {**summary, "target": target, "diagnosis": diagnose(summary["fps"], summary["gpuBusy"], tele, target),
            "hw": {"cpu": mean("cpu"), "cpuTemp": peak("cpuTemp"), "gpu": mean("gpu"), "gpuTemp": peak("gpuTemp"),
                   "vram": peak("vram"), "vramTotal": peak("vramTotal"), "ram": peak("ram")}}


class Monitor:
    """PresentMon running in the background, the game it found and the session saved when that game closes.
    tick() runs once a second; capture, sampler and front can be replaced (the tests do)."""

    def __init__(self, capture=None, sampler=None, front=foreground, save=None):
        self.tracker = Tracker()
        self.capture = capture or Capture(self.tracker.add)
        self.sampler = sampler       # telemetry.Sampler: made by start() when None
        self.front = front
        self.save = save or save_session
        self.target = 60.0
        self.game = None             # pid of the program being measured
        self.picked = None           # pid the user chose by hand
        self.tele = []               # telemetry samples of this session
        self._streak = (0, 0)        # (pid in front and full screen, for how many seconds)
        self._ticks = 0
        self._halt = threading.Event()
        self._lock = threading.Lock()

    def start(self):
        if not self.capture.start():
            return False
        if self.sampler is None:
            try:
                from .telemetry import Sampler
                self.sampler = Sampler(lambda sample: None)  # never started: sample() is called from tick()
            except Exception as e:
                print("games: no telemetry:", e)
        threading.Thread(target=self._loop, daemon=True, name="games").start()
        return True

    def _loop(self):
        while not self._halt.wait(1.0):
            try:
                self.tick()
            except Exception as e:
                print("games:", e)

    def stop(self):
        self._halt.set()
        self.capture.stop()
        with self._lock:
            return self._end()

    def tick(self):
        now = time.monotonic()
        with self._lock:
            self._ticks += 1
            if self.game is None:
                pid, full = self.front()
                held = self._streak[1] + 1 if full and pid == self._streak[0] else int(full)
                self._streak = (pid, held)
                want = self.picked or (pid if held >= GAME_AFTER_S else None)
                if want and self.tracker.seen(want) is not None:
                    self.game, self.picked, self.tele = want, None, []
            else:
                seen = self.tracker.seen(self.game)
                if seen is None or (now - seen > GONE_AFTER_S and not psutil.pid_exists(self.game)):
                    self._end()
                elif self.sampler and self._ticks % TELE_EVERY_S == 0 and now - seen < TELE_EVERY_S:
                    self._sample()
            if self._ticks % 60 == 0:
                self.tracker.forget(now - STALE_AFTER_S, keep=self.game)

    def _sample(self):
        try:
            s = self.sampler.sample()
        except Exception as e:
            print("games: telemetry:", e)
            return
        self.tele.append({k: s.get(k) for k in TELE_KEYS})

    def _end(self):
        """Closes the session: saved if it lasted long enough. Returns what was saved, or None."""
        pid, self.game, self._streak = self.game, None, (0, 0)
        summary = self.tracker.take(pid) if pid else None
        tele, self.tele = self.tele, []
        if not summary or summary["seconds"] < SESSION_MIN_S:
            return None
        return self.save(session_of(summary, tele, self.target))

    def track(self, pid):
        with self._lock:
            if self.game != pid:
                if self.game is not None:
                    self._end()
                self.picked = pid
        return True

    def live(self, target=None):
        try:
            self.target = min(1000.0, max(1.0, float(target)))
        except (TypeError, ValueError):
            pass
        on = self.capture.running()
        with self._lock:
            game = self.tracker.live(self.game) if self.game else None
            if game:
                last = self.tele[-1] if self.tele else {}
                game["diagnosis"] = diagnose(game["now"] or game["fps"], game["gpuNow"], self.tele[-30:], self.target)
                game["hw"] = {k: last.get(k) for k in TELE_KEYS if k != "threads"}
            return {"on": on, "found": True, "game": game, "target": self.target,
                    "others": [] if game else self.tracker.others(time.monotonic() - 5),
                    "notes": [] if on else list(self.capture.notes)}


# ---------------------------------------------------------------- saved sessions
_hlock = threading.Lock()


def _read_history():
    try:
        with open(HISTORY, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        try:  # a damaged file is kept aside instead of being overwritten silently
            os.replace(HISTORY, HISTORY + ".bad")
        except OSError:
            pass
        return []
    sessions = data.get("sessions") if isinstance(data, dict) else None
    return [s for s in sessions if isinstance(s, dict)] if isinstance(sessions, list) else []


def _write_history(sessions):
    os.makedirs(os.path.dirname(HISTORY), exist_ok=True)
    tmp = HISTORY + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"v": 1, "sessions": sessions[:MAX_SESSIONS]}, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, HISTORY)


def history():
    with _hlock:
        return _read_history()


def save_session(session):
    if not isinstance(session, dict) or not isinstance(session.get("app"), str):
        raise ValueError("invalid session")
    session = dict(session)
    now = int(time.time() * 1000)
    session.setdefault("at", now)
    with _hlock:
        sessions = _read_history()
        ids = {s.get("id") for s in sessions}
        sid, n = f"g{now}", 1
        while sid in ids:
            sid, n = f"g{now}-{n}", n + 1
        session["id"] = sid
        sessions.insert(0, session)
        sessions.sort(key=lambda s: s.get("at") or 0, reverse=True)
        _write_history(sessions)
    return session


def delete_session(session_id):
    with _hlock:
        sessions = _read_history()
        left = [s for s in sessions if s.get("id") != session_id]
        if len(left) != len(sessions):
            _write_history(left)
        return len(sessions) - len(left)


def clear_history():
    with _hlock:
        n = len(_read_history())
        if n:
            _write_history([])
        return n


# ---------------------------------------------------------------- for the UI
_monitor = None
_mlock = threading.Lock()


def status():
    return {"found": bool(find_presentmon()), "on": bool(_monitor and _monitor.capture.running()),
            "releases": RELEASES}


def start():
    """Starts watching for games. {ok} or {ok: False, why: 'missing'} when PresentMon is not there."""
    global _monitor
    with _mlock:
        if _monitor and _monitor.capture.running():
            return {"ok": True}
        if _monitor:  # PresentMon ended by itself: close what it was measuring before starting again
            _monitor.stop()
            _monitor = None
        monitor = Monitor()
        if not monitor.start():
            return {"ok": False, "why": "missing"}
        _monitor = monitor
    return {"ok": True}


def stop():
    """Stops watching. The game being measured, if any, is saved as a session: {saved: session or None}."""
    global _monitor
    with _mlock:
        monitor, _monitor = _monitor, None
    return {"saved": monitor.stop() if monitor else None}


def live(target=None):
    monitor = _monitor
    if not monitor:
        return {"on": False, "found": bool(find_presentmon()), "game": None, "target": target, "others": [],
                "notes": []}
    return monitor.live(target)


def track(pid):
    """Measures this process as the game, whatever its window looks like."""
    monitor = _monitor
    return bool(monitor and monitor.track(int(pid)))


# ---------------------------------------------------------------- command line
def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="Frame statistics from PresentMon.")
    ap.add_argument("--process", help="only this program, e.g. game.exe")
    ap.add_argument("--seconds", type=float, default=0, help="stop after this long (default: until Ctrl+C)")
    ap.add_argument("--csv", help="read a CSV that PresentMon saved instead of running it")
    ap.add_argument("--target", type=float, default=60, help="the frame rate wanted (default 60)")
    a = ap.parse_args(argv)
    tracker = Tracker()
    if a.csv:
        parser = Parser()
        with open(a.csv, encoding="utf-8", errors="replace", newline="") as fh:
            for line in fh:
                frame = parser.feed(line)
                if frame and (not a.process or frame.app.lower() == a.process.lower()):
                    tracker.add(frame)
    else:
        cap = Capture(tracker.add, process=a.process)
        if not cap.start():
            print("PresentMon was not found: put PresentMon-x.y.z-x64.exe in a tools folder next to run.py, "
                  "or set STELLARHUB_PRESENTMON to its path.", file=sys.stderr)
            return 2
        end = time.monotonic() + a.seconds if a.seconds else None
        try:
            while cap.running() and (end is None or time.monotonic() < end):
                time.sleep(1)
                run = tracker.busiest()
                if run:
                    print(f"{run.app:<28} {run.now() or '-':>7} fps   {len(run.ms)} frames", flush=True)
        except KeyboardInterrupt:
            pass
        cap.stop()
        if not tracker.runs and cap.notes:
            print("PresentMon said:\n  " + "\n  ".join(cap.notes), file=sys.stderr)
            return 1
    s = tracker.summary()
    if not s:
        print("No frames were captured.", file=sys.stderr)
        return 1
    s["diagnosis"] = diagnose(s["fps"], s["gpuBusy"], target=a.target)
    print(json.dumps(s, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
