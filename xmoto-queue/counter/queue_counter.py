#!/usr/bin/env python3
"""
Xmoto 現場等候機車計數器

在店內一台電腦（與 Tapo C210 同一個 Wi-Fi / 區網）上執行：
  1. 透過 RTSP 讀取 Tapo C210 畫面
  2. 用 YOLO 偵測「機車」(COCO class 3: motorcycle)
  3. 只計算落在「等候區多邊形」內的機車 → 等候數量
  4. 「機器區」內有機車 → 機器使用中
  5. 取最近幾次的中位數/多數決，避免路人/遮擋造成數字亂跳
  6. 產生 status.json 並上傳到 Cloudflare R2（網頁每 30 秒讀取一次）

隱私：只上傳數字，不上傳任何影像。

用法：
  python queue_counter.py --config config.json            # 正式執行
  python queue_counter.py --config config.json --once     # 只跑一次（測試）
  python queue_counter.py --config config.json --preview  # 存一張標註圖 preview.jpg，用來調整等候區
  python queue_counter.py --config config.json --source test.jpg --once --no-upload  # 用圖片測試
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import statistics
import sys
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import cv2
import numpy as np

log = logging.getLogger("xmoto-queue")

MOTORCYCLE_CLASS = 3  # COCO
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")


# ---------------------------------------------------------------- config
def load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    # 密碼等敏感資訊可改用環境變數覆寫，避免寫死在檔案
    cam = cfg.setdefault("camera", {})
    cam["password"] = os.environ.get("TAPO_PASSWORD", cam.get("password", ""))
    r2 = cfg.setdefault("r2", {})
    r2["access_key_id"] = os.environ.get("R2_ACCESS_KEY_ID", r2.get("access_key_id", ""))
    r2["secret_access_key"] = os.environ.get("R2_SECRET_ACCESS_KEY", r2.get("secret_access_key", ""))
    return cfg


def rtsp_url(cam: dict, ip: str | None = None) -> str:
    user = quote(cam["username"], safe="")
    pwd = quote(cam["password"], safe="")
    stream = cam.get("stream", "stream1")  # stream1 = 高畫質, stream2 = 低畫質
    return f"rtsp://{user}:{pwd}@{ip or cam['ip']}:{cam.get('port', 554)}/{stream}"


# ---------------------------------------------------------------- camera
class Camera:
    """每次需要時才連線抓一張最新畫面，避免長時間連線的緩衝延遲與斷線問題。

    店內 Wi-Fi 的 IP 可能會變（DHCP 浮動）：
    camera.ip 設為 "auto"，或連續連不到時，會自動掃描同網段找出攝影機。
    """

    def __init__(self, source: str | None = None, cam: dict | None = None):
        self.source = source          # 測試用的固定來源（圖片 / 影片 / RTSP）
        self.cam = cam or {}
        self.ip = None if self.cam.get("ip", "auto") == "auto" else self.cam["ip"]
        self.fails = 0

    @staticmethod
    def _read(url: str) -> np.ndarray | None:
        if not url.startswith("rtsp://") and Path(url).is_file():
            return cv2.imread(url)
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        try:
            if not cap.isOpened():
                return None
            frame = None
            # 丟掉前幾張（可能是舊的緩衝畫面或花屏）
            for _ in range(5):
                ok, f = cap.read()
                if ok:
                    frame = f
            return frame
        finally:
            cap.release()

    def grab(self) -> np.ndarray | None:
        if self.source:
            return self._read(self.source)
        if self.ip is None or self.fails >= 2:
            found = find_camera(self.cam)
            if found:
                if found != self.ip:
                    log.info("找到攝影機：%s", found)
                self.ip, self.fails = found, 0
            elif self.ip is None:
                return None
        frame = self._read(rtsp_url(self.cam, self.ip))
        self.fails = 0 if frame is not None else self.fails + 1
        return frame


def local_subnets() -> list[str]:
    """回傳本機所在的 /24 網段前綴，例如 ['192.168.1']。"""
    import socket

    prefixes = set()
    try:  # 不會真的送出封包，只是讓系統選出對外的網卡 IP
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        prefixes.add(s.getsockname()[0].rsplit(".", 1)[0])
        s.close()
    except OSError:
        pass
    return sorted(p for p in prefixes if not p.startswith("127."))


def arp_table() -> dict[str, str]:
    """IP → MAC（小寫、冒號分隔）。Linux / Mac / Windows 皆可。"""
    import re
    import subprocess

    out = ""
    for cmd in (["ip", "neigh"], ["arp", "-a"]):
        try:
            out += subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            pass
    table = {}
    for line in out.splitlines():
        ip = re.search(r"(\d+\.\d+\.\d+\.\d+)", line)
        mac = re.search(r"([0-9a-fA-F]{1,2}[:-]){5}[0-9a-fA-F]{1,2}", line)
        if ip and mac:
            table[ip.group(1)] = ":".join(x.zfill(2) for x in re.split("[:-]", mac.group(0).lower()))
    return table


def find_camera(cam: dict) -> str | None:
    """掃描區網中開著 RTSP(554) 的裝置，用帳密實際抓一張畫面確認是攝影機。
    若設定了 camera.mac，就只認那一台（店內有多台攝影機時使用）。"""
    import socket
    from concurrent.futures import ThreadPoolExecutor

    port = int(cam.get("port", 554))
    want_mac = (cam.get("mac") or "").lower().replace("-", ":") or None

    def open_port(ip: str) -> str | None:
        try:
            with socket.create_connection((ip, port), timeout=0.6):
                return ip
        except OSError:
            return None

    candidates = []
    for prefix in local_subnets():
        with ThreadPoolExecutor(max_workers=64) as pool:
            candidates += [ip for ip in pool.map(open_port, (f"{prefix}.{i}" for i in range(1, 255))) if ip]
    if want_mac:
        table = arp_table()
        candidates = [ip for ip in candidates if table.get(ip) == want_mac]
    for ip in candidates:
        if Camera._read(rtsp_url(cam, ip)) is not None:
            return ip
    log.warning("區網內找不到攝影機（候選：%s）", candidates or "無")
    return None


# ---------------------------------------------------------------- detection
class Counter:
    def __init__(self, cfg: dict):
        from ultralytics import YOLO  # 延後載入，--help 時不用等

        d = cfg.get("detection", {})
        self.model = YOLO(d.get("model", "yolov8s.pt"))
        self.conf = float(d.get("confidence", 0.35))
        self.imgsz = int(d.get("image_size", 960))
        # 等候區：以 0~1 的比例座標表示，與解析度無關
        self.roi = np.array(cfg.get("queue_zone", [[0, 0], [1, 0], [1, 1], [0, 1]]), dtype=np.float32)
        # 機器區：機器內有機車 = 使用中；這裡的車不算等候
        # 洗車間玻璃有水痕時 AI 可能看不清楚，所以另外和「空機照片」比對：
        # 畫面跟所有空機照片都差很多 → 也判定為使用中
        self.machines = []
        for i, m in enumerate(cfg.get("machine_zones", [])):
            refs = m.get("empty_references", [])
            self.machines.append({
                "name": m.get("name", f"機器{i + 1}"),
                "zone": np.array(m["zone"], dtype=np.float32),
                "refs": [img for img in (cv2.imread(r) for r in refs) if img is not None],
                "ref_paths": refs,
                "threshold": float(m.get("change_threshold", 0.15)),
            })
            missing = len(refs) - len(self.machines[-1]["refs"])
            if missing:
                log.warning("%s：有 %d 張空機照片讀不到", self.machines[-1]["name"], missing)
        # 排除區（例如店內停放的展示車、員工車）
        self.excludes = [np.array(p, dtype=np.float32) for p in cfg.get("exclude_zones", [])]

    @staticmethod
    def _inside(poly_norm: np.ndarray, pt: tuple[float, float], w: int, h: int) -> bool:
        poly = (poly_norm * [w, h]).astype(np.float32)
        return cv2.pointPolygonTest(poly, pt, False) >= 0

    @staticmethod
    def _prep(img: np.ndarray, size: tuple[int, int]) -> np.ndarray:
        g = cv2.cvtColor(cv2.resize(img, size), cv2.COLOR_BGR2GRAY)
        g = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(g)  # 降低明暗變化影響
        return cv2.GaussianBlur(g, (9, 9), 0)

    def change_score(self, frame: np.ndarray, m: dict) -> float | None:
        """機器區和空機照片相比，有多少比例的畫面明顯不同（0~1）。取與各張空機照片中最像的那張。"""
        if not m["refs"]:
            return None
        size = (640, 360)
        mask = np.zeros(size[::-1], np.uint8)
        cv2.fillPoly(mask, [(m["zone"] * size).astype(np.int32)], 255)
        cur = self._prep(frame, size)
        scores = []
        for ref in m["refs"]:
            diff = cv2.absdiff(cur, self._prep(ref, size))
            changed = (diff > 35) & (mask > 0)
            scores.append(changed.sum() / max(1, (mask > 0).sum()))
        return float(min(scores))

    def detect(self, frame: np.ndarray) -> tuple[list[dict], list[bool]]:
        h, w = frame.shape[:2]
        res = self.model.predict(frame, classes=[MOTORCYCLE_CLASS], conf=self.conf,
                                 imgsz=self.imgsz, verbose=False)[0]
        out = []
        for box, conf in zip(res.boxes.xyxy.tolist(), res.boxes.conf.tolist()):
            x1, y1, x2, y2 = box
            # 用車子「底部中心」判斷位置（輪子著地點），比框中心更準
            anchor = ((x1 + x2) / 2, y2 - (y2 - y1) * 0.1)
            machine = next((i for i, m in enumerate(self.machines)
                            if self._inside(m["zone"], anchor, w, h)), None)
            counted = machine is None and self._inside(self.roi, anchor, w, h) and not any(
                self._inside(ex, anchor, w, h) for ex in self.excludes)
            out.append({"box": box, "conf": conf, "anchor": anchor,
                        "counted": counted, "machine": machine})
        in_use = []
        self.last_scores = []
        for i, m in enumerate(self.machines):
            score = self.change_score(frame, m)
            self.last_scores.append(score)
            seen = any(d["machine"] == i for d in out)
            in_use.append(seen or (score is not None and score >= m["threshold"]))
        return out, in_use

    def annotate(self, frame: np.ndarray, dets: list[dict]) -> np.ndarray:
        img = frame.copy()
        h, w = img.shape[:2]
        cv2.polylines(img, [(self.roi * [w, h]).astype(np.int32)], True, (0, 220, 255), 3)
        for ex in self.excludes:
            cv2.polylines(img, [(ex * [w, h]).astype(np.int32)], True, (60, 60, 255), 3)
        for i, m in enumerate(self.machines):
            pts = (m["zone"] * [w, h]).astype(np.int32)
            cv2.polylines(img, [pts], True, (255, 120, 0), 3)
            score = self.last_scores[i] if i < len(getattr(self, "last_scores", [])) else None
            label = f"M{i + 1}" + (f" change {score:.2f}/{m['threshold']:.2f}" if score is not None else "")
            cv2.putText(img, label, tuple(pts[0] + [6, 34]), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 120, 0), 3)
        for d in dets:
            x1, y1, x2, y2 = map(int, d["box"])
            color = (80, 200, 80) if d["counted"] else (255, 120, 0) if d["machine"] is not None else (150, 150, 150)
            cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
            cv2.circle(img, tuple(map(int, d["anchor"])), 6, color, -1)
            cv2.putText(img, f"{d['conf']:.2f}", (x1, max(20, y1 - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
        n = sum(d["counted"] for d in dets)
        cv2.putText(img, f"queue: {n}", (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (0, 220, 255), 3)
        return img


# ---------------------------------------------------------------- publish
class Publisher:
    def __init__(self, cfg: dict, enabled: bool):
        self.local_path = Path(cfg.get("output", {}).get("local_file", "status.json"))
        self.client = None
        if not enabled:
            return
        r2 = cfg.get("r2", {})
        if not (r2.get("account_id") and r2.get("bucket") and r2.get("access_key_id")):
            log.warning("未設定 R2，只會寫入本機 %s", self.local_path)
            return
        import boto3

        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{r2['account_id']}.r2.cloudflarestorage.com",
            aws_access_key_id=r2["access_key_id"],
            aws_secret_access_key=r2["secret_access_key"],
            region_name="auto",
        )
        self.bucket = r2["bucket"]
        self.key = r2.get("key", "queue/status.json")

    def publish(self, status: dict) -> None:
        body = json.dumps(status, ensure_ascii=False).encode("utf-8")
        self.local_path.write_bytes(body)
        if self.client:
            self.client.put_object(
                Bucket=self.bucket, Key=self.key, Body=body,
                ContentType="application/json; charset=utf-8",
                CacheControl="no-store, max-age=0",
            )


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def in_business_hours(cfg: dict) -> bool:
    bh = cfg.get("business_hours")
    if not bh:
        return True
    now = datetime.now()
    day = str(now.isoweekday())  # 1=一 ... 7=日
    span = bh.get(day)
    if not span:
        return False
    start, end = span
    hm = now.strftime("%H:%M")
    return start <= hm < end


# ---------------------------------------------------------------- main loop
def main() -> int:
    ap = argparse.ArgumentParser(description="Xmoto 等候機車計數器")
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--source", help="改用影片/圖片/其他 RTSP 來源（測試用）")
    ap.add_argument("--once", action="store_true", help="只執行一次")
    ap.add_argument("--preview", action="store_true", help="輸出 preview.jpg 標註圖後結束")
    ap.add_argument("--save-reference", metavar="檔名",
                    help="把目前畫面存成空機照片（請在機器內沒有車時執行），例如 empty_day.jpg")
    ap.add_argument("--no-upload", action="store_true", help="不上傳 R2，只寫本機 status.json")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config(args.config)
    interval = float(cfg.get("interval_seconds", 30))
    window = int(cfg.get("smoothing_samples", 3))

    camera = Camera(source=args.source, cam=cfg["camera"])
    if args.save_reference:
        frame = camera.grab()
        if frame is None:
            log.error("讀不到攝影機畫面")
            return 1
        cv2.imwrite(args.save_reference, frame)
        log.info("已存成 %s，請把檔名加進 config.json 的 empty_references", args.save_reference)
        return 0
    counter = Counter(cfg)
    publisher = Publisher(cfg, enabled=not (args.no_upload or args.preview))
    history: deque[int] = deque(maxlen=max(1, window))
    machine_history: deque[list[bool]] = deque(maxlen=max(1, window))

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
            if not in_business_hours(cfg):
                publisher.publish({"connected": True, "open": False, "count": 0,
                                   "machines": [], "updatedAt": now_iso()})
                log.info("非營業時間")
            else:
                frame = camera.grab()
                if frame is None:
                    fails += 1
                    log.warning("讀不到攝影機畫面（連續 %d 次）", fails)
                    # 不更新 status.json → 網頁 2 分鐘後自動顯示「資料已過期」
                else:
                    fails = 0
                    dets, in_use = counter.detect(frame)
                    raw = sum(d["counted"] for d in dets)
                    if args.preview:
                        cv2.imwrite("preview.jpg", counter.annotate(frame, dets))
                        log.info("已輸出 preview.jpg（偵測到 %d 台機車，等候區 %d 台，機器使用中：%s，畫面變化：%s）",
                                 len(dets), raw, in_use,
                                 [None if x is None else round(x, 3) for x in counter.last_scores])
                        return 0
                    history.append(raw)
                    count = int(round(statistics.median(history)))
                    machine_history.append(in_use)
                    machines = [{"name": m["name"],
                                 "inUse": sum(h[i] for h in machine_history) * 2 > len(machine_history)}
                                for i, m in enumerate(counter.machines)]
                    status = {"connected": True, "open": True, "count": count,
                              "machines": machines, "updatedAt": now_iso()}
                    publisher.publish(status)
                    log.info("等候 %d 台 → 顯示 %d 台；機器：%s", raw, count,
                             ", ".join(f"{m['name']}={'使用中' if m['inUse'] else '空閒'}" for m in machines) or "未設定")
        except Exception:
            log.exception("執行錯誤，稍後重試")
        if args.once or args.preview:
            break
        time.sleep(max(1.0, interval - (time.monotonic() - started)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
