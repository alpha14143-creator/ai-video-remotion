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


def rtsp_url(cam: dict) -> str:
    user = quote(cam["username"], safe="")
    pwd = quote(cam["password"], safe="")
    stream = cam.get("stream", "stream1")  # stream1 = 高畫質, stream2 = 低畫質
    return f"rtsp://{user}:{pwd}@{cam['ip']}:{cam.get('port', 554)}/{stream}"


# ---------------------------------------------------------------- camera
class Camera:
    """每次需要時才連線抓一張最新畫面，避免長時間連線的緩衝延遲與斷線問題。"""

    def __init__(self, source: str):
        self.source = source

    def grab(self) -> np.ndarray | None:
        if not self.source.startswith("rtsp://") and Path(self.source).is_file():
            return cv2.imread(self.source)
        cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG)
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
        # 機器區：機器上（或機器前）有機車 = 使用中；這裡的車不算等候
        self.machines = [{"name": m.get("name", f"機器{i + 1}"),
                          "zone": np.array(m["zone"], dtype=np.float32)}
                         for i, m in enumerate(cfg.get("machine_zones", []))]
        # 排除區（例如店內停放的展示車、員工車）
        self.excludes = [np.array(p, dtype=np.float32) for p in cfg.get("exclude_zones", [])]

    @staticmethod
    def _inside(poly_norm: np.ndarray, pt: tuple[float, float], w: int, h: int) -> bool:
        poly = (poly_norm * [w, h]).astype(np.float32)
        return cv2.pointPolygonTest(poly, pt, False) >= 0

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
        in_use = [any(d["machine"] == i for d in out) for i in range(len(self.machines))]
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
            cv2.putText(img, f"M{i + 1}", tuple(pts[0] + [6, 28]), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 120, 0), 2)
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
    ap.add_argument("--no-upload", action="store_true", help="不上傳 R2，只寫本機 status.json")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config(args.config)
    interval = float(cfg.get("interval_seconds", 30))
    window = int(cfg.get("smoothing_samples", 3))

    source = args.source or rtsp_url(cfg["camera"])
    camera = Camera(source)
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
                        log.info("已輸出 preview.jpg（偵測到 %d 台機車，等候區 %d 台，機器使用中：%s）",
                                 len(dets), raw, in_use)
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
