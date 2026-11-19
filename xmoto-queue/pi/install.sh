#!/usr/bin/env bash
# Raspberry Pi 一鍵安裝：sudo bash install.sh
# 會安裝到 /opt/xmoto-queue，並設定成開機自動執行、當機自動重啟。
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "請用 sudo bash install.sh 執行"; exit 1; }

SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/xmoto-queue

apt-get update
apt-get install -y python3-venv python3-pip libgl1 iproute2

mkdir -p "$APP"
cp "$SRC/counter/queue_counter.py" "$SRC/counter/requirements.txt" "$APP/"
[ -f "$APP/config.json" ] || cp "$SRC/counter/config.example.json" "$APP/config.json"
[ -f "$APP/secrets.env" ] || cat > "$APP/secrets.env" <<'ENV'
TAPO_PASSWORD=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
ENV
chmod 600 "$APP/secrets.env"

python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install --upgrade pip
"$APP/venv/bin/pip" install -r "$APP/requirements.txt"
# 先下載模型，之後斷網重開也能跑
(cd "$APP" && "$APP/venv/bin/python" -c "from ultralytics import YOLO; YOLO('yolov8s.pt')")

cp "$SRC/pi/xmoto-queue.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable xmoto-queue

cat <<MSG

安裝完成。接下來：
  1. sudo nano $APP/config.json     填攝影機帳號、R2 資料
  2. sudo nano $APP/secrets.env     填密碼與 R2 金鑰
  3. cd $APP && sudo venv/bin/python queue_counter.py --preview   產生 preview.jpg 檢查框選範圍
     （需先執行：set -a; . $APP/secrets.env; set +a）
  4. sudo systemctl start xmoto-queue     開始執行
     journalctl -u xmoto-queue -f         查看執行紀錄
MSG
