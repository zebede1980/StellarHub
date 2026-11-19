"""Games: PresentMon's CSV, the frame statistics and the diagnosis. PresentMon itself is never started."""
import io
import json
import os
import tempfile
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
        self.assertEqual(run_of([2.0] * 200 + [9.0] + [2.0] * 200).summary()["events"], [])     # under 8 ms more

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


if __name__ == "__main__":
    unittest.main()
