"""StellarHub window (pywebview + WebView2) and the API the UI sees."""
import ctypes
import hashlib
import json
import os
import shutil
import sys
import threading
import time

from . import VERSION
from . import paths
from .i18n import tr

APP_ID = "StellarHub.App"
BG = "#060A14"


def base_dir():
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


UI_DIR = os.path.join(base_dir(), "stellarhub", "ui")
PORTABLE = paths.PORTABLE  # the portable version keeps everything in a Data folder next to the program
DATA_DIR = paths.data_dir()
WEB_DIR = os.path.join(paths.local_dir(), "webview")
# STELLARHUB_ISOLATED=1: a test copy that runs next to the user's (own lock, ports and browser profile)
ISOLATED = os.environ.get("STELLARHUB_ISOLATED") == "1"
if ISOLATED:
    import tempfile
    WEB_DIR = os.path.join(tempfile.gettempdir(), f"stellarhub_isolated_{os.getpid()}")
SETTINGS = os.path.join(DATA_DIR, "settings.json")


FROZEN = bool(getattr(sys, "frozen", False))  # running as the installed StellarHub.exe


def _migrate_store_python_data():
    """Python from the Microsoft Store keeps %APPDATA% in a private copy (LocalCache, Roaming). When the
    installed StellarHub.exe starts for the first time and the real folder has no settings, it brings over
    the settings and the Autopilot log a source run left there, so nothing is lost when switching."""
    if os.path.exists(SETTINGS) or PORTABLE:
        return
    pkgs = os.path.join(os.environ.get("LOCALAPPDATA") or "", "Packages")
    try:
        cands = [os.path.join(pkgs, d, "LocalCache", "Roaming", "StellarHub") for d in os.listdir(pkgs)
                 if d.startswith("PythonSoftwareFoundation.Python.")]
    except OSError:
        return
    cands = [c for c in cands if os.path.isfile(os.path.join(c, "settings.json"))]
    if not cands:
        return
    src = max(cands, key=lambda c: os.path.getmtime(os.path.join(c, "settings.json")))
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        shutil.copy2(os.path.join(src, "settings.json"), SETTINGS)
        if os.path.isdir(os.path.join(src, "autopilot")):
            shutil.copytree(os.path.join(src, "autopilot"), os.path.join(DATA_DIR, "autopilot"), dirs_exist_ok=True)
    except OSError:
        pass


def _read_settings():
    try:
        with open(SETTINGS, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def is_admin():
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _gui_python():
    """pythonw.exe if it exists, so relaunching does not open a console."""
    exe = sys.executable
    if not getattr(sys, "frozen", False) and exe.lower().endswith("python.exe"):
        w = exe[:-10] + "pythonw.exe"
        if os.path.exists(w):
            return w
    return exe


class Api:
    """Everything public in this class can be called from JS as window.pywebview.api.<name>."""

    def __init__(self):
        self._window = None
        self._chrome = None
        self._widget = None
        self._tray = None
        self._panel = None          # the tray panel (left click on the tray icon), created on first use
        self._panel_ready = False
        self._panel_shown = False
        self._panel_hidden_at = 0.0
        self._sampler = None
        self._visible = True
        self._quitting = False
        self._told_tray = False
        self._lock = threading.Lock()

    def _attach(self, window):
        self._window = window

    # ---------- information ----------
    def info(self):
        return {"version": VERSION, "admin": is_admin(), "portable": PORTABLE}

    def ui_ready(self):
        """The interface finished its first frame: logs how long the start took, from the process launch."""
        try:
            import psutil
            secs = time.time() - psutil.Process().create_time()
            print(f"[startup] interface ready in {secs:.2f} s ({'installed' if FROZEN else 'source'}, "
                  f"{'administrator' if is_admin() else 'normal'})", flush=True)
        except Exception:
            pass

    # ---------- settings ----------
    def settings_get(self):
        try:
            with open(SETTINGS, encoding="utf-8") as fh:
                data = json.load(fh)
                return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def settings_set(self, changes):
        if not isinstance(changes, dict):
            return False
        with self._lock:
            data = self.settings_get()
            data.update(changes)
            os.makedirs(DATA_DIR, exist_ok=True)
            tmp = SETTINGS + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, SETTINGS)
        if "language" in changes:
            self._language_changed(changes["language"])
        return True

    def _language_changed(self, pref):
        """New interface language: the engine and tray follow, and the widget reloads in the new language
        (the main window reloads itself)."""
        from . import i18n
        i18n.set_language(pref)
        if self._tray is not None and hasattr(self._tray, "rebuild"):
            try:
                self._tray.rebuild()
            except Exception:
                pass
        if self._widget is not None:
            self._js(f"try{{localStorage.setItem('sh.lang', {json.dumps(pref or 'auto')})}}catch(e){{}};location.reload()", self._widget)

    # ---------- custom window frame ----------
    def win_drag(self):
        self._chrome and self._chrome.drag()

    def win_resize(self, edge):
        self._chrome and self._chrome.resize(edge)

    def win_toggle_max(self):
        return self._chrome.toggle_max() if self._chrome else False

    def win_min(self):
        self._chrome and self._chrome.minimize()

    def win_close(self):
        self.close_main()

    def win_state(self):
        return {"max": bool(self._chrome and self._chrome.max), "frameless": self._chrome is not None}

    # ---------- window ----------
    def set_zoom(self, factor):
        """Real WebView2 zoom (the same as Ctrl + wheel), not CSS scaling."""
        try:
            factor = max(0.75, min(2.0, float(factor)))
            form = self._window.native
            from System import Action  # pythonnet, ships with pywebview

            def apply():
                form.webview.ZoomFactor = factor

            form.Invoke(Action(apply))
            return True
        except Exception:
            return False

    def relaunch_admin(self):
        """Opens an elevated copy and closes this one. If the user says no in UAC, nothing changes."""
        if is_admin():
            return True
        # the elevated copy waits for this one to exit (it frees the single-instance lock and the WebView2 data)
        args = [a for a in sys.argv[1:] if a not in ("--tray",)]
        if "--wait-pid" in args:
            i = args.index("--wait-pid")
            del args[i:i + 2]
        args += ["--wait-pid", str(os.getpid())]
        params = " ".join(f'"{a}"' for a in args)
        if not getattr(sys, "frozen", False):
            params = f'"{os.path.join(base_dir(), "run.py")}" {params}'
        r = ctypes.windll.shell32.ShellExecuteW(None, "runas", _gui_python(), params, base_dir(), 1)
        if r > 32:
            threading.Timer(0.05, self.quit).start()
            return True
        return False

    # ---------- close, hide in the tray and quit ----------
    def _js(self, code, target=None):
        """Notifies the UI WITHOUT waiting. evaluate_js waits for WebView2's reply, which arrives on the window
        thread: called from that thread (events, Invoke, resizing) it would block it forever."""
        w = target or self._window

        def run():
            try:
                w.evaluate_js(code)
            except Exception:
                pass
        threading.Thread(target=run, daemon=True).start()

    def close_main(self):
        """The X: with "close to the tray" on it only hides the window; otherwise it quits the app."""
        if self._tray is not None and self.settings_get().get("trayOnClose", True):
            self._window.hide()
            self._visible = False
            self._tele_refresh()
            if not self._told_tray:
                self._told_tray = True
                self._tray.notify(tr("StellarHub is still running in the tray. Open it from here, or right-click > Quit to exit."))
            return "hidden"
        self.quit()
        return "quit"

    def quit(self):
        self._quitting = True
        if self._sampler:
            self._sampler.stop()
        try:
            from .engine import autopilot
            autopilot.stop()
        except Exception:
            pass
        self.widget_close()
        if self._tray is not None:
            self._tray.stop()
        threading.Timer(0.05, lambda: self._window.destroy()).start()
        return True

    def _on_closing(self):
        """Alt+F4 or closing from the taskbar: same as the X. It runs on the window thread, so it decides
        and cancels right away; hiding or quitting happens afterwards, off this thread."""
        if self._quitting:
            return True
        if self._tray is not None and self.settings_get().get("trayOnClose", True):
            threading.Timer(0.01, self.close_main).start()
            return False
        threading.Timer(0.01, self.quit).start()
        return False

    def show_main(self):
        self._visible = True
        self._tele_refresh()
        try:
            self._window.show()
            self._window.restore()
            if self._chrome and not getattr(self._chrome, "_done", False):
                self._chrome.setup(start_max=True)
                _grant_media(self._window)
            elif self._chrome and self._chrome.max:
                self._chrome._ui(self._chrome._maximize)
            from System import Action
            form = self._window.native
            form.BeginInvoke(Action(lambda: (form.Activate(), form.BringToFront())))
        except Exception:
            pass
        return True

    def set_autostart(self, on):
        """Open with Windows (minimized to the tray): an entry in HKCU\\...\\Run."""
        if PORTABLE and on:
            return False  # a USB drive is not always there: the portable version doesn't add itself to startup
        import winreg
        key = r"Software\Microsoft\Windows\CurrentVersion\Run"
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_SET_VALUE) as k:
                if on:
                    winreg.SetValueEx(k, "StellarHub", 0, winreg.REG_SZ, _autostart_cmd())
                else:
                    try:
                        winreg.DeleteValue(k, "StellarHub")
                    except FileNotFoundError:
                        pass
            return True
        except OSError:
            return False

    # ---------- always-on-top widget ----------
    def widget_toggle(self, width=400, height=190):
        """Opens or closes the widget. Returns True if it ends up open."""
        import webview
        if self._widget is not None:
            self.widget_close()
            return False
        w, h = max(160, min(1100, int(width or 400))), max(32, min(600, int(height or 190)))
        x = y = None
        try:
            scr = webview.screens[0]
            x, y = scr.width - w - 28, 72
        except Exception:
            pass
        self._widget = webview.create_window(
            tr("StellarHub widget"), url=os.path.join(UI_DIR, "widget.html"), js_api=self,
            width=w, height=h, x=x, y=y, frameless=True, easy_drag=True, on_top=True, min_size=(120, 30),
            resizable=False, background_color=BG, focus=False,
        )
        wref = self._widget
        self._widget.events.closed += lambda: self._widget_gone(wref)
        self._widget.events.shown += lambda: (_round_corners(wref), self._widget_keep_on_top(wref))
        self.settings_set({"widgetWasOpen": True})
        self._tele_refresh()
        self._tray and self._tray.refresh()
        self._js("SH.emit('widget', {on: true})")
        return True

    def _widget_keep_on_top(self, w):
        """The taskbar is also "always on top" and, when touched, it jumps in front of everything.
        - Tool window: shows on every virtual desktop and does not appear in Alt+Tab.
        - A thread puts it back on top every so often (without activating or moving it) while the widget exists."""
        try:
            hwnd = w.native.Handle.ToInt32()
        except Exception:
            return
        u = ctypes.windll.user32
        GWL_EXSTYLE, WS_EX_TOOLWINDOW, WS_EX_APPWINDOW = -20, 0x00000080, 0x00040000
        try:
            u.GetWindowLongPtrW.restype = ctypes.c_ssize_t
            u.SetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_ssize_t]
            ex = u.GetWindowLongPtrW(ctypes.c_void_p(hwnd), GWL_EXSTYLE)
            u.SetWindowLongPtrW(ctypes.c_void_p(hwnd), GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW)
        except Exception as e:
            print("widget style:", e)
        HWND_TOPMOST = ctypes.c_void_p(-1)
        FLAGS = 0x0001 | 0x0002 | 0x0010 | 0x0200  # NOSIZE | NOMOVE | NOACTIVATE | NOOWNERZORDER

        def keep():
            while self._widget is w and not self._quitting:
                try:
                    u.SetWindowPos(ctypes.c_void_p(hwnd), HWND_TOPMOST, 0, 0, 0, 0, FLAGS)
                except Exception:
                    break
                time.sleep(0.35)
        threading.Thread(target=keep, daemon=True, name="widget-top").start()

    def _widget_gone(self, w=None):
        if w is not None and self._widget is not w:
            return  # it was an earlier widget that has already been replaced
        self._widget = None
        self._tray and self._tray.refresh()
        self._js("SH.emit('widget', {on: false})")

    def widget_close(self):
        """It closes a moment after replying: if the call comes from the widget itself, destroying it
        while pywebview is still returning the result to it can leave it hanging."""
        w = self._widget
        self._widget = None
        if w is not None:
            def kill():
                try:
                    w.destroy()
                except Exception:
                    pass
            threading.Timer(0.08, kill).start()
        self.settings_set({"widgetWasOpen": False}) if not self._quitting else None
        self._tele_refresh()
        self._tray and self._tray.refresh()
        self._js("SH.emit('widget', {on: false})")
        return True

    def widget_mode(self, mode):
        """The widget's own small/large button: saves it and tells the main window."""
        mode = "mini" if mode == "mini" else "full"
        self.settings_set({"widgetMode": mode})
        self._js(f"SH.state.settings.widgetMode='{mode}'; SH.emit('widget-mode','{mode}')")
        return mode

    def widget_is_open(self):
        return self._widget is not None

    def widget_update(self, conf):
        """Widget settings changed in the main window: applied instantly."""
        if self._widget is not None:
            self._js(f"window.SH && SH.widgetApply && SH.widgetApply({json.dumps(conf)})", self._widget)
        return True

    def widget_resize(self, width, height):
        """Resizes it keeping the top-right corner fixed (the widget usually lives on the right)."""
        if self._widget is not None:
            try:
                from webview.window import FixPoint
                self._widget.resize(int(width), int(height), fix_point=FixPoint.NORTH | FixPoint.EAST)
            except Exception as e:
                print("widget_resize:", e)
        return True

    def widget_limits(self, min_w, min_h, max_w, max_h):
        """Smallest and largest size the user can drag the widget to (device pixels), computed by the widget
        from what it shows. Windows enforces them during the resize loop."""
        w = self._widget
        if w is None:
            return False
        try:
            from System import Action
            from System.Drawing import Size
            form = w.native

            def apply():
                form.MinimumSize = Size(int(min_w), int(min_h))
                form.MaximumSize = Size(int(max_w), int(max_h))
            form.BeginInvoke(Action(apply))
            return True
        except Exception as e:
            print("widget_limits:", e)
            return False

    def widget_drag_resize(self, edge):
        """The user drags an edge of the widget: Windows' own resize loop (smooth, like any window).
        When it ends, the new size is saved for that widget size mode so it is kept next time."""
        w = self._widget
        hit = {"w": 10, "e": 11, "n": 12, "nw": 13, "ne": 14, "s": 15, "sw": 16, "se": 17}.get(edge)
        if w is None or not hit:
            return False
        try:
            from System import Action
            form = w.native
            u = ctypes.windll.user32

            def go():
                if not (u.GetAsyncKeyState(0x01) & 0x8000):
                    return  # the button was already released: do not start a loop stuck to the cursor
                u.ReleaseCapture()
                u.SendMessageW(form.Handle.ToInt32(), 0x00A1, hit, 0)  # WM_NCLBUTTONDOWN: blocks until released
                mode = self.settings_get().get("widgetMode") or "full"
                self.settings_set({f"widgetSize_{mode}": [w.width, w.height]})
                self._js("window.SH && SH.widgetResized && SH.widgetResized()", w)
            form.BeginInvoke(Action(go))
            return True
        except Exception as e:
            print("widget_drag_resize:", e)
            return False

    # ---------- tray panel (left click on the tray icon) ----------
    PANEL_W, PANEL_H = 344, 452  # CSS pixels

    def tray_panel_toggle(self):
        """Shows the panel above the tray icon, or hides it if it is showing."""
        if self._panel_shown:
            return self.panel_hide()
        if time.time() - self._panel_hidden_at < 0.35:
            return False  # the click that just took the focus away from it: leave it closed
        if self._panel is None:
            self._panel_create()
            return True
        if self._panel_ready:
            self._panel_place_and_show()
        return True

    def _panel_create(self):
        import webview
        self._panel = webview.create_window(
            "StellarHub", url=os.path.join(UI_DIR, "tray.html"), js_api=self, width=self.PANEL_W, height=self.PANEL_H,
            frameless=True, easy_drag=False, on_top=True, resizable=False, hidden=True, focus=True, background_color=BG)
        pw = self._panel

        def loaded():
            if self._panel_ready:
                return
            self._panel_ready = True
            self._panel_setup(pw)
            self._panel_place_and_show()
        pw.events.loaded += loaded
        pw.events.closed += lambda: setattr(self, "_panel", None) or setattr(self, "_panel_ready", False)

    def _panel_setup(self, pw):
        """Tool window (no taskbar button, no Alt+Tab), rounded corners, and hide as soon as it loses focus."""
        try:
            from System import Action, EventHandler
            form = pw.native
            hwnd = form.Handle.ToInt32()
            u = ctypes.windll.user32
            u.GetWindowLongPtrW.restype = ctypes.c_ssize_t
            u.SetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_ssize_t]
            ex = u.GetWindowLongPtrW(ctypes.c_void_p(hwnd), -20)
            u.SetWindowLongPtrW(ctypes.c_void_p(hwnd), -20, (ex | 0x00000080) & ~0x00040000)
            _round_corners(pw)

            def on_deactivate(sender, args):
                if self._panel_shown:
                    self._panel_shown = False
                    self._panel_hidden_at = time.time()
                    form.Hide()
            form.BeginInvoke(Action(lambda: form.add_Deactivate(EventHandler(on_deactivate))))
        except Exception as e:
            print("tray panel setup:", e)

    def _panel_place_and_show(self):
        """Above the tray (or next to it when the taskbar is on a side), inside the work area of the monitor
        under the cursor, in device pixels for that monitor's scaling."""
        pw = self._panel
        if pw is None:
            return
        try:
            from System import Action
            import ctypes.wintypes as wt
            u = ctypes.windll.user32
            pt = wt.POINT()
            u.GetCursorPos(ctypes.byref(pt))
            mon = u.MonitorFromPoint(pt, 2)

            class MONITORINFO(ctypes.Structure):
                _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]
            mi = MONITORINFO()
            mi.cbSize = ctypes.sizeof(mi)
            u.GetMonitorInfoW(mon, ctypes.byref(mi))
            dx, dy = ctypes.c_uint(96), ctypes.c_uint(96)
            try:
                ctypes.windll.shcore.GetDpiForMonitor(mon, 0, ctypes.byref(dx), ctypes.byref(dy))
            except Exception:
                pass
            k = dx.value / 96
            w, h = int(self.PANEL_W * k), int(self.PANEL_H * k)
            wa, m = mi.rcWork, int(10 * k)
            if pt.y >= wa.bottom:      # taskbar at the bottom (the usual)
                x, y = pt.x - w // 2, wa.bottom - h - m
            elif pt.y <= wa.top:       # at the top
                x, y = pt.x - w // 2, wa.top + m
            elif pt.x >= wa.right:     # on the right
                x, y = wa.right - w - m, pt.y - h // 2
            else:                      # on the left (or the panel was opened another way)
                x, y = wa.left + m, pt.y - h // 2
            x = max(wa.left + m, min(x, wa.right - w - m))
            y = max(wa.top + m, min(y, wa.bottom - h - m))
            form = pw.native
            tray_hwnd = getattr(getattr(self._tray, "icon", None), "_hwnd", None)

            def show():
                hwnd = form.Handle.ToInt32()
                if tray_hwnd:  # the tray click lets this process take the foreground: hand it to the panel
                    u.SetForegroundWindow(ctypes.c_void_p(tray_hwnd))
                u.SetWindowPos(ctypes.c_void_p(hwnd), ctypes.c_void_p(-1), x, y, w, h, 0x0040)  # TOPMOST, SHOWWINDOW
                form.Show()
                form.Activate()
                u.SetForegroundWindow(ctypes.c_void_p(hwnd))
            self._panel_shown = True
            form.BeginInvoke(Action(show))
            self._tele_refresh()
            self._js("window.SH && SH.panelShown && SH.panelShown()", pw)
        except Exception as e:
            print("tray panel:", e)

    def panel_hide(self):
        pw = self._panel
        if pw is None or not self._panel_shown:
            return False
        self._panel_shown = False
        self._panel_hidden_at = time.time()
        try:
            from System import Action
            form = pw.native
            form.BeginInvoke(Action(form.Hide))
        except Exception:
            pass
        return True

    def panel_go(self, mod=None, tab=None):
        """From the panel: open the main window (on a module, a tab or the settings)."""
        self.panel_hide()
        self.show_main()
        if mod == "settings":
            self._js("SH.go('settings')")
        elif mod:
            t = f", {{tab: {json.dumps(tab)}}}" if tab else ""
            self._js(f"SH.go({json.dumps(mod)}{t})")
        return True

    def log_js_error(self, msg):
        """UI errors go to the log (stellarhub.log), to help diagnose problems."""
        print("[ui]", str(msg)[:2000], flush=True)
        return True

    # ---------- real engine ----------
    def engine(self, mod, fn, args=None):
        """SH.engine(mod, fn, ...args): quick call into stellarhub/engine/<mod>.py (only what is in EXPORTS)."""
        from . import engine as E
        try:
            return {"ok": True, "data": E.resolve(mod, fn, "call")(*(args or []))}
        except Exception as e:
            import traceback
            print(f"[engine {mod}.{fn}]", traceback.format_exc())
            return {"ok": False, "error": str(e)}

    def engine_job(self, mod, fn, args=None):
        """SH.job(...): long task; progress arrives as SH.emit('job', ...). Returns the task id."""
        from . import engine as E
        from .engine import jobs
        try:
            return {"ok": True, "id": jobs.start(f"{mod}.{fn}", E.resolve(mod, fn, "job"), *(args or []))}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def job_cancel(self, job_id):
        from .engine import jobs
        return jobs.cancel(job_id)

    def pc_info(self):
        from .engine import system
        return system.pc_info()

    def screen_thumb(self, index=0, width=480):
        from .engine import system
        try:
            return system.screen_thumb(index, width)
        except Exception:
            return None

    def tele_rate(self, ms):
        if self._sampler:
            self._sampler.set_rate(float(ms) / 1000)
        return True

    def _tele_push(self, data):
        """Each telemetry sample goes to the main window (if visible) and to the widget (if open).
        Called from the sampler thread, never from the window thread."""
        payload = json.dumps(data)
        if self._visible:
            try:
                self._window.evaluate_js(f"window.SH && SH.tele.push && SH.tele.push({payload})")
            except Exception:
                pass
        w = self._widget
        if w is not None:
            try:
                w.evaluate_js(f"window.SH && SH.tele.push && SH.tele.push({payload})")
            except Exception:
                pass
        pw = self._panel
        if pw is not None and self._panel_shown:
            try:
                pw.evaluate_js(f"window.SH && SH.tele.push && SH.tele.push({payload})")
            except Exception:
                pass

    def _tele_refresh(self):
        if self._sampler:
            stats = self.settings_get().get("widgetStats") or []
            gpu_in_widget = any(s.startswith("gpu") or s == "vram" for s in stats)
            self._sampler.set_active(self._visible or self._widget is not None,
                                     gpu=self._visible or (self._widget is not None and gpu_in_widget))

    # ---------- permanent administrator mode ----------
    def set_always_admin(self, on):
        """With this on, StellarHub always opens as administrator. A scheduled task with highest privileges is
        used so Windows does not ask at every start (creating it does require admin)."""
        self.settings_set({"alwaysAdmin": bool(on)})
        if on and is_admin():
            return _ensure_admin_task()
        if not on:
            _delete_admin_task()
        return True

    # ---------- about ----------
    def project_stats(self):
        """Bytes of code per language, like GitHub's language bar."""
        if FROZEN:  # the installed app has no .py files: the build saved the numbers
            try:
                with open(os.path.join(base_dir(), "stellarhub", "project_stats.json"), encoding="utf-8") as fh:
                    return json.load(fh)
            except (OSError, ValueError):
                pass
        langs = {".py": "Python", ".js": "JavaScript", ".css": "CSS", ".html": "HTML"}
        out = {}
        root = os.path.join(base_dir(), "stellarhub")
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in ("vendor", "fonts", "__pycache__")]
            for f in files:
                lang = langs.get(os.path.splitext(f)[1].lower())
                if lang:
                    try:
                        out[lang] = out.get(lang, 0) + os.path.getsize(os.path.join(dirpath, f))
                    except OSError:
                        pass
        return out

    # ---------- Windows tools and data ----------
    TOOLS = {
        "devmgmt": "devmgmt.msc", "services": "services.msc", "eventvwr": "eventvwr.msc", "taskschd": "taskschd.msc",
        "diskmgmt": "diskmgmt.msc", "regedit": "regedit.exe", "msconfig": "msconfig.exe", "msinfo32": "msinfo32.exe",
        "resmon": "resmon.exe", "control": "control.exe", "powercfg": "powercfg.cpl", "sysdm": "sysdm.cpl",
        "ncpa": "ncpa.cpl", "appwiz": "appwiz.cpl", "perf": "SystemPropertiesPerformance.exe", "cleanmgr": "cleanmgr.exe",
        "dfrgui": "dfrgui.exe", "rstrui": "rstrui.exe", "taskmgr": "taskmgr.exe", "cmd": "cmd.exe", "powershell": "powershell.exe",
    }

    def run_tool(self, name):
        exe = self.TOOLS.get(name)
        if not exe:
            return False
        try:
            os.startfile(exe)
            return True
        except OSError:
            return False

    def open_data_dir(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        os.startfile(DATA_DIR)
        return True

    def export_settings(self):
        import webview
        r = self._window.create_file_dialog(webview.SAVE_DIALOG, save_filename="StellarHub-settings.json",
                                            file_types=(tr("StellarHub settings") + " (*.json)",))
        if not r:
            return None
        path = r if isinstance(r, str) else r[0]
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(self.settings_get(), fh, ensure_ascii=False, indent=2)
        return path

    def import_settings(self):
        import webview
        r = self._window.create_file_dialog(webview.OPEN_DIALOG, file_types=(tr("StellarHub settings") + " (*.json)",))
        if not r:
            return None
        try:
            with open(r[0], encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            return False
        if not isinstance(data, dict):
            return False
        self.settings_set(data)
        return data

    def reset_settings(self):
        """Returns the saved settings (so it can be undone) and deletes them."""
        old = self.settings_get()
        try:
            os.remove(SETTINGS)
        except OSError:
            pass
        return old

    def open_url(self, url):
        if isinstance(url, str) and url.startswith(("https://", "http://", "ms-settings:")):
            os.startfile(url)
            return True
        return False


def refresh_ui_cache():
    """WebView2 keeps the .js/.css in its HTTP cache: after a UI change it would keep showing the old one.
    If any UI file changes, that cache is cleared."""
    h = hashlib.sha1()
    if FROZEN:  # installed: the UI only changes with a new build, so the version and build time identify it
        try:
            h.update(f"{VERSION}|{os.path.getmtime(sys.executable)}".encode())
        except OSError:
            h.update(VERSION.encode())
    for root, _dirs, files in ([] if FROZEN else sorted(os.walk(UI_DIR))):
        for f in sorted(files):
            if f.endswith((".html", ".js", ".css")):
                p = os.path.join(root, f)
                h.update(p[len(UI_DIR):].encode())
                try:
                    with open(p, "rb") as fh:
                        h.update(fh.read())
                except OSError:
                    pass
    stamp = os.path.join(WEB_DIR, "ui.version")
    try:
        with open(stamp, encoding="utf-8") as fh:
            if fh.read().strip() == h.hexdigest():
                return
    except OSError:
        pass
    for sub in (("EBWebView", "Default", "Cache"), ("EBWebView", "Default", "Code Cache")):
        shutil.rmtree(os.path.join(WEB_DIR, *sub), ignore_errors=True)
    try:
        os.makedirs(WEB_DIR, exist_ok=True)
        with open(stamp, "w", encoding="utf-8") as fh:
            fh.write(h.hexdigest())
    except OSError:
        pass


def _round_corners(window):
    """Windows 11 rounded corners for frameless windows, with a subtle edge drawn by Windows
    (the widget UI draws no border of its own, so there is no double frame at the corners)."""
    try:
        hwnd = window.native.Handle.ToInt32()
        dwm = ctypes.windll.dwmapi
        pref = ctypes.c_int(2)  # DWMWCP_ROUND
        dwm.DwmSetWindowAttribute(hwnd, 33, ctypes.byref(pref), 4)
        border = ctypes.c_int(0x00473A2C)  # #2C3A47 in BGR
        dwm.DwmSetWindowAttribute(hwnd, 34, ctypes.byref(border), 4)
    except Exception:
        pass


def _grant_media(window):
    """Camera and microphone for StellarHub's own UI (Device Tester) without the browser prompt.
    The only thing that can block them is Windows privacy, and the app links to those settings."""
    state = {"done": False}

    def hook():
        """Runs on the window thread (WebView2 can only be touched from there). Returns True if it got hooked."""
        if state["done"]:
            return True
        form = window.native
        core = form.webview.CoreWebView2
        if core is None:
            return False
        from Microsoft.Web.WebView2.Core import CoreWebView2PermissionKind as K, CoreWebView2PermissionState as St

        def on_perm(sender, args):
            local = str(args.Uri).startswith(("http://127.0.0.1", "http://localhost"))
            if local and args.PermissionKind in (K.Camera, K.Microphone, K.ClipboardRead, K.Notifications):
                args.State = St.Allow
        core.PermissionRequested += on_perm
        state["done"] = True
        return True

    def wait_and_hook():
        import time
        from System import Func, Boolean
        form = window.native
        for _ in range(100):
            try:
                if form.Invoke(Func[Boolean](hook)):
                    return
            except Exception as e:
                print("permissions:", e)
                return
            time.sleep(0.15)
    threading.Thread(target=wait_and_hook, daemon=True).start()


def style_titlebar(window):
    """Dark title bar in the same color as the background (Windows 11)."""
    try:
        hwnd = window.native.Handle.ToInt32()
        dwm = ctypes.windll.dwmapi
        on = ctypes.c_int(1)
        dwm.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(on), 4)  # dark mode
        r, g, b = int(BG[1:3], 16), int(BG[3:5], 16), int(BG[5:7], 16)
        color = ctypes.c_int(r | (g << 8) | (b << 16))
        dwm.DwmSetWindowAttribute(hwnd, 35, ctypes.byref(color), 4)  # title background
        text = ctypes.c_int(0x00F6EDE8)
        dwm.DwmSetWindowAttribute(hwnd, 36, ctypes.byref(text), 4)  # title text
    except Exception:
        pass


def _log_to_file():
    """With pythonw there is no console: errors go to %APPDATA%\\StellarHub\\stellarhub.log."""
    if sys.stderr is None or "pythonw" in os.path.basename(sys.executable).lower():
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            fh = open(os.path.join(DATA_DIR, "stellarhub.log"), "a", encoding="utf-8", buffering=1)
            sys.stdout = sys.stderr = fh
        except OSError:
            pass


ADMIN_TASK = r"StellarHub\Open as administrator"
LEGACY_ADMIN_TASKS = (r"StellarHub\Abrir como administrador",)  # name used by earlier versions


def _launch_cmd(extra=""):
    if getattr(sys, "frozen", False):
        return sys.executable, extra.strip()
    return _gui_python(), f'"{os.path.join(base_dir(), "run.py")}" {extra}'.strip()


def _ensure_admin_task():
    """Creates (or updates) the scheduled task that opens StellarHub elevated without the UAC prompt."""
    if PORTABLE:
        return False  # the portable version asks Windows each time instead of leaving a task on the PC
    import subprocess
    exe, args = _launch_cmd("--from-task")
    task_cmd = f'"{exe}" {args}'
    r = subprocess.run(["schtasks", "/create", "/tn", ADMIN_TASK, "/tr", task_cmd, "/sc", "once", "/st", "00:00",
                        "/sd", "01/01/2000", "/rl", "highest", "/it", "/f"],
                       capture_output=True, text=True, creationflags=0x08000000)
    if r.returncode == 0:  # replace tasks left by earlier versions under another name
        for old in LEGACY_ADMIN_TASKS:
            subprocess.run(["schtasks", "/delete", "/tn", old, "/f"], capture_output=True, creationflags=0x08000000)
    return r.returncode == 0


def _delete_admin_task():
    import subprocess
    for name in (ADMIN_TASK, *LEGACY_ADMIN_TASKS):
        subprocess.run(["schtasks", "/delete", "/tn", name, "/f"], capture_output=True, creationflags=0x08000000)


def _elevate_on_start():
    """If the user chose permanent administrator mode and this copy is not elevated: relaunch elevated
    (first through the scheduled task, with no prompt; if it does not exist, with the UAC prompt). Returns True if we must exit."""
    if is_admin() or ISOLATED or "--no-elevate" in sys.argv or "--from-task" in sys.argv:
        return False
    try:
        with open(SETTINGS, encoding="utf-8") as fh:
            if not json.load(fh).get("alwaysAdmin"):
                return False
    except (OSError, ValueError):
        return False
    import subprocess
    if not PORTABLE and _task_opens_this_copy(ADMIN_TASK) and subprocess.run(
            ["schtasks", "/run", "/tn", ADMIN_TASK], capture_output=True, creationflags=0x08000000).returncode == 0:
        return True
    # no task, or it opens another copy (e.g. the source version before installing): ask Windows once;
    # the elevated copy then points the task at itself
    exe, args = _launch_cmd("--no-elevate")
    if ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, args, base_dir(), 1) > 32:
        return True
    return False  # the user said no: stay in normal mode


def _task_opens_this_copy(name):
    """True if the scheduled task exists and launches this same program (the exe, or run.py from source)."""
    import re
    import subprocess
    try:
        r = subprocess.run(["schtasks", "/query", "/tn", name, "/xml"], capture_output=True, timeout=10,
                           creationflags=0x08000000)
    except (OSError, subprocess.SubprocessError):
        return False
    if r.returncode != 0:
        return False
    raw = r.stdout
    xml = raw.decode("utf-16", "replace") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("mbcs", "replace")
    exe, _args = _launch_cmd()
    cmd = re.search(r"<Command>(.*?)</Command>", xml, re.S)
    arg = re.search(r"<Arguments>(.*?)</Arguments>", xml, re.S)

    def norm(t):
        return os.path.normcase(t.replace("&quot;", '"').strip().strip('"'))
    if not cmd or norm(cmd.group(1)) != norm(exe):
        return False
    return FROZEN or (arg is not None and norm(os.path.join(base_dir(), "run.py")) in norm(arg.group(1)))


def _autostart_cmd():
    exe, args = _launch_cmd("--tray")
    return f'"{exe}" {args}'


def _sync_launch_entries():
    """After installing (or moving) StellarHub, the "open with Windows" entry must open this copy."""
    if PORTABLE or not _read_settings().get("startWithWindows"):
        return
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                            winreg.KEY_READ | winreg.KEY_SET_VALUE) as k:
            try:
                cur = winreg.QueryValueEx(k, "StellarHub")[0]
            except FileNotFoundError:
                cur = None
            if cur != _autostart_cmd():
                winreg.SetValueEx(k, "StellarHub", 0, winreg.REG_SZ, _autostart_cmd())
    except OSError:
        pass


def _quit_running():
    """--quit: asks the running copy to close (installer and uninstaller) and waits until it is gone."""
    import socket
    try:
        with socket.create_connection(("127.0.0.1", SINGLE_PORT), timeout=1.5) as s:
            s.sendall(b"quit")
            s.settimeout(3)
            if s.recv(8) != b"bye":
                return _wait_other_copies_gone()
    except OSError:
        return _wait_other_copies_gone()  # not answering (or not running): make sure it is gone anyway
    for _ in range(80):  # up to 8 s
        time.sleep(0.1)
        try:
            socket.create_connection(("127.0.0.1", SINGLE_PORT), timeout=0.2).close()
        except OSError:
            break
    _wait_other_copies_gone()


def _wait_other_copies_gone(seconds=12):
    """Waits until no other StellarHub.exe from this folder is running; if one is still there after the wait, it
    is ended, so the files can be replaced or removed."""
    try:
        import psutil
    except ImportError:
        return
    me, exe = os.getpid(), os.path.normcase(sys.executable)

    def others():
        out = []
        for pr in psutil.process_iter(["pid", "name", "exe"]):
            try:
                if pr.info["pid"] != me and (pr.info["name"] or "").lower() == os.path.basename(exe).lower() \
                        and (pr.info["exe"] is None or os.path.normcase(pr.info["exe"]) == exe):
                    out.append(pr)
            except (psutil.Error, OSError):
                continue
        return out
    if not FROZEN:
        return
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if not others():
            return
        time.sleep(0.2)
    for pr in others():
        try:
            pr.kill()
        except (psutil.Error, OSError):
            pass


SETUP_KEYS = {"language": str, "startWithWindows": bool, "alwaysAdmin": bool, "widgetWasOpen": bool, "autoUpdate": bool}


def _cli_setup(pairs):
    """--setup key=value ...: the choices made in the installer, written to this user's settings.
    The installer runs it as the user who installs (not elevated), so it lands in their profile.
    Only the keys in SETUP_KEYS are accepted; anything else is ignored."""
    changes = {}
    for p in pairs:
        k, sep, v = p.partition("=")
        kind = SETUP_KEYS.get(k)
        if not sep or kind is None:
            continue
        changes[k] = v.strip().lower() in ("1", "true", "yes", "on") if kind is bool else v.strip()[:16]
    if not changes:
        return
    data = _read_settings()
    data.update(changes)
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = SETTINGS + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, SETTINGS)
    except OSError:
        return
    if "startWithWindows" in changes:
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                                winreg.KEY_SET_VALUE) as k:
                if changes["startWithWindows"]:
                    winreg.SetValueEx(k, "StellarHub", 0, winreg.REG_SZ, _autostart_cmd())
                else:
                    try:
                        winreg.DeleteValue(k, "StellarHub")
                    except FileNotFoundError:
                        pass
        except OSError:
            pass


def _uninstall_cleanup():
    """--uninstall-cleanup: removes what StellarHub registered in Windows outside its own folder."""
    _delete_admin_task()
    try:
        from .engine import selfupdate
        selfupdate.delete_task()
    except Exception:
        pass
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0,
                            winreg.KEY_READ | winreg.KEY_SET_VALUE) as k:
            cur = winreg.QueryValueEx(k, "StellarHub")[0]
            if os.path.normcase(sys.executable) in os.path.normcase(cur):
                winreg.DeleteValue(k, "StellarHub")
    except OSError:
        pass


_WV2 = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"


def _webview2_present():
    """Microsoft's documented check for the WebView2 runtime. The installer adds it when missing; the portable
    version can't, so it says what to do instead of failing without a word."""
    import winreg
    for hive, key in ((winreg.HKEY_LOCAL_MACHINE, "SOFTWARE\\WOW6432Node\\" + _WV2), (winreg.HKEY_LOCAL_MACHINE, "SOFTWARE\\" + _WV2),
                      (winreg.HKEY_CURRENT_USER, "SOFTWARE\\" + _WV2)):
        try:
            with winreg.OpenKey(hive, key) as k:
                v = winreg.QueryValueEx(k, "pv")[0]
                if v and v != "0.0.0.0":
                    return True
        except OSError:
            continue
    return False


def _no_webview2():
    msg = tr("StellarHub needs the Microsoft Edge WebView2 Runtime, and this PC doesn't have it. Download it from Microsoft now?")
    if ctypes.windll.user32.MessageBoxW(None, msg, "StellarHub", 0x04 | 0x30) == 6:  # Yes/No with a warning icon; IDYES
        import webbrowser
        webbrowser.open("https://go.microsoft.com/fwlink/p/?LinkId=2124703")


UI_PORT = 47822  # the interface's local web server. pywebview's default (42001) is shared by every pywebview app


def _ui_port():
    """A stable port for the interface: the page's local storage (language, small preferences) belongs to the
    address, so it must not change between starts. If ours is taken, pick a free one and remember it."""
    import socket

    def free(port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return True
            except OSError:
                return False
    saved = _read_settings().get("uiPort")
    for port in ([] if ISOLATED else ([saved] if isinstance(saved, int) else []) + [UI_PORT]):
        if free(port):
            return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    if ISOLATED:
        return port
    try:
        data = _read_settings()
        data["uiPort"] = port
        with open(SETTINGS, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
    except OSError:
        pass
    return port


SINGLE_PORT = 47821  # single instance: a second copy asks the first one to show itself, then exits
if ISOLATED:
    SINGLE_PORT = 47900 + os.getpid() % 90


def _already_running():
    import socket
    try:
        with socket.create_connection(("127.0.0.1", SINGLE_PORT), timeout=0.6) as s:
            s.sendall(b"show")
        return True
    except OSError:
        return False


def _listen_single(api):
    import socket
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        srv.bind(("127.0.0.1", SINGLE_PORT))
    except OSError:
        return
    srv.listen(2)

    def loop():
        while True:
            try:
                conn, _ = srv.accept()
                with conn:
                    msg = conn.recv(16)
                    if msg.startswith(b"show"):
                        api.show_main()
                    elif msg.startswith(b"quit"):  # the installer closes the running copy before updating it
                        conn.sendall(b"bye")
                        threading.Timer(0.05, api.quit).start()
            except OSError:
                break
    threading.Thread(target=loop, daemon=True, name="single").start()


def _wait_for_previous():
    """--wait-pid N: when relaunching as administrator, wait for the previous copy to close."""
    if "--wait-pid" not in sys.argv:
        return
    try:
        pid = int(sys.argv[sys.argv.index("--wait-pid") + 1])
    except (IndexError, ValueError):
        return
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
    if h:
        k32.WaitForSingleObject(h, 15000)
        k32.CloseHandle(h)


_MUTEX = None  # held for the whole life of the process


def _claim_single_instance():
    """One StellarHub per Windows session, normal or elevated: a named mutex. True if this copy got it.
    A copy started by the scheduled task or relaunched as administrator gives the previous one a few seconds
    to exit first."""
    global _MUTEX
    k32 = ctypes.windll.kernel32
    k32.CreateMutexW.restype = ctypes.c_void_p
    tries = 50 if ("--from-task" in sys.argv or "--wait-pid" in sys.argv) else 1
    for i in range(tries):
        h = k32.CreateMutexW(None, False, (r"Local\StellarHub.SingleInstance" + (f".test{os.getpid()}" if ISOLATED else "")))
        err = k32.GetLastError()
        if h and err != 183:  # 183 = ERROR_ALREADY_EXISTS
            _MUTEX = h
            return True
        if h:
            k32.CloseHandle(ctypes.c_void_p(h))
        # no handle with error 5 = it exists but belongs to an elevated copy: also "already running"
        if i + 1 < tries:
            time.sleep(0.1)
    return False


def _show_running_copy():
    """Brings the copy that is already running to the front (it may still be starting: retry a moment)."""
    for _ in range(30):
        if _already_running():
            return
        time.sleep(0.2)


def main():
    if any(a.startswith("--multiprocessing") for a in sys.argv[1:]):
        return  # a worker process that freeze_support() did not catch: never boot the app from it
    if "--quit" in sys.argv:
        return _quit_running()
    if "--uninstall-cleanup" in sys.argv:
        return _uninstall_cleanup()
    if "--setup" in sys.argv:
        return _cli_setup(sys.argv[sys.argv.index("--setup") + 1:])
    if "--admin-task" in sys.argv:
        on = sys.argv[sys.argv.index("--admin-task") + 1:][:1] == ["on"]
        return _ensure_admin_task() if on else _delete_admin_task()
    if "--self-update" in sys.argv:  # the updater (see engine/selfupdate.py): no window, never a second app
        _log_to_file()
        from .engine import selfupdate
        return selfupdate.run_updater()
    if "--finish-update" in sys.argv:  # a new portable copy putting itself in place (engine/selfupdate.py)
        from .engine import selfupdate
        i = sys.argv.index("--finish-update")
        return selfupdate.finish_update(sys.argv[i + 1], sys.argv[i + 2] if len(sys.argv) > i + 2 else "0")
    if "--update-task" in sys.argv:  # the installer, as administrator
        from .engine import selfupdate
        on = sys.argv[sys.argv.index("--update-task") + 1:][:1] == ["on"]
        return selfupdate.ensure_task() if on else selfupdate.delete_task()
    _log_to_file()
    if FROZEN:
        _migrate_store_python_data()
    from . import i18n
    i18n.set_language(os.environ.get("STELLARHUB_LANG") or _read_settings().get("language"))
    _wait_for_previous()
    if _already_running():
        return
    if _elevate_on_start():
        return
    if not _claim_single_instance():
        _show_running_copy()
        return
    if not ISOLATED:  # a test copy never takes over the user's "open with Windows" entry or administrator task
        threading.Thread(target=_sync_launch_entries, daemon=True).start()
    if PORTABLE:
        from .engine import selfupdate
        threading.Thread(target=selfupdate.cleanup_after_update, daemon=True).start()
    if is_admin() and not ISOLATED:
        try:
            with open(SETTINGS, encoding="utf-8") as fh:
                if json.load(fh).get("alwaysAdmin"):
                    threading.Thread(target=_ensure_admin_task, daemon=True).start()
        except (OSError, ValueError):
            pass
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
    except Exception:
        pass
    if not _webview2_present():
        _no_webview2()
        return
    import webview

    api = Api()
    title = tr("StellarHub (administrator)") if is_admin() else "StellarHub"
    from .chrome import Chrome

    start_hidden = "--tray" in sys.argv
    window = webview.create_window(
        title, url=os.path.join(UI_DIR, "index.html"), js_api=api,
        width=1600, height=960, min_size=(1100, 700), frameless=True, easy_drag=False, shadow=True,
        background_color=BG, text_select=False, hidden=start_hidden,
    )
    api._attach(window)

    def on_state(maxed):  # called from the window thread: never wait here
        api._js(f"window.SH && SH.emit('win', {{max: {'true' if maxed else 'false'}}})")

    api._chrome = Chrome(window, on_state)
    window.events.shown += lambda: (api._chrome.setup(start_max=True), _grant_media(window))
    window.events.closing += api._on_closing

    from .tray import Tray
    try:
        api._tray = Tray(api)
        api._tray.start()
    except Exception as e:  # without a tray the app still works; the X quits completely
        print("tray:", e)
        api._tray = None

    _listen_single(api)

    # engine: long-task notifications and real telemetry
    from .engine import jobs
    jobs.set_emitter(lambda ev, data: api._js(f"window.SH && SH.emit({json.dumps(ev)}, {json.dumps(data)})"))
    try:
        from .engine.telemetry import Sampler
        api._sampler = Sampler(api._tele_push)
        rate = float(api.settings_get().get("teleRate") or 1000) / 1000
        api._sampler.set_rate(rate)
        api._visible = not start_hidden
        window.events.loaded += lambda: (api._sampler.start(), api._tele_refresh())
    except Exception as e:
        print("telemetry:", e)

    # Autopilot: runs the routines while the app is open, also hidden in the tray
    try:
        from .engine import autopilot
        if not ISOLATED:  # a test copy must not run the user's routines or write their Autopilot state
            autopilot.attach((lambda title, text: api._tray.notify(text, title)) if api._tray else None)
    except Exception as e:
        print("autopilot:", e)

    refresh_ui_cache()
    webview.start(gui="edgechromium", debug="--debug" in sys.argv, http_server=True, http_port=_ui_port(),
                  private_mode=False, storage_path=WEB_DIR)
    if api._tray is not None:
        api._tray.stop()
    # The window is gone and settings are saved as they change. Background scans still running in thread pools
    # (winget, PowerShell...) would keep the process alive until they finish, so end it now.
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except Exception:
        pass
    os._exit(0)
