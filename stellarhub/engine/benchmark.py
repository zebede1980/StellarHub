"""Benchmark: measures each component of the PC and gives it a score, plus a CPU stress test and a run history.

Everything heavy runs in C with the GIL released, so Python is never the bottleneck:
- CPU: hashlib (SHA-256, BLAKE2b) over 1 MiB buffers and zlib compress/decompress, on 1 thread and then on one
  thread per logical processor (each pinned to its processor, so the result also shows how every core behaves).
- Memory: ctypes.memmove / memset / msvcrt memcmp over buffers much larger than the caches, on several threads;
  latency with a dependent random walk (pointer chasing) over 64 MB, minus the same walk inside the L1 cache.
- Disks: CrystalDiskMark-style SEQ1M Q8 / SEQ1M Q1 / RND4K Q32 / RND4K Q1 with unbuffered, write-through I/O
  (CreateFileW + FILE_FLAG_NO_BUFFERING | FILE_FLAG_WRITE_THROUGH, page-aligned buffers) and real queue depth
  through an I/O completion port. The temporary file is opened with FILE_FLAG_DELETE_ON_CLOSE, so Windows removes
  it even if the app is killed mid-test; it is also deleted explicitly on cancel or error.
- Network (only when the user asks): speed.cloudflare.com (__down / __up) and TCP connection times.
- The graphics card is measured in the interface (WebGL2); its score is computed here so the math lives in one place.

Scores: 1000 points = the estimated result of a typical 2023 mid-range desktop PC (6-core CPU, RTX 4060-class
graphics, dual-channel DDR5, PCIe 4.0 NVMe SSD). Each component score is a geometric mean of its measurements
divided by that reference, so twice as fast = twice the points. The StellarHub Score is a weighted geometric mean
of the component scores (CPU 30 %, graphics 30 %, disk 25 %, memory 15 %). The network is shown apart: it
depends on the internet provider, not on the PC.

History: %APPDATA%\\StellarHub\\benchmarks.json (next to settings.json), newest first, at most MAX_RUNS runs.
"""
import ctypes
import glob
import hashlib
import http.client
import json
import math
import os
import random
import socket
import ssl
import threading
import time
import zlib
from ctypes import wintypes

from ..i18n import tr

EXPORTS = {"info", "drives", "history", "save_run", "delete_run", "clear_history", "score_gpu", "overall"}
JOBS = {"cpu", "memory", "disk", "network", "stress_cpu"}

from .. import paths as _paths
DATA_DIR = _paths.data_dir()
HISTORY = os.path.join(DATA_DIR, "benchmarks.json")
MAX_RUNS = 300
TMP_PREFIX = "StellarHub-bench-"
MB = 1 << 20

# ---------------------------------------------------------------- references (1000 points)
REF = {
    "cpu_st": {"sha256": 1330.0, "blake2b": 495.0, "zlib_c": 11.2, "zlib_d": 246.0},       # MB/s, one thread
    "cpu_mt": {"sha256": 8300.0, "blake2b": 1830.0, "zlib_c": 59.5, "zlib_d": 890.0},      # MB/s, all threads
    "mem": {"copy": 24.0, "read": 52.0, "write": 31.0, "latency": 78.0},                  # GB/s, ns
    "disk": {"seq_q8_read": 6000.0, "seq_q8_write": 5000.0, "rnd_q32_read": 300.0, "rnd_q1_read": 42.0,
             "rnd_q1_write": 75.0},                                                        # MB/s
    "gpu": {"fill": 143.0, "geo": 383.0},                                                  # scenes per second
}
CPU_W = (0.35, 0.65)                     # single, multi
DISK_W = {"seq_q8_read": .2, "seq_q8_write": .15, "rnd_q32_read": .15, "rnd_q1_read": .3, "rnd_q1_write": .2}
OVERALL_W = {"cpu": .30, "gpu": .30, "disk": .25, "memory": .15}


def _geo(pairs):
    """Weighted geometric mean of (ratio, weight); ratios <= 0 or None are skipped."""
    num = den = 0.0
    for r, w in pairs:
        if r is None or not (r > 0) or not w:
            continue
        num += w * math.log(r)
        den += w
    return math.exp(num / den) if den else None


def _pts(x):
    return int(round(x * 1000)) if x else None


def score_cpu_part(rates, mode):
    """rates: {kernel: MB/s}; mode 'st' or 'mt'."""
    ref = REF["cpu_" + mode]
    return _pts(_geo([((rates.get(k) or 0) / v, 1) for k, v in ref.items()]))


def score_cpu(single, multi):
    if not single or not multi:
        return single or multi or None
    return int(round(single ** CPU_W[0] * multi ** CPU_W[1]))


def score_memory(copy, read, write, latency=None):
    r = REF["mem"]
    bw = _geo([(copy / r["copy"] if copy else None, 1), (read / r["read"] if read else None, 1),
               (write / r["write"] if write else None, 1)])
    if not bw:
        return None
    if latency and latency > 0:
        return _pts(bw ** 0.8 * (r["latency"] / latency) ** 0.2)
    return _pts(bw)


def score_disk(res):
    """res: {'seq_q8': {'read': MB/s, 'write': MB/s}, 'rnd_q32': {...}, 'rnd_q1': {...}, ...}"""
    pairs = []
    for key, w in DISK_W.items():
        test, kind = key.rsplit("_", 1)
        v = (res.get(test) or {}).get(kind)
        pairs.append(((v / REF["disk"][key]) if v else None, w))
    return _pts(_geo(pairs))


def score_gpu(fill_fps, geo_fps):
    """Scenes per second of the two WebGL2 tests at 1920x1080 -> points."""
    return _pts(_geo([((fill_fps or 0) / REF["gpu"]["fill"], 1), ((geo_fps or 0) / REF["gpu"]["geo"], 1)]))


def overall(scores):
    """scores: {'cpu': n, 'gpu': n, 'memory': n, 'disk': n} (missing ones are skipped and the weights renormalized)."""
    if not isinstance(scores, dict):
        return None
    return _pts(_geo([((scores.get(k) or 0) / 1000, w) for k, w in OVERALL_W.items()]))


# ---------------------------------------------------------------- history
def _read_history():
    try:
        with open(HISTORY, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        # a damaged file is kept aside instead of being overwritten silently
        try:
            os.replace(HISTORY, HISTORY + ".bad")
        except OSError:
            pass
        return []
    runs = data.get("runs") if isinstance(data, dict) else data
    return [r for r in runs if isinstance(r, dict)] if isinstance(runs, list) else []


def _write_history(runs):
    os.makedirs(os.path.dirname(HISTORY), exist_ok=True)
    tmp = HISTORY + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"v": 1, "runs": runs[:MAX_RUNS]}, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, HISTORY)


_hlock = threading.Lock()


def history():
    with _hlock:
        return _read_history()


def save_run(run):
    if not isinstance(run, dict) or not isinstance(run.get("kind"), str):
        raise ValueError("invalid run")
    run = dict(run)
    now = int(time.time() * 1000)
    run.setdefault("at", now)
    with _hlock:
        runs = _read_history()
        ids = {r.get("id") for r in runs}
        rid, n = f"r{now}", 1
        while rid in ids:
            rid, n = f"r{now}-{n}", n + 1
        run["id"] = rid
        runs.insert(0, run)
        runs.sort(key=lambda r: r.get("at") or 0, reverse=True)
        _write_history(runs)
    return run


def delete_run(run_id):
    with _hlock:
        runs = _read_history()
        left = [r for r in runs if r.get("id") != run_id]
        if len(left) != len(runs):
            _write_history(left)
        return len(runs) - len(left)


def clear_history():
    with _hlock:
        n = len(_read_history())
        _write_history([])
        return n


# ---------------------------------------------------------------- CPU topology
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.GetCurrentThread.restype = wintypes.HANDLE
k32.SetThreadAffinityMask.argtypes = [wintypes.HANDLE, ctypes.c_size_t]
k32.SetThreadAffinityMask.restype = ctypes.c_size_t


class _PowerThrottling(ctypes.Structure):
    _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]


def _full_speed():
    """Opts the calling thread out of EcoQoS. Windows throttles processes whose window is hidden or in the tray
    (efficiency cores, low clocks), which would make every result depend on whether the window was visible."""
    try:
        st = _PowerThrottling(1, 0x1, 0x0)  # THREAD_POWER_THROTTLING_EXECUTION_SPEED controlled, and turned off
        k32.SetThreadInformation(k32.GetCurrentThread(), 3, ctypes.byref(st), ctypes.sizeof(st))  # ThreadPowerThrottling
    except Exception:
        pass


def topology():
    """Physical cores: [{'eff': efficiency class (higher = faster), 'lps': [logical processor numbers]}]."""
    try:
        size = wintypes.DWORD(0)
        k32.GetLogicalProcessorInformationEx(0, None, ctypes.byref(size))
        buf = ctypes.create_string_buffer(size.value)
        if not k32.GetLogicalProcessorInformationEx(0, buf, ctypes.byref(size)):
            raise OSError
        raw, off, cores = buf.raw, 0, []
        while off < size.value:
            rel = int.from_bytes(raw[off:off + 4], "little")
            sz = int.from_bytes(raw[off + 4:off + 8], "little")
            if rel == 0 and sz >= 48:
                eff = raw[off + 9]
                gcount = int.from_bytes(raw[off + 30:off + 32], "little")
                lps = []
                for g in range(gcount):
                    base = off + 32 + g * 16
                    mask = int.from_bytes(raw[base:base + 8], "little")
                    group = int.from_bytes(raw[base + 8:base + 10], "little")
                    lps += [group * 64 + b for b in range(64) if mask >> b & 1]
                cores.append({"eff": eff, "lps": lps})
            if sz <= 0:
                break
            off += sz
        if cores:
            return cores
    except Exception:
        pass
    n = os.cpu_count() or 1
    return [{"eff": 0, "lps": [i]} for i in range(n)]


def _pin(lp):
    _full_speed()
    if lp is not None and lp < 64:
        try:
            k32.SetThreadAffinityMask(k32.GetCurrentThread(), 1 << lp)
        except Exception:
            pass


def info():
    import psutil
    cores = topology()
    vm = psutil.virtual_memory()
    return {"threads": sum(len(c["lps"]) for c in cores), "cores": len(cores),
            "hybrid": len({c["eff"] for c in cores}) > 1, "topology": cores,
            "ramTotal": vm.total, "ramAvail": vm.available, "history": HISTORY}


# ---------------------------------------------------------------- CPU
_WORDS = ("orbit nebula comet planet stellar quasar pulsar galaxy photon gravity rocket cosmos signal "
          "moon dust light vector matrix kernel thread cache memory engine drive score system window "
          "the of and to in is it that for on with as at by from this be or an are").split()
KERNELS = ("sha256", "blake2b", "zlib_c", "zlib_d")


def _cpu_data():
    rnd = random.Random(42)
    hbuf = rnd.randbytes(MB)
    text = " ".join(rnd.choice(_WORDS) + (str(rnd.randrange(1000)) if rnd.random() < .15 else "")
                    for _ in range(60000)).encode()[:256 * 1024]
    comp = zlib.compress(text, 6)
    return {
        "sha256": (lambda: hashlib.sha256(hbuf).digest(), len(hbuf)),
        "blake2b": (lambda: hashlib.blake2b(hbuf).digest(), len(hbuf)),
        "zlib_c": (lambda: zlib.compress(text, 6), len(text)),
        "zlib_d": (lambda: zlib.decompress(comp), len(text)),
    }


def _run_kernel(job, fn, nbytes, lps, secs, report):
    """Runs fn on len(lps) threads (pinned when lps holds processor numbers) for secs.
    Returns (total MB/s, [MB/s per thread])."""
    n = len(lps)
    counts = [0] * n
    stop = [False]
    gate = threading.Barrier(n + 1)

    def work(i):
        _pin(lps[i])
        try:
            gate.wait()
        except threading.BrokenBarrierError:
            return
        c = 0
        while not stop[0]:
            fn()
            c += 1
            counts[i] = c

    ths = [threading.Thread(target=work, args=(i,), daemon=True) for i in range(n)]
    for t in ths:
        t.start()
    gate.wait()
    t0 = time.perf_counter()
    last_t, last_c = t0, 0
    try:
        while True:
            time.sleep(0.2)
            now = time.perf_counter()
            tot = sum(counts)
            report((tot - last_c) * nbytes / MB / max(1e-6, now - last_t), [c * nbytes / MB / (now - t0) for c in counts])
            last_t, last_c = now, tot
            if job.cancelled or now - t0 >= secs:
                break
    finally:
        stop[0] = True
        dt = time.perf_counter() - t0
        for t in ths:
            t.join()
    job.check()
    per = [c * nbytes / MB / dt for c in counts]
    return sum(per), per


def cpu(job, scale=1.0):
    _full_speed()  # the job thread too (latency walk, I/O submission)
    scale = max(0.1, min(3.0, float(scale or 1)))
    cores = topology()
    lps = [lp for c in cores for lp in c["lps"]]
    data = _cpu_data()
    st_secs, mt_secs = 1.25 * scale, 2.0 * scale
    steps = len(KERNELS) * 2
    single, multi, per_thread = {}, {}, {}
    t_start = time.time()
    for phase, secs in (("single", st_secs), ("multi", mt_secs)):
        for i, k in enumerate(KERNELS):
            step = (0 if phase == "single" else len(KERNELS)) + i
            fn, nb = data[k]
            fn()  # warm-up (allocations, code paths)
            t0 = time.perf_counter()

            def report(rate, per, step=step, k=k, t0=t0, phase=phase, secs=secs):
                frac = min(1.0, (time.perf_counter() - t0) / secs)
                job.progress((step + frac) / steps, tr("Measuring the processor…"), phase=phase, kernel=k,
                             rate=round(rate, 1), step=step, steps=steps,
                             perThread=[round(x, 1) for x in per] if phase == "multi" else None)
            tgt = [None] if phase == "single" else lps
            total, per = _run_kernel(job, fn, nb, tgt, secs, report)
            (single if phase == "single" else multi)[k] = round(total, 1)
            if phase == "multi":
                per_thread[k] = per
            job.progress((step + 1) / steps, phase=phase, kernel=k, rate=round(total, 1), value=round(total, 1),
                         step=step, steps=steps, force=True)
    s_st, s_mt = score_cpu_part(single, "st"), score_cpu_part(multi, "mt")
    # each logical processor's speed relative to one thread running alone, averaged over the kernels
    rel = [sum(per_thread[k][i] / single[k] for k in KERNELS if single[k]) / len(KERNELS) for i in range(len(lps))]
    pos = {lp: i for i, lp in enumerate(lps)}
    per_core = [{"eff": c["eff"], "rel": round(sum(rel[pos[lp]] for lp in c["lps"]), 3),
                 "threads": [round(rel[pos[lp]], 3) for lp in c["lps"]]} for c in cores]
    st_sum = sum(single.values())
    return {"single": single, "multi": multi, "scoreSingle": s_st, "scoreMulti": s_mt,
            "score": score_cpu(s_st, s_mt), "threads": len(lps), "cores": len(cores),
            "scaling": round(sum(multi.values()) / st_sum, 2) if st_sum else None,
            "perCore": per_core, "secs": round(time.time() - t_start, 1)}


# ---------------------------------------------------------------- memory
def _addr(ba):
    return ctypes.addressof((ctypes.c_char * len(ba)).from_buffer(ba))


_memcmp = ctypes.cdll.msvcrt.memcmp
_memcmp.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
_memcmp.restype = ctypes.c_int


def _par(job, fn, size, nthreads, reps):
    """Best GB/s over reps passes of fn(offset, length) split across threads."""
    best = 0.0
    sl = (size // nthreads) & ~4095
    for _ in range(reps):
        job.check()
        ths = [threading.Thread(target=lambda o, n: (_full_speed(), fn(o, n)), args=(i * sl, sl), daemon=True)
               for i in range(nthreads)]
        t0 = time.perf_counter()
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        dt = time.perf_counter() - t0
        best = max(best, sl * nthreads / dt / 1e9)
    return best


def _chase_build(nbytes, rnd):
    """A random cycle through every 64-byte line of the buffer: each step depends on the previous load."""
    n = nbytes // 64
    buf = bytearray(nbytes)
    mv = memoryview(buf).cast("Q")
    order = list(range(n))
    rnd.shuffle(order)
    for i in range(n):
        mv[order[i] * 8] = order[(i + 1) % n] * 8
    return buf, mv


def _chase(mv, steps):
    p = 0
    t0 = time.perf_counter()
    for _ in range(steps):
        p = mv[p]
    return (time.perf_counter() - t0) / steps * 1e9


def memory(job, scale=1.0):
    import psutil
    _full_speed()  # the job thread too (latency walk, I/O submission)
    scale = max(0.1, min(3.0, float(scale or 1)))
    avail = psutil.virtual_memory().available
    size = 256 * MB if avail > 3 * 1024 * MB else 128 * MB
    nthreads = max(1, min(8, os.cpu_count() or 1))
    reps = max(2, int(round(8 * scale)))
    t_start = time.time()
    # job.data keeps every key between messages: "value" is always sent (None = no final number yet)
    job.progress(0.02, tr("Preparing the memory test…"), phase="prepare", step=0, steps=4, value=None)
    res = {}
    a, b = bytearray(size), bytearray(size)
    try:
        pa, pb = _addr(a), _addr(b)
        ctypes.memset(pa, 0x5A, size)  # commits every page before measuring
        ctypes.memset(pb, 0x5A, size)
        tests = (
            ("copy", lambda o, n: ctypes.memmove(pb + o, pa + o, n), 1),
            ("read", lambda o, n: _memcmp(pa + o, pb + o, n), 2),   # equal buffers: reads 2 bytes per byte compared
            ("write", lambda o, n: ctypes.memset(pb + o, 0x5A, n), 1),
        )
        for i, (name, fn, mult) in enumerate(tests):
            job.progress((i + .1) / 4, tr("Measuring memory bandwidth…"), phase=name, step=i, steps=4, value=None, force=True)
            res[name] = round(_par(job, fn, size, nthreads, reps) * mult, 2)
            job.progress((i + 1) / 4, tr("Measuring memory bandwidth…"), phase=name, step=i, steps=4, value=res[name],
                         force=True)
    finally:
        a = b = None
    job.progress(.78, tr("Measuring memory latency…"), phase="latency", step=3, steps=4, value=None, force=True)
    latency = None
    mv_big = mv_small = None
    try:
        rnd = random.Random(7)
        big, mv_big = _chase_build(64 * MB, rnd)
        small, mv_small = _chase_build(16 * 1024, rnd)
        diffs = []
        rounds = max(4, int(round(12 * scale)))
        for i in range(rounds):
            job.check()
            s = _chase(mv_small, 60000)
            diffs.append(_chase(mv_big, 60000) - s)
            cur = sorted(diffs)[len(diffs) // 2]
            job.progress(.8 + .2 * (i + 1) / rounds, tr("Measuring memory latency…"), phase="latency", step=3, steps=4,
                         value=round(max(1.0, cur), 1), force=i == rounds - 1)
        diffs.sort()
        latency = round(max(1.0, diffs[len(diffs) // 2]), 1)
    finally:
        for mv in (mv_big, mv_small):
            if mv is not None:
                mv.release()
    return {"copy": res.get("copy"), "read": res.get("read"), "write": res.get("write"), "latency": latency,
            "sizeMb": size // MB, "threads": nthreads,
            "score": score_memory(res.get("copy"), res.get("read"), res.get("write"), latency),
            "secs": round(time.time() - t_start, 1)}


# ---------------------------------------------------------------- disks
class _OV(ctypes.Structure):
    _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t), ("Offset", wintypes.DWORD),
                ("OffsetHigh", wintypes.DWORD), ("hEvent", wintypes.HANDLE)]


class _OVE(ctypes.Structure):
    _fields_ = [("key", ctypes.c_size_t), ("ov", ctypes.c_void_p), ("Internal", ctypes.c_size_t), ("n", wintypes.DWORD)]


k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
                            wintypes.DWORD, wintypes.HANDLE]
k32.CreateFileW.restype = wintypes.HANDLE
k32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(_OV)]
k32.ReadFile.restype = wintypes.BOOL
k32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(_OV)]
k32.WriteFile.restype = wintypes.BOOL
k32.CloseHandle.argtypes = [wintypes.HANDLE]
k32.VirtualAlloc.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD, wintypes.DWORD]
k32.VirtualAlloc.restype = ctypes.c_void_p
k32.VirtualFree.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD]
k32.CreateIoCompletionPort.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.c_size_t, wintypes.DWORD]
k32.CreateIoCompletionPort.restype = wintypes.HANDLE
k32.GetQueuedCompletionStatusEx.argtypes = [wintypes.HANDLE, ctypes.POINTER(_OVE), wintypes.ULONG,
                                            ctypes.POINTER(wintypes.ULONG), wintypes.DWORD, wintypes.BOOL]
k32.GetQueuedCompletionStatusEx.restype = wintypes.BOOL
k32.GetVolumeInformationW.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD, ctypes.c_void_p,
                                      ctypes.c_void_p, ctypes.c_void_p, wintypes.LPWSTR, wintypes.DWORD]

GENERIC_RW = 0x80000000 | 0x40000000
SHARE_ALL = 0x7
CREATE_ALWAYS, OPEN_EXISTING = 2, 3
F_NO_BUFFERING, F_WRITE_THROUGH, F_OVERLAPPED, F_DELETE_ON_CLOSE = 0x20000000, 0x80000000, 0x40000000, 0x04000000
ATTR_TEMPORARY = 0x100
INVALID_HANDLE = wintypes.HANDLE(-1).value
ERROR_IO_PENDING = 997
SIZES_MB = (64, 256, 1024, 4096)

DISK_TESTS = (  # key, block, queue depth, random
    ("seq_q8", MB, 8, False),
    ("seq_q1", MB, 1, False),
    ("rnd_q32", 4096, 32, True),
    ("rnd_q1", 4096, 1, True),
)


def _system_drive():
    return (os.environ.get("SystemDrive") or "C:").upper()


def _tmp_dir(drive):
    """Folder for the test file on that drive: %TEMP% when it lives there, otherwise a folder at the root.
    Returns (folder, whether it is StellarHub's own folder)."""
    drive = drive.upper()[:2]
    temp = os.environ.get("TEMP") or os.environ.get("TMP") or ""
    if temp[:2].upper() == drive:
        return temp, False
    return drive + "\\StellarHub benchmark", True


def _sweep(folder):
    """Removes test files left by a run that crashed (normally Windows already deleted them on close)."""
    for p in glob.glob(os.path.join(folder, TMP_PREFIX + "*.tmp")):
        try:
            os.remove(p)
        except OSError:
            pass


def drives():
    import psutil
    out = []
    sysd = _system_drive()
    for p in psutil.disk_partitions(all=False):
        if "fixed" not in (p.opts or "") or not p.mountpoint:
            continue
        letter = p.mountpoint[:2].upper()
        try:
            du = psutil.disk_usage(p.mountpoint)
        except OSError:
            continue
        label = ctypes.create_unicode_buffer(261)
        try:
            k32.GetVolumeInformationW(p.mountpoint, label, 261, None, None, None, None, 0)
        except Exception:
            pass
        folder, own = _tmp_dir(letter)
        _sweep(folder)
        if own:
            try:
                os.rmdir(folder)  # only if a crashed run left it empty
            except OSError:
                pass
        out.append({"letter": letter, "label": label.value, "fs": p.fstype, "total": du.total, "free": du.free,
                    "system": letter == sysd})
    out.sort(key=lambda d: (not d["system"], d["letter"]))
    return out


def _open(path, flags, disposition=OPEN_EXISTING):
    h = k32.CreateFileW(path, GENERIC_RW, SHARE_ALL, None, disposition, flags, None)
    if h in (None, INVALID_HANDLE):
        raise OSError(ctypes.get_last_error(), tr("Windows did not let StellarHub create the test file."))
    return h


def _qd_run(job, path, size, block, depth, rnd, write, secs, src, report):
    """Keeps `depth` unbuffered requests in flight for secs. Returns (MB/s, IOPS, average latency in µs)."""
    h = _open(path, F_NO_BUFFERING | F_WRITE_THROUGH | F_OVERLAPPED)
    port = bufs = None
    try:
        port = k32.CreateIoCompletionPort(h, None, 1, 1)
        if not port:
            raise OSError(ctypes.get_last_error(), "CreateIoCompletionPort")
        bufs = k32.VirtualAlloc(None, block * depth, 0x3000, 0x04)
        if not bufs:
            raise MemoryError
        for i in range(depth):
            ctypes.memmove(bufs + i * block, src, min(block, MB))
        ovs = (_OV * depth)()
        base, osz = ctypes.addressof(ovs), ctypes.sizeof(_OV)
        ents = (_OVE * depth)()
        got = wintypes.ULONG()
        nblk = size // block
        rng = random.Random(1234 + depth)
        seq = [0]
        started = [0.0] * depth
        fn = k32.WriteFile if write else k32.ReadFile
        lat_sum = 0.0

        def submit(i):
            if rnd:
                off = rng.randrange(nblk) * block
            else:
                off = (seq[0] % nblk) * block
                seq[0] += 1
            o = ovs[i]
            o.Internal = o.InternalHigh = 0
            o.Offset, o.OffsetHigh = off & 0xFFFFFFFF, off >> 32
            started[i] = time.perf_counter()
            if not fn(h, bufs + i * block, block, None, ctypes.byref(o)):
                e = ctypes.get_last_error()
                if e != ERROR_IO_PENDING:
                    raise OSError(e, tr("The disk returned an error during the test."))

        t0 = time.perf_counter()
        end = t0 + secs
        done = 0
        last_t, last_n = t0, 0
        for i in range(depth):
            submit(i)
        inflight = depth
        while inflight:
            if not k32.GetQueuedCompletionStatusEx(port, ents, depth, ctypes.byref(got), 5000, False):
                raise OSError(ctypes.get_last_error(), tr("The disk stopped answering during the test."))
            now = time.perf_counter()
            stopping = now >= end or job.cancelled
            for j in range(got.value):
                i = (ents[j].ov - base) // osz
                lat_sum += now - started[i]
                done += 1
                inflight -= 1
                if not stopping:
                    submit(i)
                    inflight += 1
            if now - last_t >= .2:
                report((done - last_n) * block / 1e6 / (now - last_t), min(1.0, (now - t0) / secs))
                last_t, last_n = now, done
        dt = time.perf_counter() - t0
        job.check()
        return done * block / 1e6 / dt, done / dt, (lat_sum / done * 1e6) if done else None
    finally:
        if bufs:
            k32.VirtualFree(bufs, 0, 0x8000)
        if port:
            k32.CloseHandle(port)
        k32.CloseHandle(h)


def _remove(path):
    for _ in range(10):
        if not os.path.exists(path):
            return True
        try:
            os.remove(path)
        except OSError:
            time.sleep(0.2)
    return not os.path.exists(path)


def disk(job, drive=None, size_mb=1024, scale=1.0):
    import psutil
    _full_speed()  # the job thread too (latency walk, I/O submission)
    scale = max(0.1, min(3.0, float(scale or 1)))
    drive = (drive or _system_drive()).upper()[:2]
    size_mb = int(size_mb or 1024)
    if size_mb not in SIZES_MB:
        raise ValueError("invalid size")
    size = size_mb * MB
    folder, own = _tmp_dir(drive)
    try:
        free = psutil.disk_usage(drive + "\\").free
    except OSError:
        raise RuntimeError(tr("Drive {drive} is not available.", drive=drive))
    if free < size + 1024 * MB:
        raise RuntimeError(tr("Drive {drive} needs at least {gb} GB free for this test.", drive=drive,
                              gb=round((size + 1024 * MB) / 1024 ** 3, 1)))
    created_dir = False
    if own and not os.path.isdir(folder):
        try:
            os.makedirs(folder)
            created_dir = True
        except OSError:
            raise RuntimeError(tr("StellarHub cannot write on drive {drive}.", drive=drive))
    _sweep(folder)
    path = os.path.join(folder, f"{TMP_PREFIX}{os.getpid()}-{int(time.time() * 1000)}.tmp")
    keeper = None
    src = k32.VirtualAlloc(None, MB, 0x3000, 0x04)
    t_start = time.time()
    secs = 3.0 * scale
    steps = 1 + len(DISK_TESTS) * 2
    results = {}
    try:
        ctypes.memmove(src, random.Random(9).randbytes(MB), MB)
        # the keeper handle makes Windows delete the file when it is closed, even if the app dies
        keeper = _open(path, F_NO_BUFFERING | F_WRITE_THROUGH | F_DELETE_ON_CLOSE | ATTR_TEMPORARY, CREATE_ALWAYS)
        # fill the whole file first: reads past the written part would never reach the disk
        ov = _OV()
        t0 = time.perf_counter()
        nchunks = size // MB
        for i in range(nchunks):
            if job.cancelled:
                job.stop()
            off = i * MB
            ov.Offset, ov.OffsetHigh = off & 0xFFFFFFFF, off >> 32
            if not k32.WriteFile(keeper, src, MB, ctypes.byref(wintypes.DWORD()), ctypes.byref(ov)):
                raise OSError(ctypes.get_last_error(), tr("The disk returned an error during the test."))
            if i % 16 == 0:
                el = time.perf_counter() - t0
                job.progress((i / nchunks) / steps, tr("Preparing a {size} test file…", size=f"{size_mb} MB"),
                             phase="prepare", step=0, steps=steps, value=None,
                             rate=round(i * MB / 1e6 / el, 1) if el > 0.05 else None)
        step = 1
        for key, block, depth, rnd in DISK_TESTS:
            entry = results.setdefault(key, {})
            for write in (False, True):
                kind = "write" if write else "read"

                def report(rate, frac, step=step, key=key, kind=kind):
                    job.progress((step + frac) / steps, tr("Measuring the disk…"), phase=key, kind=kind,
                                 rate=round(rate, 1), value=None, step=step, steps=steps)
                mbs, iops, lat = _qd_run(job, path, size, block, depth, rnd, write, secs, src, report)
                entry[kind] = round(mbs, 1)
                if rnd:
                    entry[kind + "Iops"] = int(round(iops))
                if depth == 1 and lat:
                    entry[kind + "Lat"] = round(lat, 1)
                job.progress((step + 1) / steps, tr("Measuring the disk…"), phase=key, kind=kind, value=entry[kind],
                             step=step, steps=steps, force=True)
                step += 1
    finally:
        if keeper:
            k32.CloseHandle(keeper)
        k32.VirtualFree(src, 0, 0x8000)
        _remove(path)
        if created_dir:
            try:
                os.rmdir(folder)
            except OSError:
                pass
    return {"drive": drive, "sizeMb": size_mb, "tests": results, "score": score_disk(results),
            "secs": round(time.time() - t_start, 1)}


# ---------------------------------------------------------------- network
NET_HOST = "speed.cloudflare.com"
NET_CAP = 600 * 1000 * 1000      # bytes per direction at most, so a very fast line does not burn gigabytes


def _conn():
    return http.client.HTTPSConnection(NET_HOST, timeout=10, context=ssl.create_default_context())


def _hdr():
    return {"User-Agent": "StellarHub benchmark", "Accept-Encoding": "identity"}


def _transfer(job, direction, secs, nconn, report):
    """Parallel transfers for secs. Returns (Mbit/s measured after a 1 s ramp-up, bytes moved)."""
    moved = [0] * nconn
    stop = [False]
    errors = []
    chunk = b"\x00" * (64 * 1024)

    def work(i):
        c = None
        try:
            while not stop[0]:
                c = c or _conn()
                if direction == "down":
                    c.request("GET", "/__down?bytes=25000000", headers=_hdr())
                    r = c.getresponse()
                    while not stop[0]:
                        b = r.read(65536)
                        if not b:
                            break
                        moved[i] += len(b)
                else:
                    total = 8 * 1000 * 1000
                    c.putrequest("POST", "/__up", skip_accept_encoding=True)
                    for k, v in _hdr().items():
                        c.putheader(k, v)
                    c.putheader("Content-Type", "application/octet-stream")
                    c.putheader("Content-Length", str(total))
                    c.endheaders()
                    sent = 0
                    while sent < total and not stop[0]:
                        n = min(len(chunk), total - sent)
                        c.send(chunk[:n])
                        sent += n
                        moved[i] += n
                    if not stop[0]:
                        c.getresponse().read()
        except Exception as e:  # noqa: BLE001 (a dropped connection only ends that stream)
            if not stop[0]:
                errors.append(e)
        finally:
            try:
                if c:
                    c.close()
            except Exception:
                pass

    ths = [threading.Thread(target=work, args=(i,), daemon=True) for i in range(nconn)]
    for t in ths:
        t.start()
    t0 = time.perf_counter()
    base_b = base_t = None
    last_t, last_b = t0, 0
    try:
        while True:
            time.sleep(0.2)
            now, tot = time.perf_counter(), sum(moved)
            if base_t is None and now - t0 >= 1.0:
                base_t, base_b = now, tot
            report((tot - last_b) * 8 / 1e6 / max(1e-6, now - last_t), min(1.0, (now - t0) / secs))
            last_t, last_b = now, tot
            if job.cancelled or now - t0 >= secs or tot >= NET_CAP or not any(t.is_alive() for t in ths):
                break
    finally:
        stop[0] = True
        end_t, end_b = time.perf_counter(), sum(moved)
        for t in ths:
            t.join(timeout=3)
    job.check()
    if base_t is None or end_t - base_t < 0.5:
        base_t, base_b = t0, 0
    if end_b - base_b <= 0:
        raise RuntimeError(tr("Could not reach {host}. Check your internet connection.", host=NET_HOST))
    return (end_b - base_b) * 8 / 1e6 / (end_t - base_t), end_b


def network(job, scale=1.0):
    _full_speed()  # the job thread too (latency walk, I/O submission)
    scale = max(0.2, min(3.0, float(scale or 1)))
    t_start = time.time()
    job.progress(0.01, tr("Connecting to {host}…", host=NET_HOST), phase="connect", step=0, steps=3)
    try:
        c = _conn()
        c.request("GET", "/__down?bytes=0", headers=_hdr())
        r = c.getresponse()
        r.read()
        server = {"colo": r.getheader("colo") or "", "city": r.getheader("city") or ""}
        c.close()
        addr_info = socket.getaddrinfo(NET_HOST, 443, type=socket.SOCK_STREAM)[0]
    except OSError:
        raise RuntimeError(tr("Could not reach {host}. Check your internet connection.", host=NET_HOST))
    # latency: time to open a TCP connection (one round trip), 12 samples
    lat = []
    for i in range(12):
        job.check()
        s = socket.socket(addr_info[0], socket.SOCK_STREAM)
        s.settimeout(3)
        try:
            t0 = time.perf_counter()
            s.connect(addr_info[4])
            lat.append((time.perf_counter() - t0) * 1000)
        except OSError:
            pass
        finally:
            s.close()
        job.progress((i + 1) / 12 / 3, tr("Measuring latency…"), phase="latency", step=0, steps=3, rate=None,
                     value=round(lat[-1], 1) if lat else None)
        time.sleep(0.05)
    if not lat:
        raise RuntimeError(tr("Could not reach {host}. Check your internet connection.", host=NET_HOST))
    if len(lat) > 4:
        lat = lat[1:]  # the first connection also pays for cold caches along the way
    ls = sorted(lat)
    out = {"server": server, "host": NET_HOST, "latency": round(ls[len(ls) // 2], 1),
           "jitter": round(sum(abs(a - b) for a, b in zip(lat, lat[1:])) / max(1, len(lat) - 1), 1)}
    for step, d in ((1, "down"), (2, "up")):
        def report(rate, frac, step=step, d=d):
            job.progress((step + frac) / 3, tr("Measuring download speed…") if d == "down" else tr("Measuring upload speed…"),
                         phase=d, rate=round(rate, 1), value=None, step=step, steps=3)
        mbps, moved = _transfer(job, d, 7.0 * scale, 4, report)
        out[d] = round(mbps, 1)
        out[d + "Mb"] = round(moved / 1e6)
        job.progress((step + 1) / 3, phase=d, rate=None, value=out[d], step=step, steps=3, force=True)
    out["secs"] = round(time.time() - t_start, 1)
    return out


# ---------------------------------------------------------------- CPU stress test
def stress_cpu(job, seconds=60, threads=None):
    """Loads every logical processor and checks every result: a wrong hash or a failed compression round trip is a
    calculation error (an unstable CPU, overclock or undervolt). Stops at `seconds` or when cancelled; the
    interface also stops it at safe temperature limits."""
    seconds = max(5, min(3600, int(seconds or 60)))
    lps = [lp for c in topology() for lp in c["lps"]]
    if threads:
        lps = lps[:max(1, int(threads))]
    data = random.Random(5).randbytes(MB)
    want = hashlib.sha256(data).digest()
    text = (" ".join(_WORDS) * 400).encode()[:128 * 1024]
    counts = [0] * len(lps)
    errors = [0]
    stop = [False]

    def work(i):
        _pin(lps[i])
        n = 0
        while not stop[0]:
            if hashlib.sha256(data).digest() != want:
                errors[0] += 1
            if n % 8 == 0 and zlib.decompress(zlib.compress(text, 1)) != text:
                errors[0] += 1
            n += 1
            counts[i] = n

    ths = [threading.Thread(target=work, args=(i,), daemon=True) for i in range(len(lps))]
    for t in ths:
        t.start()
    t0 = time.perf_counter()
    last_t, last_c = t0, 0
    rates = []
    try:
        while True:
            time.sleep(0.5)
            now = time.perf_counter()
            tot = sum(counts)
            rate = (tot - last_c) * MB / 1e6 / max(1e-6, now - last_t)
            rates.append(rate)
            last_t, last_c = now, tot
            el = now - t0
            job.progress(min(1.0, el / seconds), tr("Stress test running…"), elapsed=round(el, 1), rate=round(rate),
                         errors=errors[0])
            if job.cancelled or el >= seconds:
                break
    finally:
        stop[0] = True
        for t in ths:
            t.join()
    el = time.perf_counter() - t0
    k = max(1, len(rates) // 6)
    first, last = rates[:k], rates[-k:]
    # a cancelled stress test still has a useful summary: it is returned, not raised
    return {"elapsed": round(el, 1), "errors": errors[0], "threads": len(lps), "stopped": bool(job.cancelled),
            "rateStart": round(sum(first) / len(first)) if first else None,
            "rateEnd": round(sum(last) / len(last)) if last else None}
