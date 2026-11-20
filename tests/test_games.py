"""Games: PresentMon's CSV, the frame statistics and the diagnosis. PresentMon itself is never started."""
import io
import json
import os
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

from stellarhub.engine import games as G

V2 = "Application,ProcessID,SwapChainAddress,PresentRuntime,MsCPUBusy,MsCPUWait,MsGPUBusy,DisplayedTime"
V20 = "Application,ProcessID,SwapChainAddress,FrameTime,CPUBusy,CPUWait,GPUBusy"
V1 = "Application,ProcessID,SwapChainAddress,Runtime,MsBetweenPresents,MsInPresentAPI"


def run_of(times, gpu=None):
    r = G.Run("game.exe", 1)
    for ms in times:
        r.add(ms, gpu)
    return r


class ParserTest(unittest.TestCase):
    def feed(self, *lines):
        p = G.Parser()
        return [f for f in map(p.feed, lines) if f]

    def test_frame_time_is_cpu_busy_plus_wait(self):
        (f,) = self.feed(V2, "game.exe,4242,0x1F,DXGI,6.5,10.0,15.0,16.6")
        self.assertEqual((f.app, f.pid, f.chain, f.gpu), ("game.exe", 4242, "0x1F", 15.0))
        self.assertAlmostEqual(f.ms, 16.5)

    def test_older_column_names(self):
        (a,) = self.feed(V20, "game.exe,1,0x1,8.0,3.0,5.0,7.5")
        self.assertEqual((a.ms, a.gpu), (8.0, 7.5))
        (b,) = self.feed(V1, "game.exe,1,0x1,DXGI,11.1,0.3")
        self.assertEqual((b.ms, b.gpu), (11.1, None))

    def test_lines_before_the_header_and_bad_rows_are_skipped(self):
        frames = self.feed("warning: something", "", V2, "game.exe,1,0x1,DXGI,NA,NA,NA,NA",
                           "game.exe,1,0x1,DXGI,0,0,0,0", "short,row", "game.exe,1,0x1,DXGI,5,5,NA,NA")
        self.assertEqual(len(frames), 1)
        self.assertEqual((frames[0].ms, frames[0].gpu), (10.0, None))

    def test_quoted_names(self):
        (f,) = self.feed(V1, '"My, Game.exe",7,0x1,DXGI,10,1')
        self.assertEqual(f.app, "My, Game.exe")


class RunTest(unittest.TestCase):
    def test_steady_frame_rate(self):
        s = run_of([10.0] * 1000).summary()
        self.assertEqual((s["fps"], s["min"], s["max"], s["low1"], s["low01"]), (100.0, 100.0, 100.0, 100.0, 100.0))
        self.assertEqual((s["frames"], s["seconds"], s["events"]), (1000, 10.0, []))

    def test_lows_are_the_average_of_the_slowest_frames(self):
        s = run_of([10.0] * 990 + [20.0] * 10).summary()
        self.assertEqual(s["low1"], 50.0)   # the slowest 1 % is the ten 20 ms frames
        self.assertEqual(s["low01"], 50.0)
        self.assertEqual(s["worstMs"], 20.0)

    def test_a_hitch_is_found_and_neighbours_are_one_event(self):
        s = run_of([10.0] * 200 + [60.0, 10.0, 45.0] + [10.0] * 200).summary()
        (e,) = s["events"]
        self.assertEqual((e["kind"], e["frames"], e["worst"], e["at"]), ("hitch", 2, 60.0, 2.0))

    def test_a_slightly_slow_frame_is_not_a_hitch(self):
        self.assertEqual(run_of([10.0] * 200 + [17.0] + [10.0] * 200).summary()["events"], [])  # under 2.5x
        self.assertEqual(run_of([6.0] * 200 + [18.0] + [6.0] * 200).summary()["events"], [])     # under 16 ms more

    def test_a_pause_is_listed_but_kept_out_of_the_statistics(self):
        s = run_of([10.0] * 300 + [5000.0] + [10.0] * 300).summary()
        (e,) = s["events"]
        self.assertEqual((e["kind"], e["at"], e["seconds"]), ("pause", 3.0, 5.0))
        self.assertEqual((s["fps"], s["low01"], s["frames"], s["seconds"]), (100.0, 100.0, 600, 11.0))

    def test_a_dip_needs_three_slow_seconds(self):
        two = run_of([10.0] * 1000 + [20.0] * 100 + [10.0] * 1000).summary()   # 2 s at half the frame rate
        self.assertEqual([e for e in two["events"] if e["kind"] == "dip"], [])
        five = run_of([10.0] * 1000 + [20.0] * 250 + [10.0] * 1000).summary()  # 5 s
        (d,) = [e for e in five["events"] if e["kind"] == "dip"]
        self.assertEqual((d["at"], d["seconds"], d["fps"]), (10.0, 5, 50.0))
        self.assertEqual((five["min"], five["max"]), (50.0, 100.0))

    def test_gpu_busy_share(self):
        self.assertEqual(run_of([10.0] * 100, gpu=9.5).summary()["gpuBusy"], 0.95)
        self.assertIsNone(run_of([10.0] * 100).summary()["gpuBusy"])

    def test_events_are_capped(self):
        r = run_of(([10.0] * 150 + [5000.0]) * (G.MAX_EVENTS + 5))
        self.assertEqual((len(r.events), r.dropped), (G.MAX_EVENTS, 5))

    def test_nothing_measured(self):
        self.assertIsNone(G.Run("game.exe", 1).summary())
        self.assertIsNone(G.Run("game.exe", 1).now())


class DiagnoseTest(unittest.TestCase):
    TELE = [{"gpu": 50, "threads": [0.2, 0.3, 0.25], "vram": 4.0, "vramTotal": 8.0}] * 3

    def test_gpu_is_the_limit(self):
        d = G.diagnose(45, 0.98, self.TELE)
        self.assertEqual((d["limit"], d["tooHigh"], d["vramFull"]), ("gpu", True, False))
        self.assertFalse(G.diagnose(140, 0.98, self.TELE)["tooHigh"])  # GPU-bound but fast enough

    def test_cpu_is_the_limit(self):
        tele = [{"threads": [0.97, 0.3], "vram": 4.0, "vramTotal": 8.0}] * 3
        self.assertEqual(G.diagnose(45, 0.5, tele)["limit"], "cpu")

    def test_neither_is_busy(self):
        self.assertEqual(G.diagnose(60, 0.4, self.TELE)["limit"], "cap")

    def test_another_program_has_the_graphics_card(self):
        tele = [{"gpu": 97, "threads": [0.97, 0.3]}] * 3  # the card is full, but this game uses a fifth of it
        d = G.diagnose(30, 0.2, tele)
        self.assertEqual((d["limit"], d["tooHigh"], d["gpu"], d["gpuAll"]), ("other", False, 0.2, 0.97))

    def test_unknown_is_not_guessed(self):
        self.assertIsNone(G.diagnose(60, 0.85, self.TELE)["limit"])  # in between
        self.assertIsNone(G.diagnose(60, 0.4)["limit"])               # no telemetry: CPU or a cap, cannot tell
        self.assertIsNone(G.diagnose(60, None)["limit"])

    def test_falls_back_to_gpu_usage(self):
        d = G.diagnose(40, None, [{"gpu": 99, "threads": [0.5]}, {"gpu": 97, "threads": [0.5]}])
        self.assertEqual((d["limit"], d["gpu"]), ("gpu", 0.98))

    def test_video_memory_full(self):
        d = G.diagnose(40, 0.98, [{"threads": [0.5], "vram": 7.8, "vramTotal": 8.0}])
        self.assertTrue(d["vramFull"])


class TrackerTest(unittest.TestCase):
    def test_the_busiest_run_wins_and_the_desktop_is_ignored(self):
        t = G.Tracker()
        for _ in range(500):
            t.add(G.Frame("dwm.exe", 1, "0x1", 6.9, None))
        for _ in range(200):
            t.add(G.Frame("game.exe", 2, "0x1", 10.0, 9.0))
        for _ in range(20):
            t.add(G.Frame("launcher.exe", 3, "0x1", 16.6, None))
        self.assertEqual(t.busiest().app, "game.exe")
        self.assertEqual(t.summary()["frames"], 200)
        self.assertIsNone(G.Tracker().summary())

    def test_unnamed_processes_are_looked_up_once(self):
        names = {7: "dwm.exe", 8: "game.exe"}
        with mock.patch.object(G, "process_name", side_effect=names.get) as lookup:
            t = G.Tracker()
            for pid in (7, 8, 7, 8, 8):
                t.add(G.Frame(G.UNKNOWN, pid, "0x0", 10.0, None))
        self.assertEqual([(r.app, len(r.ms)) for r in t.runs.values()], [("game.exe", 3)])
        self.assertEqual(lookup.call_count, 2)

    def test_command_line_reads_a_saved_csv(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "run.csv")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(V2 + "\n" + "game.exe,2,0x1,DXGI,4,6,9.9,10\n" * 300 + "other.exe,3,0x1,DXGI,4,6,1,10\n" * 400)
            out = io.StringIO()
            with redirect_stdout(out):
                code = G.main(["--csv", path, "--process", "game.exe", "--target", "144"])
        s = json.loads(out.getvalue())
        self.assertEqual((code, s["app"], s["fps"], s["gpuBusy"]), (0, "game.exe", 100.0, 0.99))
        self.assertEqual((s["diagnosis"]["limit"], s["diagnosis"]["tooHigh"]), ("gpu", True))


class LiveTest(unittest.TestCase):
    def test_numbers_for_the_live_screen(self):
        v = run_of([10.0] * 500, gpu=9.0).live()
        self.assertEqual((v["now"], v["fps"], v["low1"], v["ms"], v["gpuNow"]), (100.0, 100.0, 100.0, 10.0, 0.9))
        self.assertEqual((v["min"], v["max"], v["series"], v["events"]), (100.0, 100.0, [100.0] * 5, []))
        self.assertIsNone(G.Run("game.exe", 1).live())

    def test_gpu_share_follows_the_last_frames(self):
        r = run_of([10.0] * 1000, gpu=2.0)
        for _ in range(G.GPU_WINDOW):
            r.add(10.0, 9.8)
        self.assertEqual(r.live()["gpuNow"], 0.98)
        self.assertLess(r.summary()["gpuBusy"], 0.6)  # the whole run still remembers the idle start

    def test_long_charts_are_thinned(self):
        self.assertEqual(G.thin([1.0, 2.0, 3.0], 10), ([1.0, 2.0, 3.0], 1))
        self.assertEqual(G.thin([10.0, 20.0, 30.0, 40.0, 50.0], 2), ([20.0, 45.0], 3))
        s = run_of([10.0] * 100 * (G.SERIES_MAX + 50)).summary()
        self.assertEqual((len(s["series"]), s["seriesStep"]), (325, 2))


class FakeCapture:
    notes = ()

    def __init__(self, alive=True):
        self.alive = alive

    def start(self):
        return self.alive

    def running(self):
        return self.alive

    def stop(self):
        self.alive = False


class FakeSampler:
    def sample(self):
        return {"cpu": 40, "cpuTemp": None, "gpu": 99, "gpuTemp": 71, "vram": 6.0, "vramTotal": 8.0, "ram": 12.0,
                "threads": [0.5, 0.6], "uptime": 123}


class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.front = (0, False)
        self.saved = []
        self.m = G.Monitor(capture=FakeCapture(), sampler=FakeSampler(), front=lambda: self.front,
                           save=lambda s: self.saved.append(s) or s)

    def draw(self, pid, frames, ms=10.0, gpu=9.9, app="game.exe"):
        for _ in range(frames):
            self.m.tracker.add(G.Frame(app, pid, "0x1", ms, gpu))

    def ticks(self, n):
        for _ in range(n):
            self.m.tick()

    def test_a_program_in_front_and_full_screen_becomes_the_game(self):
        self.draw(5, 300)
        self.front = (5, True)
        self.ticks(G.GAME_AFTER_S - 1)
        self.assertIsNone(self.m.game)
        self.ticks(1)
        self.assertEqual(self.m.game, 5)

    def test_a_window_or_something_that_draws_nothing_is_not_a_game(self):
        self.draw(5, 300)
        self.front = (5, False)   # in front, but a window
        self.ticks(10)
        self.front = (6, True)    # full screen, but PresentMon saw no frames from it
        self.ticks(10)
        self.assertIsNone(self.m.game)

    def test_the_streak_starts_again_when_another_program_comes_to_the_front(self):
        self.draw(5, 300)
        self.front = (5, True)
        self.ticks(2)
        self.front = (9, True)
        self.ticks(1)
        self.front = (5, True)
        self.ticks(2)
        self.assertIsNone(self.m.game)

    def test_a_program_picked_by_hand(self):
        self.draw(7, 300, app="windowed.exe")
        self.assertTrue(self.m.track(7))
        self.ticks(1)
        self.assertEqual(self.m.game, 7)

    def test_live_numbers_and_telemetry_while_playing(self):
        self.draw(5, 300)
        self.draw(8, 300, ms=20.0, app="other.exe")
        self.assertEqual(self.m.live(144)["others"], [{"app": "game.exe", "pid": 5, "fps": 100.0},
                                                      {"app": "other.exe", "pid": 8, "fps": 50.0}])
        self.front = (5, True)
        self.ticks(G.GAME_AFTER_S + 4)
        v = self.m.live(144)
        self.assertEqual((v["on"], v["target"], v["others"], len(self.m.tele)), (True, 144.0, [], 2))
        g = v["game"]
        self.assertEqual((g["app"], g["now"], g["hw"]["gpuTemp"]), ("game.exe", 100.0, 71))
        self.assertEqual((g["diagnosis"]["limit"], g["diagnosis"]["tooHigh"]), ("gpu", True))
        self.assertNotIn("threads", g["hw"])

    def end(self):
        later = time.monotonic() + G.GONE_AFTER_S + 5
        with mock.patch.object(G.time, "monotonic", return_value=later), \
                mock.patch.object(G.psutil, "pid_exists", return_value=False):
            self.m.tick()

    def test_the_session_is_saved_when_the_game_closes(self):
        self.draw(5, 100 * (G.SESSION_MIN_S + 10))
        self.front = (5, True)
        self.ticks(G.GAME_AFTER_S + 2)
        self.end()
        self.assertIsNone(self.m.game)
        (s,) = self.saved
        self.assertEqual((s["app"], s["fps"], s["target"], s["diagnosis"]["limit"]), ("game.exe", 100.0, 60.0, "gpu"))
        self.assertEqual(s["hw"], {"cpu": 40.0, "cpuTemp": None, "gpu": 99.0, "gpuTemp": 71, "vram": 6.0,
                                   "vramTotal": 8.0, "ram": 12.0})
        self.assertIsNone(self.m.tracker.seen(5))  # forgotten: the next launch starts a new run

    def test_a_game_that_is_only_out_of_sight_keeps_its_session(self):
        self.draw(5, 500)
        self.front = (5, True)
        self.ticks(G.GAME_AFTER_S)
        later = time.monotonic() + G.GONE_AFTER_S + 5
        with mock.patch.object(G.time, "monotonic", return_value=later), \
                mock.patch.object(G.psutil, "pid_exists", return_value=True):  # paused or minimized, still running
            self.m.tick()
        self.assertEqual((self.m.game, self.saved), (5, []))

    def test_a_short_run_is_not_saved(self):
        self.draw(5, 100 * (G.SESSION_MIN_S - 10))
        self.front = (5, True)
        self.ticks(G.GAME_AFTER_S)
        self.end()
        self.assertEqual((self.m.game, self.saved), (None, []))

    def test_stopping_saves_what_was_being_measured(self):
        self.draw(5, 100 * (G.SESSION_MIN_S + 10))
        self.front = (5, True)
        self.ticks(G.GAME_AFTER_S)
        self.assertEqual(self.m.stop()["app"], "game.exe")
        self.assertFalse(self.m.live()["on"])


class HistoryTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        patch = mock.patch.object(G, "HISTORY", os.path.join(self.dir.name, "sub", "games.json"))
        patch.start()
        self.addCleanup(patch.stop)

    def test_save_list_delete(self):
        self.assertEqual(G.history(), [])
        a = G.save_session({"app": "a.exe", "at": 1000})
        b = G.save_session({"app": "b.exe", "at": 2000})
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual([s["app"] for s in G.history()], ["b.exe", "a.exe"])  # newest first
        self.assertEqual((G.delete_session(a["id"]), G.delete_session("nope")), (1, 0))
        self.assertEqual([s["app"] for s in G.history()], ["b.exe"])
        self.assertEqual((G.clear_history(), G.history()), (1, []))

    def test_a_damaged_file_is_kept_aside(self):
        os.makedirs(os.path.dirname(G.HISTORY))
        with open(G.HISTORY, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        self.assertEqual(G.history(), [])
        self.assertTrue(os.path.exists(G.HISTORY + ".bad"))

    def test_only_the_newest_sessions_are_kept(self):
        with mock.patch.object(G, "MAX_SESSIONS", 3):
            for at in range(5):
                G.save_session({"app": f"{at}.exe", "at": at})
        self.assertEqual([s["at"] for s in G.history()], [4, 3, 2])


class ApiTest(unittest.TestCase):
    def test_the_ui_reaches_only_what_is_exported(self):
        from stellarhub import engine
        for fn in G.EXPORTS:
            self.assertTrue(callable(engine.resolve("games", fn, "call")), fn)
        for fn in ("main", "find_presentmon", "process_name", "session_of"):
            with self.assertRaises(PermissionError):
                engine.resolve("games", fn, "call")

    def test_without_presentmon(self):
        with mock.patch.object(G, "find_presentmon", return_value=None):
            self.assertEqual(G.start(), {"ok": False, "why": "missing"})
            self.assertEqual((G.status()["found"], G.status()["on"]), (False, False))
            v = G.live(60)
        self.assertEqual((v["on"], v["found"], v["game"]), (False, False, None))
        self.assertEqual(G.stop(), {"saved": None})
        self.assertFalse(G.track(1))


if __name__ == "__main__":
    unittest.main()
