#!/usr/bin/env python3
"""
Xmoto 等候計數器（手機模擬器版）

不連 RTSP，改用 BlueStacks 裡的 Tapo App 看畫面（分享帳號即可，攝影機不用重置）：
  每一輪：
    1. 點開「室外」攝影機 → 截圖 → 返回       → 算等候區的機車（太久沒動的不算）
    2. 點開「洗車機左前」攝影機 → 截圖 → 返回  → 判斷洗車機有沒有在使用
    3. 結果交給本機 n8n（Webhook），由 n8n 上傳 status.json 到 R2
  每次只開幾秒就關掉，不會一直佔著連線，也不會觸發 App 的「太久沒操作自動暫停」。

用法：
  python emu_counter.py --config emu-config.json              # 正式執行
  python emu_counter.py --config emu-config.json --once       # 只跑一輪
  python emu_counter.py --config emu-config.json --preview    # 輸出 preview_queue.jpg / preview_machine.jpg
  python emu_counter.py --config emu-config.json --save-reference empty_lf_day.jpg   # 洗車間沒車時拍空機照片
"""
from __future__ import annotations

import argparse
import json
import logging
import signal
import statistics
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections import deque
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from queue_counter import Counter, ParkedFilter, load_secrets_file, now_iso  # noqa: E402

log = logging.getLogger("xmoto-emu")
NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0  # 不跳出黑色視窗


# ---------------------------------------------------------------- ADB / Tapo App
class Emulator:
    def __init__(self, cfg: dict):
        self.adb = cfg.get("adb_path", "adb")
        self.serial = cfg.get("adb_serial", "auto")
        self.pkg = cfg.get("app_package", "com.tplink.iot")
        self.home_activity = cfg.get("home_activity", "MainActivity")
        self.tiles: dict[tuple[str, int], tuple[int, int]] = {}

    def run(self, *args: str, timeout: float = 20, binary: bool = False):
        cmd = [self.adb] + (["-s", self.serial] if self.serial not in ("", "auto") else []) + list(args)
        r = subprocess.run(cmd, capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
        return r.stdout if binary else r.stdout.decode("utf-8", "replace")

    def _devices(self) -> list[str]:
        out = subprocess.run([self.adb, "devices"], capture_output=True, timeout=10,
                             creationflags=NO_WINDOW).stdout.decode()
        return [p[0] for p in (l.split() for l in out.splitlines()) if len(p) == 2 and p[1] == "device"]

    @staticmethod
    def _bluestacks_ports() -> list[int]:
        """從 BlueStacks 設定檔讀出目前使用的 ADB 埠。"""
        import re
        conf = Path(r"C:\ProgramData\BlueStacks_nxt\bluestacks.conf")
        try:
            text = conf.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return []
        return sorted({int(m) for m in re.findall(r'status\.adb_port="(\d+)"', text)})

    def connect(self) -> None:
        if self.serial not in ("", "auto"):
            subprocess.run([self.adb, "connect", self.serial], capture_output=True, timeout=15, creationflags=NO_WINDOW)
            return
        found = [d for d in self._devices() if d.startswith("127.0.0.1:")]
        if not found:
            for port in self._bluestacks_ports() or range(5555, 5566):
                try:
                    subprocess.run([self.adb, "connect", f"127.0.0.1:{port}"], capture_output=True, timeout=4,
                                   creationflags=NO_WINDOW)
                except subprocess.TimeoutExpired:
                    pass
            found = [d for d in self._devices() if d.startswith("127.0.0.1:")] or self._devices()
        if not found:
            raise RuntimeError("找不到模擬器（請確認 BlueStacks 已開啟，且設定 → 進階 → ADB 已開啟）")
        self.serial = found[0]
        log.info("已連上模擬器 %s", self.serial)

    def screencap(self) -> np.ndarray | None:
        data = self.run("exec-out", "screencap", "-p", binary=True)
        if not data:
            return None
        return cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)

    def tap(self, x: int, y: int) -> None:
        self.run("shell", "input", "tap", str(x), str(y))

    def back(self) -> None:
        self.run("shell", "input", "keyevent", "4")

    def top_activity(self) -> str:
        out = self.run("shell", "dumpsys activity activities | grep -m1 topResumedActivity")
        return out.strip()

    def ensure_home(self) -> None:
        """確保停在 Tapo App 首頁（裝置列表）。"""
        for _ in range(4):
            top = self.top_activity()
            if self.pkg in top and self.home_activity in top:
                return
            if self.pkg not in top:
                log.info("Tapo App 不在前景，重新開啟")
                self.run("shell", "monkey", "-p", self.pkg, "-c", "android.intent.category.LAUNCHER", "1")
                time.sleep(6)
            else:
                self.back()
                time.sleep(1.5)
        top = self.top_activity()
        if not (self.pkg in top and self.home_activity in top):
            raise RuntimeError(f"回不到 Tapo 首頁（目前：{top}）")

    def find_tile(self, name: str, index: int, refresh: bool = False) -> tuple[int, int]:
        key = (name, index)
        if key in self.tiles and not refresh:
            return self.tiles[key]
        self.run("shell", "uiautomator", "dump", "/sdcard/xmoto_ui.xml", timeout=30)
        xml = self.run("shell", "cat", "/sdcard/xmoto_ui.xml")
        hits = []
        for node in ET.fromstring(xml[xml.find("<"):]).iter("node"):
            if node.get("text") == name:
                nums = [int(v) for v in node.get("bounds", "").replace("][", ",").strip("[]").split(",")]
                hits.append(((nums[1] + nums[3]) // 2, (nums[0] + nums[2]) // 2))  # (y, x)
        hits.sort()
        if len(hits) <= index:
            raise RuntimeError(f"首頁找不到攝影機「{name}」第 {index + 1} 個（找到 {len(hits)} 個）")
        y, x = hits[index]
        self.tiles[key] = (x, y)
        return x, y

    @staticmethod
    def video_region(img: np.ndarray) -> np.ndarray | None:
        """從直式即時畫面中切出 16:9 影像區。

        找出「有內容的連續橫列」中，高度最接近 16:9 的那一段，
        這樣上方跳出的通知橫幅、下方的按鈕區都不會被誤當成影像。
        """
        h, w = img.shape[:2]
        vh = int(round(w * 9 / 16))
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        mid = gray[:, w // 10: w - w // 10]
        content = (mid.std(axis=1) > 6) | (mid.mean(axis=1) > 20)
        best = None
        y = 0
        while y < h:
            if not content[y]:
                y += 1
                continue
            start = y
            while y < h and content[y]:
                y += 1
            length = y - start
            if 0.85 * vh <= length <= 1.6 * vh:   # 影像區（下方可能直接接著按鈕區）
                if best is None or abs(length - vh) < abs(best[1] - vh):
                    best = (start, length)
        if best is None:
            return None
        start = best[0]
        if start + vh > h:
            return None
        crop = img[start:start + vh]
        if cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY).mean() < 15:  # 還沒載入（全黑）
            return None
        return crop

    def capture(self, name: str, index: int, settle: float = 3.0, timeout: float = 15) -> np.ndarray | None:
        self.ensure_home()
        try:
            x, y = self.find_tile(name, index)
        except RuntimeError:
            x, y = self.find_tile(name, index, refresh=True)
        self.tap(x, y)
        t0 = time.monotonic()
        frame = None
        try:
            while time.monotonic() - t0 < timeout:
                time.sleep(1)
                img = self.screencap()
                if img is None:
                    continue
                if self.home_activity in self.top_activity():  # 沒點進去（位置變了）
                    self.tiles.pop((name, index), None)
                    break
                if self.video_region(img) is not None:
                    time.sleep(settle)  # 等畫面從快取縮圖換成即時影像
                    img = self.screencap()
                    frame = self.video_region(img) if img is not None else None
                    break
        finally:
            self.back()
            time.sleep(1.2)
        return frame


# ---------------------------------------------------------------- 上傳（交給本機 n8n）
def post_status(cfg: dict, status: dict) -> None:
    up = cfg.get("upload", {})
    url = up.get("webhook")
    if not url:
        return
    body = json.dumps({"token": up.get("token", ""), "status": status}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        r.read()


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description="Xmoto 等候計數器（模擬器版）")
    ap.add_argument("--config", default="emu-config.json")
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--save-reference", metavar="檔名")
    ap.add_argument("--no-upload", action="store_true")
    args = ap.parse_args()

    base = Path(args.config).resolve().parent
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(), logging.FileHandler(base / "emu_counter.log", encoding="utf-8")])
    load_secrets_file(base / "secrets.env")
    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
    cams = cfg["cameras"]
    emu = Emulator(cfg)
    emu.connect()

    if args.save_reference:
        frame = emu.capture(cams["machine"]["name"], cams["machine"].get("index", 0))
        if frame is None:
            log.error("截不到「%s」的畫面", cams["machine"]["name"])
            return 1
        cv2.imwrite(str(base / args.save_reference), frame)
        log.info("已存成 %s（%dx%d）", args.save_reference, frame.shape[1], frame.shape[0])
        return 0

    det = cfg.get("detection", {})
    q_cfg = {"detection": det, **cfg["queue"]}
    m_cfg = {"detection": det, "queue_zone": [[0, 0], [0.001, 0], [0.001, 0.001]], **cfg["machine"]}
    m_cfg["machine_zones"] = [{**z, "empty_references": [str(base / r) for r in z.get("empty_references", [])]}
                              for z in m_cfg.get("machine_zones", [])]
    q_counter, m_counter = Counter(q_cfg), Counter(m_cfg)
    parked = ParkedFilter(cfg, state_file=str(base / "parked_tracks.json"))
    window = int(cfg.get("smoothing_samples", 3))
    history: deque[int] = deque(maxlen=window)
    m_history: deque[list[bool]] = deque(maxlen=window)
    interval = float(cfg.get("interval_seconds", 30))
    washed_window = int(float(cfg.get("washed_window_minutes", 5)) * 60)
    washed_until, was_busy = 0.0, False

    stop = False

    def _stop(*_):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    fails = 0
    while not stop:
        started = time.monotonic()
        try:
            q_frame = emu.capture(cams["queue"]["name"], cams["queue"].get("index", 0))
            m_frame = emu.capture(cams["machine"]["name"], cams["machine"].get("index", 0))
            if q_frame is None or m_frame is None:
                fails += 1
                log.warning("截圖失敗（室外=%s，洗車機=%s，連續 %d 次）", q_frame is not None, m_frame is not None, fails)
                if fails >= 3:
                    emu.tiles.clear()
            else:
                fails = 0
                # 保留最近一輪的截圖，方便檢查（覆蓋寫入，不會越存越多）
                cv2.imwrite(str(base / "last_queue.jpg"), q_frame)
                cv2.imwrite(str(base / "last_machine.jpg"), m_frame)
                q_dets, _ = q_counter.detect(q_frame)
                m_dets, in_use = m_counter.detect(m_frame)
                if args.preview:
                    cv2.imwrite(str(base / "preview_queue.jpg"), q_counter.annotate(q_frame, q_dets))
                    cv2.imwrite(str(base / "preview_machine.jpg"), m_counter.annotate(m_frame, m_dets))
                    log.info("已輸出 preview：等候區 %d 台，洗車機使用中=%s，畫面變化=%s",
                             sum(d["counted"] for d in q_dets), in_use,
                             [None if s is None else round(s, 3) for s in m_counter.last_scores])
                    return 0
                # 洗車機狀態（取最近幾次多數決）
                m_history.append(in_use)
                machines = [{"name": m["name"], "inUse": sum(h[i] for h in m_history) * 2 > len(m_history)}
                            for i, m in enumerate(m_counter.machines)]
                busy = bool(machines and machines[0]["inUse"])
                now_t = time.time()
                if was_busy and not busy:  # 剛洗完 → 接下來幾分鐘新出現的車視為「洗完在擦車」
                    washed_until = now_t + washed_window
                    log.info("洗車機剛洗完，%d 分鐘內新出現的機車不算等待", washed_window // 60)
                was_busy = busy
                parked.update(q_dets, q_frame.shape[1], q_frame.shape[0], now=now_t,
                              tag_new_as_washed=now_t < washed_until)
                raw = sum(d["counted"] and not d["parked"] and not d["washed"] for d in q_dets)
                n_parked = sum(d["counted"] and d["parked"] for d in q_dets)
                n_washed = sum(d["counted"] and d["washed"] and not d["parked"] for d in q_dets)
                history.append(raw)
                count = int(round(statistics.median(history)))
                status = {"connected": True, "open": True, "count": count,
                          "machines": machines, "updatedAt": now_iso()}
                (base / "status.json").write_text(json.dumps(status, ensure_ascii=False), encoding="utf-8")
                if not args.no_upload:
                    post_status(cfg, status)
                log.info("等候 %d 台（停放 %d、洗完擦車 %d 台不算）→ 顯示 %d；洗車機=%s（變化 %s）",
                         raw, n_parked, n_washed, count,
                         "使用中" if machines and machines[0]["inUse"] else "空閒",
                         [None if s is None else round(s, 3) for s in m_counter.last_scores])
        except Exception:
            log.exception("執行錯誤，稍後重試")
            try:
                if emu.serial not in emu._devices():
                    emu.serial = "auto"
                    emu.connect()
            except Exception:
                pass
        if args.once:
            break
        time.sleep(max(1.0, interval - (time.monotonic() - started)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
