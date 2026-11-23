"""Live Monitor: what the continuous telemetry does not bring. Processes per program (with their real icon), disks
with SMART, network (adapters, Wi-Fi, DNS, apps with connections), battery (powercfg report) and health (devices
with errors and critical events from the System log). Everything is read-only except end_process and set_dns
(the interface asks for confirmation first)."""
import ctypes
import os
import re
import socket
import subprocess
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from ctypes import wintypes

import psutil

from ..i18n import tr
from .ps import ps_json

EXPORTS = {"processes", "end_process", "open_location", "disks", "network", "public_ip", "dns_test", "set_dns",
           "battery_report", "health", "gpu_info", "memory_info", "icons"}

NO_WINDOW = 0x08000000
MB = 1024 ** 2
GB = 1024 ** 3
_lock = threading.Lock()


def _admin():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


# ======================================================================================= processes
_desc_cache = {}     # exe -> file description
_icon_cache = {}     # exe -> data URI or None
_static = {}         # pid -> (name, exe): does not change while the process lives
ICON_BUDGET = 0.6    # max seconds spent extracting icons per call (the rest arrive in the next calls)
SYS_DIRS = (os.environ.get("SystemRoot", r"C:\Windows").lower(),)
OWN = os.getpid()


def _file_desc(path):
    """FileDescription of the .exe (what Task Manager shows)."""
    if path in _desc_cache:
        return _desc_cache[path]
    desc = None
    try:
        ver = ctypes.windll.version
        size = ver.GetFileVersionInfoSizeW(path, None)
        if size:
            buf = ctypes.create_string_buffer(size)
            ver.GetFileVersionInfoW(path, 0, size, buf)
            p = ctypes.c_void_p()
            ln = wintypes.UINT()
            if ver.VerQueryValueW(buf, r"\VarFileInfo\Translation", ctypes.byref(p), ctypes.byref(ln)) and ln.value >= 4:
                lang, cp = ctypes.cast(p, ctypes.POINTER(ctypes.c_ushort * 2)).contents
                for key in (f"\\StringFileInfo\\{lang:04x}{cp:04x}\\FileDescription", "\\StringFileInfo\\040904b0\\FileDescription"):
                    if ver.VerQueryValueW(buf, key, ctypes.byref(p), ctypes.byref(ln)) and ln.value > 1:
                        desc = ctypes.wstring_at(p, ln.value - 1).strip()
                        if desc:
                            break
    except Exception:
        desc = None
    _desc_cache[path] = desc
    return desc


def _icon(exe):
    if exe not in _icon_cache:
        try:
            from .removal.icons import icon_for_file
            _icon_cache[exe] = icon_for_file(exe) if exe and os.path.isfile(exe) else None
        except Exception:
            _icon_cache[exe] = None
    return _icon_cache[exe]


# Parts of Windows with no program file: they get the Windows logo
PSEUDO = {"system", "registry", "memcompression", "memory compression", "idle", "system idle process", "secure system",
          "interrupts", "vmmem", "vmmemwsl", "vmmemws"}
SERVICE_HOSTS = {"svchost.exe", "services.exe", "wudfhost.exe", "dllhost.exe"}
_svc = {"at": 0, "paths": set(), "byname": {}}


def _services():
    """Program files of the installed services (refreshed every 10 min): which processes are services, and the path
    of protected ones Windows will not tell a normal user (an antivirus, for example)."""
    if time.monotonic() - _svc["at"] > 600 or not _svc["at"]:
        paths, byname = set(), {}
        try:
            from .removal.programs import exe_from_command
            for sv in psutil.win_service_iter():
                try:
                    exe = exe_from_command(sv.binpath())
                except (psutil.Error, OSError):
                    continue
                if exe and os.path.isabs(exe):
                    paths.add(exe.lower())
                    byname.setdefault(os.path.basename(exe).lower(), exe)
        except Exception:
            pass
        _svc.update(at=time.monotonic(), paths=paths, byname=byname)
    return _svc


def _find_exe(name):
    """Where a process lives when Windows refuses to say (protected and system processes, normal mode)."""
    name = (name or "").lower()
    if not name.endswith(".exe"):
        return ""
    root = os.environ.get("SystemRoot", r"C:\Windows")
    for d in (os.path.join(root, "System32"), root, os.path.join(root, "SysWOW64")):
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    p = _services()["byname"].get(name)
    return p if p and os.path.isfile(p) else ""


def _proc_icon(name, exe, system):
    """Icon for a process row: its own icon; the Windows logo for parts of Windows; a gear for services
    without an icon; the generic program icon otherwise (like Explorer). Never None if Windows can draw one."""
    try:
        from .removal import icons
    except Exception:
        return None
    low = (name or "").lower()
    if os.path.splitext(low)[0] in PSEUDO or low in PSEUDO:
        return icons.windows_icon()
    if low in SERVICE_HOSTS:
        return icons.stock_icon("settings")
    path = exe if exe and os.path.isfile(exe) else _find_exe(name)
    own = _icon(path) if path else None
    if own:
        return own
    if path and path.lower() in _services()["paths"]:
        return icons.stock_icon("settings")
    in_windows = path and path.lower().startswith(SYS_DIRS) and "\\driverstore\\" not in path.lower()  # not drivers' helpers
    if in_windows or (not path and system):
        return icons.windows_icon()
    return icons.type_icon(".exe")


class _PdhArray:
    r"""Reads multi-instance counters (\Process(*)\..., \GPU Engine(*)\...) in ONE single query.
    The query stays open between calls: rate counters are computed against the previous reading."""

    class _VAL(ctypes.Structure):
        _fields_ = [("CStatus", wintypes.DWORD), ("dbl", ctypes.c_double)]

    def __init__(self, paths):
        self.ok = False
        self.c = {}
        try:
            self.pdh = ctypes.windll.pdh
            self.q = wintypes.HANDLE()
            if self.pdh.PdhOpenQueryW(None, 0, ctypes.byref(self.q)) != 0:
                return
            for k, path in paths.items():
                h = wintypes.HANDLE()
                if self.pdh.PdhAddEnglishCounterW(self.q, path, 0, ctypes.byref(h)) == 0:
                    self.c[k] = h
            self.pdh.PdhCollectQueryData(self.q)
            self.ok = bool(self.c)
        except Exception:
            pass

    def collect(self):
        return self.ok and self.pdh.PdhCollectQueryData(self.q) == 0

    def array(self, key):
        """List of (instance, value) for the counter."""
        h = self.c.get(key)
        if h is None:
            return []

        class ITEM(ctypes.Structure):
            _fields_ = [("szName", wintypes.LPWSTR), ("FmtValue", _PdhArray._VAL)]
        size, count = wintypes.DWORD(0), wintypes.DWORD(0)
        flags = 0x200 | 0x8000  # PDH_FMT_DOUBLE | PDH_FMT_NOCAP100
        self.pdh.PdhGetFormattedCounterArrayW(h, flags, ctypes.byref(size), ctypes.byref(count), None)
        if not size.value:
            return []
        buf = (ctypes.c_byte * size.value)()
        if self.pdh.PdhGetFormattedCounterArrayW(h, flags, ctypes.byref(size), ctypes.byref(count), buf) != 0:
            return []
        items = ctypes.cast(buf, ctypes.POINTER(ITEM))
        return [(items[i].szName or "", items[i].FmtValue.dbl) for i in range(count.value)]


_pdh = None
PDH_PATHS = {"pid": r"\Process(*)\ID Process", "cpu": r"\Process(*)\% Processor Time",
             "ram": r"\Process(*)\Working Set - Private", "io": r"\Process(*)\IO Data Bytes/sec",
             "gpu": r"\GPU Engine(*)\Utilization Percentage", "vram": r"\GPU Process Memory(*)\Dedicated Usage"}


def processes(known=None):
    """Processes grouped by program (like Task Manager), read in one go with Windows performance counters:
    CPU in % of the total, private RAM in MB, disk in MB/s, GPU in %, dedicated video memory in MB,
    network = open connections.
    The icon is only sent for programs the interface does not know yet (`known`)."""
    global _pdh
    known = set(known or [])
    with _lock:
        if _pdh is None:
            _pdh = _PdhArray(PDH_PATHS)
            time.sleep(0.25)
        if not _pdh.collect():
            return {"list": [], "total": 0, "gpuPerProcess": False, "vramPerProcess": False, "admin": _admin(), "error": "counters not available"}
        ncpu = psutil.cpu_count() or 1
        # NOTE: processes with the same name (svchost, chrome...) come with the SAME instance name, without "#n".
        # The lists of all counters come in the same order: they are paired by position, not by name.
        pid_arr = _pdh.array("pid")
        inst = [(name, int(v)) for name, v in pid_arr]
        vals = {}
        for k in ("cpu", "ram", "io"):
            arr = _pdh.array(k)
            if len(arr) == len(pid_arr) and all(a[0] == b[0] for a, b in zip(arr, pid_arr)):
                vals[k] = {pid: arr[i][1] for i, (_, pid) in enumerate(inst)}
            else:  # different order (rare): only the ones with a unique name
                uniq = {}
                for n, pid in inst:
                    uniq[n] = None if n in uniq else pid
                vals[k] = {uniq[n]: v for n, v in arr if uniq.get(n)}
        inst = [(n, pid) for n, pid in inst if pid > 0]
        gpu = {}
        for name, v in _pdh.array("gpu"):
            m = re.match(r"pid_(\d+)_", name)
            if m:
                pid = int(m.group(1))
                gpu[pid] = max(gpu.get(pid, 0.0), v)
        vram = {}
        for name, v in _pdh.array("vram"):  # one instance per process and adapter: summed
            m = re.match(r"pid_(\d+)_", name)
            if m:
                pid = int(m.group(1))
                vram[pid] = vram.get(pid, 0.0) + v
        conns = {}
        try:
            for c in psutil.net_connections("inet"):
                if c.pid and c.status == psutil.CONN_ESTABLISHED:
                    conns[c.pid] = conns.get(c.pid, 0) + 1
        except (psutil.AccessDenied, OSError):
            pass
        t0 = time.monotonic()
        groups = {}
        alive = {pid for _, pid in inst}
        for iname, pid in inst:
            st = _static.get(pid)
            if st is None:
                exe = ""
                try:
                    exe = psutil.Process(pid).exe()
                except (psutil.Error, OSError):
                    pass
                base = iname.split("#")[0]
                st = _static[pid] = (os.path.basename(exe) if exe else base + ".exe", exe)
            name, exe = st
            key = name.lower()
            g = groups.get(key)
            if g is None:
                system = (not exe) or exe.lower().startswith(SYS_DIRS)
                where = exe or _find_exe(name)  # protected processes: only for the description and the icon
                desc = _file_desc(where) if where and (where in _desc_cache or time.monotonic() - t0 < 1.0) else None
                g = groups[key] = {"key": key, "n": desc or os.path.splitext(name)[0], "exe": name, "path": exe, "sys": bool(system),
                                   "k": 0, "pids": [], "cpu": 0.0, "ram": 0.0, "gpu": 0.0, "vram": 0.0, "disk": 0.0, "net": 0}
            g["k"] += 1
            g["pids"].append(pid)
            g["cpu"] += vals["cpu"].get(pid, 0.0) / ncpu
            g["ram"] += vals["ram"].get(pid, 0.0) / MB
            g["disk"] += vals["io"].get(pid, 0.0) / MB
            g["gpu"] = max(g["gpu"], min(100.0, gpu.get(pid, 0.0)))
            g["vram"] += vram.get(pid, 0.0) / MB
            g["net"] += conns.get(pid, 0)
        for pid in list(_static):
            if pid not in alive:
                _static.pop(pid, None)
        out = []
        t_icons = time.monotonic()
        for g in sorted(groups.values(), key=lambda g: -g["ram"]):
            g["cpu"], g["ram"], g["gpu"], g["disk"] = round(min(100, g["cpu"]), 2), round(g["ram"], 1), round(g["gpu"], 1), round(g["disk"], 2)
            g["vram"] = round(g["vram"], 1)
            if g["key"] not in known:
                if not g["path"] or g["path"] in _icon_cache or time.monotonic() - t_icons < ICON_BUDGET:
                    g["icon"] = _proc_icon(g["exe"], g["path"], g["sys"])  # no time left: not sent, the interface asks again
            if OWN in g["pids"]:
                g["own"] = True
            out.append(g)
        return {"list": out, "total": len(alive), "gpuPerProcess": "gpu" in _pdh.c, "vramPerProcess": "vram" in _pdh.c, "admin": _admin()}


def icons(specs, budget=1.5):
    """Shared icon lookup for lists in any module (Storage's files, for example). Each spec is 'ext:.mp4' (file type),
    'file:<path>' (the file's own icon, or its type's), 'dir:' (folder), 'stock:<name>' or 'windows'.
    Returns {spec: data URI}; what does not fit in the time budget is left out and arrives on the next call."""
    from .removal import icons as ic
    out, t0 = {}, time.monotonic()
    for spec in list(specs or [])[:400]:
        if time.monotonic() - t0 > budget:
            break
        kind, _, val = str(spec).partition(":")
        try:
            uri = (ic.type_icon(val) if kind == "ext" else ic.file_icon(val) if kind == "file" else
                   ic.type_icon("", folder=True) if kind == "dir" else ic.stock_icon(val) if kind == "stock" else
                   ic.windows_icon() if kind == "windows" else None)
        except Exception:
            uri = None
        if uri:
            out[spec] = uri
    return out


def end_process(key):
    """Ends every process of a program. Refuses with Windows processes and with StellarHub itself."""
    key = str(key).lower()
    killed, denied = 0, 0
    for p in psutil.process_iter(["pid", "name", "exe"]):
        if (p.info["name"] or "").lower() != key or p.info["pid"] == OWN:
            continue
        exe = (p.info["exe"] or "").lower()
        if not exe or exe.startswith(SYS_DIRS):
            denied += 1
            continue
        try:
            p.terminate()
            killed += 1
        except psutil.Error:
            denied += 1
    return {"killed": killed, "denied": denied}


def open_location(path):
    if path and os.path.exists(path):
        subprocess.Popen(["explorer.exe", "/select,", os.path.normpath(path)], creationflags=NO_WINDOW)
        return True
    return False


# ======================================================================================= memory and GPU
def memory_info():
    class PI(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("CommitTotal", ctypes.c_size_t), ("CommitLimit", ctypes.c_size_t),
                    ("CommitPeak", ctypes.c_size_t), ("PhysicalTotal", ctypes.c_size_t), ("PhysicalAvailable", ctypes.c_size_t),
                    ("SystemCache", ctypes.c_size_t), ("KernelTotal", ctypes.c_size_t), ("KernelPaged", ctypes.c_size_t),
                    ("KernelNonpaged", ctypes.c_size_t), ("PageSize", ctypes.c_size_t), ("HandleCount", wintypes.DWORD),
                    ("ProcessCount", wintypes.DWORD), ("ThreadCount", wintypes.DWORD)]
    pi = PI()
    pi.cb = ctypes.sizeof(pi)
    ctypes.windll.psapi.GetPerformanceInfo(ctypes.byref(pi), pi.cb)
    pg = pi.PageSize
    comp = None
    for p in psutil.process_iter(["name"]):
        if p.info["name"] == "MemCompression":
            try:
                comp = round(p.memory_info().rss / MB)
            except psutil.Error:
                pass
            break
    return {"paged": round(pi.KernelPaged * pg / MB), "nonpaged": round(pi.KernelNonpaged * pg / MB),
            "commitLimit": round(pi.CommitLimit * pg / GB, 1), "commitPeak": round(pi.CommitPeak * pg / GB, 1),
            "handles": pi.HandleCount, "threads": pi.ThreadCount, "processes": pi.ProcessCount, "compressed": comp}


_gpu_info_cache = {}


def gpu_info():
    """Spec sheet of the NVIDIA GPU (if there is one) through NVML (in-process, ~40 ms; nvidia-smi was ~120 ms + a process).
    If the dedicated GPU is powered down (D3) it is NOT woken up just for this: the last sheet read is returned with
    asleep=True, or {"asleep": True} if there is none yet."""
    from .telemetry import _Nvml, _display_power_states
    states = _display_power_states()
    nv_state = next((s for n, s in states.items() if "nvidia" in n.lower()), None)
    if nv_state is None and states:
        return None  # no NVIDIA adapter
    if nv_state is not None and nv_state > 1:
        return dict(_gpu_info_cache, asleep=True) if _gpu_info_cache else {"asleep": True}
    nv = _Nvml()
    if not nv.init():
        return None
    L, d = nv.lib, nv.dev
    try:
        ok = lambda rc: rc == 0
        name, drv = ctypes.create_string_buffer(96), ctypes.create_string_buffer(80)
        L.nvmlDeviceGetName(d, name, 96)
        L.nvmlSystemGetDriverVersion(drv, 80)
        mem = (ctypes.c_ulonglong * 3)()
        plim, mclk, gen, width, slow, temp = (ctypes.c_uint() for _ in range(6))
        out = {"name": name.value.decode(errors="replace"), "driver": drv.value.decode(errors="replace"),
               "vram": round(mem[0] / GB) if ok(L.nvmlDeviceGetMemoryInfo(d, mem)) else None,
               "powerLimit": round(plim.value / 1000) if ok(L.nvmlDeviceGetPowerManagementLimit(d, ctypes.byref(plim))) else None,
               "maxClock": round(mclk.value / 1000, 2) if ok(L.nvmlDeviceGetMaxClockInfo(d, 0, ctypes.byref(mclk))) else None,
               "pcie": None, "tlimitMargin": None, "asleep": False}
        if ok(L.nvmlDeviceGetMaxPcieLinkGeneration(d, ctypes.byref(gen))) and ok(L.nvmlDeviceGetMaxPcieLinkWidth(d, ctypes.byref(width))):
            out["pcie"] = f"PCIe {gen.value}.0 ×{width.value}"
        # nvidia-smi temperature.gpu.tlimit: degrees left before the GPU slows itself down. Newer drivers expose it as
        # nvmlDeviceGetMarginTemperature; older ones only have the "GPU max" threshold (3), which gives the same margin.
        class _Margin(ctypes.Structure):
            _fields_ = [("version", ctypes.c_uint), ("margin", ctypes.c_int)]
        mg = _Margin(ctypes.sizeof(_Margin) | (1 << 24), 0)
        try:
            if ok(L.nvmlDeviceGetMarginTemperature(d, ctypes.byref(mg))):
                out["tlimitMargin"] = mg.margin
        except AttributeError:
            pass
        if out["tlimitMargin"] is None and ok(L.nvmlDeviceGetTemperatureThreshold(d, 3, ctypes.byref(slow))) \
                and ok(L.nvmlDeviceGetTemperature(d, 0, ctypes.byref(temp))):
            out["tlimitMargin"] = int(slow.value) - int(temp.value)
        _gpu_info_cache.clear()
        _gpu_info_cache.update({k: v for k, v in out.items() if k != "tlimitMargin"})
        return out
    finally:
        nv.shutdown()


# ======================================================================================= disks
def disks():
    """Physical disks (with SMART when running as administrator) and partitions with their space."""
    phys = ps_json(r"""
Get-PhysicalDisk | ForEach-Object {
  $r = $null; try { $r = $_ | Get-StorageReliabilityCounter -ErrorAction Stop } catch {}
  [pscustomobject]@{ id=$_.DeviceId; name=$_.FriendlyName; media="$($_.MediaType)"; bus="$($_.BusType)"; size=$_.Size; health="$($_.HealthStatus)"
    op="$($_.OperationalStatus)"; fw=$_.FirmwareVersion; spindle=$_.SpindleSpeed
    temp= if ($r) { $r.Temperature } else { $null }; tempMax= if ($r) { $r.TemperatureMax } else { $null }
    wear= if ($r) { $r.Wear } else { $null }; hours= if ($r) { $r.PowerOnHours } else { $null }; starts= if ($r) { $r.StartStopCycleCount } else { $null }
    readErr= if ($r) { $r.ReadErrorsTotal } else { $null }; writeErr= if ($r) { $r.WriteErrorsTotal } else { $null }; smart=[bool]$r }
}""", timeout=40, as_list=True)
    vols = ps_json(r"""
Get-Partition | Where-Object { $_.Type -ne 'Reserved' } | ForEach-Object { $v = $null; try { $v = $_ | Get-Volume -ErrorAction Stop } catch {}
  [pscustomobject]@{ disk=$_.DiskNumber; letter="$($_.DriveLetter)".Trim(); type="$($_.Type)"; size=$_.Size; hidden=[bool]$_.IsHidden -or -not $_.DriveLetter
    label= if ($v) { $v.FileSystemLabel } else { '' }; fs= if ($v) { $v.FileSystem } else { '' }; free= if ($v) { $v.SizeRemaining } else { $null } } }""",
                   timeout=30, as_list=True)
    trim = None
    try:
        out = subprocess.run(["fsutil", "behavior", "query", "DisableDeleteNotify"], capture_output=True, timeout=5,
                             creationflags=NO_WINDOW).stdout.decode("cp850", "replace")
        m = re.search(r"NTFS\s+DisableDeleteNotify\s*=\s*(\d)", out)
        trim = (m.group(1) == "0") if m else None
    except Exception:
        pass
    return {"physical": phys, "volumes": vols, "admin": _admin(), "trim": trim}


# ======================================================================================= network
def _netsh_wifi():
    try:
        raw = subprocess.run(["netsh", "wlan", "show", "interfaces"], capture_output=True, timeout=5,
                             creationflags=NO_WINDOW).stdout
        try:
            out = raw.decode("utf-8")  # netsh writes UTF-8 even when the console is cp850
        except UnicodeDecodeError:
            out = raw.decode("cp850", "replace")
    except Exception:
        return None
    d = {}
    for line in out.splitlines():
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        d[k.strip().lower()] = v.strip()
    pick = lambda *ks: next((d[k] for k in ks if k in d and d[k]), None)
    # netsh output is localized: the keys below cover English and Spanish Windows (they are parsing data, not UI)
    ssid = pick("ssid")
    if not ssid:
        return {"connected": False, "needsLocation": "ubicaci" in out.lower() or "location" in out.lower()}
    sig = pick("signal", "se\u00f1al")
    return {"connected": True, "ssid": ssid, "signal": int(re.sub(r"\D", "", sig)) if sig else None,
            "band": pick("band", "banda"), "channel": pick("channel", "canal"), "radio": pick("radio type", "tipo de radio"),
            "rx": pick("receive rate (mbps)", "velocidad de recepci\u00f3n (mbps)", "velocidad de recepcion (mbps)"),
            "tx": pick("transmit rate (mbps)", "velocidad de transmisi\u00f3n (mbps)", "velocidad de transmision (mbps)"),
            "auth": pick("authentication", "autenticaci\u00f3n", "autenticacion")}


def network():
    cfg = ps_json(r"""
Get-NetIPConfiguration | Where-Object { $_.NetAdapter.Status -eq 'Up' } | ForEach-Object {
  [pscustomobject]@{ alias=$_.InterfaceAlias; index=$_.InterfaceIndex; desc=$_.InterfaceDescription
    ipv4=@($_.IPv4Address | ForEach-Object { $_.IPAddress }); gw=@($_.IPv4DefaultGateway | ForEach-Object { $_.NextHop })
    dns=@($_.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses })
    dhcpDns=[bool]((Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$($_.NetAdapter.InterfaceGuid)" -ErrorAction SilentlyContinue).NameServer -eq '')
    mac=$_.NetAdapter.MacAddress; speed=$_.NetAdapter.LinkSpeed; media="$($_.NetAdapter.PhysicalMediaType)" } }""", timeout=30, as_list=True)
    apps = {}
    try:
        for c in psutil.net_connections("inet"):
            if c.pid and c.status == psutil.CONN_ESTABLISHED:
                apps[c.pid] = apps.get(c.pid, 0) + 1
    except (psutil.AccessDenied, OSError):
        pass
    byname = {}
    for pid, n in apps.items():
        try:
            p = psutil.Process(pid)
            name = p.name()
        except psutil.Error:
            continue
        try:
            exe = p.exe()
        except psutil.Error:  # protected (an antivirus, for example): still listed
            exe = ""
        where = exe or _find_exe(name)
        g = byname.setdefault(name.lower(), {"n": (_file_desc(where) if where else None) or os.path.splitext(name)[0], "exe": name, "conns": 0, "icon": None})
        g["conns"] += n
        if g["icon"] is None:
            g["icon"] = _proc_icon(name, exe, not exe or exe.lower().startswith(SYS_DIRS))
    top = sorted(byname.values(), key=lambda g: -g["conns"])[:8]
    for a in cfg:
        a["virtual"] = bool(re.search(r"hyper-v|virtualbox|vmware|wsl|tap-|wintun|loopback|virtual|vpn|zerotier|tailscale", (a.get("desc") or "") + " " + (a.get("alias") or ""), re.I))
        a["gw"] = [g for g in (a.get("gw") or []) if g]
    cfg.sort(key=lambda a: (a["virtual"], not a["gw"]))
    return {"adapters": cfg, "wifi": _netsh_wifi(), "apps": top, "admin": _admin()}


def public_ip():
    """Only called when the user clicks "show"."""
    import urllib.request
    try:
        with urllib.request.urlopen("https://api.ipify.org", timeout=5) as r:
            return r.read().decode().strip()
    except Exception:
        return None


def _dns_query_ms(server, name="www.microsoft.com"):
    q = os.urandom(2) + b"\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00"
    q += b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00\x00\x01\x00\x01"
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(2)
    try:
        t0 = time.perf_counter()
        s.sendto(q, (server, 53))
        s.recvfrom(512)
        return round((time.perf_counter() - t0) * 1000, 1)
    except OSError:
        return None
    finally:
        s.close()


def dns_test(router=None):
    out = {}
    for k, ip in (("router", router), ("cloudflare", "1.1.1.1"), ("google", "8.8.8.8")):
        if ip:
            vals = [x for x in (_dns_query_ms(ip) for _ in range(3)) if x is not None]
            out[k] = min(vals) if vals else None
    return out


DNS = {"cloudflare": ("1.1.1.1", "1.0.0.1"), "google": ("8.8.8.8", "8.8.4.4")}


def set_dns(alias, mode):
    """Changes the adapter's IPv4 DNS: 'auto' (the router's, DHCP), 'cloudflare' or 'google'. Needs administrator."""
    if not _admin():
        return {"needAdmin": True}
    alias = str(alias)
    if mode == "auto":
        cmds = [["netsh", "interface", "ipv4", "set", "dnsservers", f"name={alias}", "source=dhcp"]]
    elif mode in DNS:
        a, b = DNS[mode]
        cmds = [["netsh", "interface", "ipv4", "set", "dnsservers", f"name={alias}", "source=static", f"address={a}", "validate=no"],
                ["netsh", "interface", "ipv4", "add", "dnsservers", f"name={alias}", f"address={b}", "index=2", "validate=no"]]
    else:
        return {"ok": False, "error": tr("Unknown DNS mode.")}
    for c in cmds:
        r = subprocess.run(c, capture_output=True, timeout=15, creationflags=NO_WINDOW)
        if r.returncode != 0:
            return {"ok": False, "error": r.stdout.decode("cp850", "replace").strip() or tr("netsh failed.")}
    subprocess.run(["ipconfig", "/flushdns"], capture_output=True, timeout=10, creationflags=NO_WINDOW)
    return {"ok": True}


# ======================================================================================= battery
_bat = {"t": 0, "data": None}


def battery_report():
    """powercfg report: capacities, cycles and usage over the last 24 h (charge level and whether it was plugged in)."""
    if _bat["data"] and time.time() - _bat["t"] < 120:
        return _bat["data"]
    if psutil.sensors_battery() is None:
        return None
    path = os.path.join(tempfile.gettempdir(), f"sh_battery_{os.getpid()}.xml")
    try:
        subprocess.run(["powercfg", "/batteryreport", "/xml", "/output", path], capture_output=True, timeout=30, creationflags=NO_WINDOW)
        root = ET.parse(path).getroot()
    except Exception:
        return None
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    ns = {"b": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
    f = (lambda e, tag: e.find(f"b:{tag}", ns)) if ns else (lambda e, tag: e.find(tag))
    txt = lambda e: e.text.strip() if e is not None and e.text else None
    bat = root.find(".//b:Battery", ns) if ns else root.find(".//Battery")
    info = {}
    if bat is not None:
        for tag in ("Id", "Manufacturer", "Chemistry", "DesignCapacity", "FullChargeCapacity", "CycleCount"):
            info[tag] = txt(f(bat, tag))
    usage = []
    cut = time.time() - 24 * 3600
    for e in (root.findall(".//b:RecentUsage/b:UsageEntry", ns) if ns else root.findall(".//RecentUsage/UsageEntry")):
        ts = e.get("LocalTimestamp") or e.get("Timestamp")
        try:
            t = time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
        except (TypeError, ValueError):
            continue
        cap, full = e.get("ChargeCapacity"), e.get("FullChargeCapacity")
        if t < cut or not cap or not full or int(full) == 0:
            continue
        usage.append({"t": t, "pct": round(int(cap) / int(full) * 100, 1), "ac": e.get("Ac") == "1", "state": e.get("EntryType")})
    num = lambda s: int(s) if s and s.isdigit() else None
    data = {"name": info.get("Id"), "maker": info.get("Manufacturer"), "chemistry": info.get("Chemistry"),
            "design": num(info.get("DesignCapacity")), "full": num(info.get("FullChargeCapacity")),
            "cycles": num(info.get("CycleCount")), "usage": usage}
    _bat.update(t=time.time(), data=data)
    return data


# ======================================================================================= health
# device problem codes and System log events explained in plain words (English keys; translated with tr() when sent)
CM_CODES = {1: "Not configured correctly", 3: "The driver is damaged or the system is low on memory", 10: "Could not start",
            12: "Not enough free resources", 14: "Needs a restart", 18: "The driver needs to be reinstalled",
            19: "Registry configuration is damaged", 22: "Disabled", 24: "Not present or not working properly",
            28: "No driver installed", 31: "Windows could not load the driver",
            43: "Windows stopped it because it reported a problem", 45: "Disconnected", 52: "The driver signature is not valid"}
EVENT_HELP = {
    ("Microsoft-Windows-Kernel-Power", 41): "The PC turned off without shutting down properly: a power cut, a drained battery or a held power button.",
    ("EventLog", 6008): "Unexpected shutdown recorded at the next startup.",
    ("Microsoft-Windows-WER-SystemErrorReporting", 1001): "There was a blue screen. The code tells what caused it.",
    ("Display", 4101): "The display driver stopped responding and recovered. If it keeps happening, update it.",
    ("Microsoft-Windows-WHEA-Logger", 17): "Corrected hardware error (PCI Express). Only a concern if it shows up often.",
    ("Microsoft-Windows-WHEA-Logger", 19): "Corrected hardware error in the processor.",
    ("Microsoft-Windows-WHEA-Logger", 47): "Corrected memory error.",
    ("disk", 7): "The disk has a bad block. It is worth checking its health.",
    ("disk", 153): "A disk operation had to be retried.",
    ("Ntfs", 55): "The file system structure is damaged: running chkdsk is recommended.",
    ("Service Control Manager", 7000): "A service could not start.",
    ("Service Control Manager", 7001): "A service did not start because it depends on another one that failed.",
    ("Service Control Manager", 7023): "A service stopped with an error.",
    ("Service Control Manager", 7031): "A service closed unexpectedly and Windows restarted it.",
    ("Service Control Manager", 7034): "A service closed unexpectedly.",
    ("Microsoft-Windows-DistributedCOM", 10016): "Internal Windows permissions notice. It is common and does not affect use.",
    ("Microsoft-Windows-DistributedCOM", 10010): "A Windows component was slow to respond. Usually harmless.",
    ("volmgr", 161): "The memory dump could not be created when the system failed.",
    ("Microsoft-Windows-Kernel-Boot", 29): "Windows could not start on the first attempt.",
    ("Microsoft-Windows-WindowsUpdateClient", 20): "A Windows update could not be installed.",
    ("Microsoft-Windows-Time-Service", 129): "The clock could not be synced with the internet.",
    ("Netwtw10", 5002): "Wi-Fi dropped for a moment.",
    ("rtwlane", 5002): "Wi-Fi dropped for a moment.",
}


def health():
    r = ps_json(r"""
$err = @(Get-CimInstance Win32_PnPEntity -Filter 'ConfigManagerErrorCode<>0' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ name=$_.Name; code=$_.ConfigManagerErrorCode; cls=$_.PNPClass; id=$_.PNPDeviceID } })
$cls = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Group-Object Class | ForEach-Object { [pscustomobject]@{ cls=$_.Name; n=$_.Count; bad=@($_.Group | Where-Object { $_.Status -ne 'OK' }).Count } })
$ev = @(Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2; StartTime=(Get-Date).AddDays(-7)} -MaxEvents 60 -ErrorAction SilentlyContinue | ForEach-Object {
  [pscustomobject]@{ src=$_.ProviderName; id=$_.Id; level=$_.Level; t=$_.TimeCreated.ToString('o'); msg=(($_.Message -split "`n")[0]).Trim() } })
$os = Get-CimInstance Win32_OperatingSystem
$fast = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -ErrorAction SilentlyContinue).HiberbootEnabled
[pscustomobject]@{ errors=$err; classes=$cls; events=$ev; boot=$os.LastBootUpTime.ToString('o'); fastStartup=($fast -eq 1) }""", timeout=60) or {}
    errs = r.get("errors") or []
    if isinstance(errs, dict):
        errs = [errs]
    for e in errs:
        c = e.get("code")
        e["why"] = tr(CM_CODES[c]) if c in CM_CODES else tr("Error code {code}", code=c)
    evs = r.get("events") or []
    if isinstance(evs, dict):
        evs = [evs]
    grouped = {}
    for e in evs:
        k = (e.get("src"), e.get("id"))
        g = grouped.get(k)
        if g:
            g["count"] += 1
            continue
        e["count"] = 1
        e["help"] = tr(EVENT_HELP[k]) if k in EVENT_HELP else None
        grouped[k] = e
    cls = r.get("classes") or []
    if isinstance(cls, dict):
        cls = [cls]
    return {"errors": errs, "classes": cls, "events": list(grouped.values())[:12], "boot": r.get("boot"),
            "fastStartup": r.get("fastStartup"), "admin": _admin()}
