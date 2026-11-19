# Xmoto 現場狀況網頁

網頁只顯示兩件事：**機器有沒有使用中**、**現場等待機車台數**。不顯示任何畫面。

Tapo C210 拍等候區 → 店內樹莓派用 AI 數機車 → 每 30 秒把 `status.json` 上傳到 Cloudflare R2 → 客人開網頁看到數字。

```
[Tapo C210] --RTSP(店內 Wi-Fi)--> [樹莓派: queue_counter.py] --上傳--> [R2: status.json] <--讀取-- [網頁 index.html]
```

- **只上傳數字，不上傳畫面**：客人的臉和車牌不會出現在網路上。
- 樹莓派斷電、攝影機斷線時，網頁會在 2 分鐘後自動改成「資料已過期」，不會顯示錯的數字。

## 需要準備

店內不需要電腦，放一台**樹莓派（Raspberry Pi）**就好：巴掌大、插電即用、不用螢幕，24 小時開著很省電。

| 項目 | 說明 | 參考價 |
|---|---|---|
| Raspberry Pi 5（4GB）或 Pi 4（4GB） | 跑計數程式 | 約 NT$2,000–2,800 |
| 官方電源、32GB 以上 microSD 卡、外殼 | | 約 NT$600–900 |
| Cloudflare R2 | 就是目前放網頁的地方 | 免費額度內 |

> 用 Pi 4 的話，建議把 `detection.model` 改成 `yolov8n.pt`，速度比較快。

### 店內 Wi-Fi 是浮動 IP 也沒關係

- **對外 IP 浮動**：不影響。樹莓派只「往外上傳」數字到 R2，外面不需要連進店裡，所以不用固定 IP、不用設定路由器。
- **攝影機在店內的 IP 會變**：`camera.ip` 設為 `"auto"`，程式會自動掃描 Wi-Fi 找到攝影機；IP 換了也會自動重新找。
- 店裡如果有多台 Tapo，在 `camera.mac` 填 C210 的 MAC 位址（Tapo App →「裝置資訊」可查），程式就只會認這一台。

### 樹莓派安裝（一次性，約 30 分鐘）

1. 用電腦下載 [Raspberry Pi Imager](https://www.raspberrypi.com/software/)，燒錄 **Raspberry Pi OS Lite (64-bit)**。燒錄前在設定裡填好**店內 Wi-Fi 名稱密碼**，並開啟 **SSH**。
2. SD 卡插進樹莓派、插電，等 2 分鐘。
3. 用手機或電腦 SSH 連進去（例如 `ssh pi@raspberrypi.local`），執行：
   ```bash
   sudo apt-get install -y git
   git clone <這個 repo 的網址> && cd ai-video-remotion/xmoto-queue
   sudo bash pi/install.sh
   ```
4. 照畫面提示，填 `/opt/xmoto-queue/config.json` 和 `/opt/xmoto-queue/secrets.env`，再 `sudo systemctl start xmoto-queue`。

之後停電、重開機都會自動恢復執行。下面第一～四步的設定說明同樣適用，只是設定檔在 `/opt/xmoto-queue/`。

## 第一步：開啟 Tapo C210 的 RTSP

1. Tapo App → 點進攝影機 → 右上角齒輪 →「進階設定」→「攝影機帳戶」
2. 設定一組帳號密碼（這不是你的 TP-Link 帳號，是攝影機專用的）
3. IP 不用查，程式會自動找（`camera.ip` 保持 `"auto"`）。
4. 隱私模式要關閉，不然抓不到畫面。

## 第二步：安裝計數程式

```bash
cd xmoto-queue/counter
pip install -r requirements.txt
cp config.example.json config.json   # Windows 用 copy
```

編輯 `config.json`，填入攝影機 IP 與帳號。密碼建議用環境變數：

```bash
# Mac / Linux
export TAPO_PASSWORD='攝影機密碼'
# Windows PowerShell
$env:TAPO_PASSWORD='攝影機密碼'
```

## 第三步：畫出「等候區」（最重要）

```bash
python queue_counter.py --config config.json --preview
```

會產生 `preview.jpg`：

- **黃框** = 等候區，只有輪子落在框內的機車才算
- **綠框** = 有算進去的機車；**灰框** = 偵測到但不在等候區
- **藍框（M1）** = 機器區，框內有機車 = 機器「使用中」，這台車不算等候
- **紅框** = 排除區（例如展示車、員工車）

`config.json` 裡的 `queue_zone` 用 0~1 的比例座標（左上角 `[0,0]`、右下角 `[1,1]`），
調整後重跑 `--preview`，直到黃框剛好框住排隊的位置。

`machine_zones` 框住機器上（或機器正前方）機車會停的位置。有多台機器就加多組，例如：

```json
"machine_zones": [
  {"name": "1 號機", "zone": [[0.60,0.20],[0.80,0.20],[0.80,0.60],[0.60,0.60]]},
  {"name": "2 號機", "zone": [[0.80,0.20],[0.98,0.20],[0.98,0.60],[0.80,0.60]]}
]
```

若框內常停放非等候的車，用 `exclude_zones` 排除。

## 第四步：連到 R2

1. Cloudflare 後台 → R2 →「管理 R2 API 權杖」→ 建立權杖，權限選 **物件讀取和寫入**，限定你的 bucket
2. 把 Account ID、bucket 名稱填到 `config.json`，金鑰用環境變數：
   ```bash
   export R2_ACCESS_KEY_ID='...'
   export R2_SECRET_ACCESS_KEY='...'
   ```
3. `r2.key` 要和網頁放在**同一個資料夾**。例如網頁是 `xmoto-queue/index.html`，key 就是 `xmoto-queue/status.json`
4. 把 `web/index.html` 上傳到同一個資料夾

測試一次：

```bash
python queue_counter.py --config config.json --once
```

打開網頁應該就會看到數字。

## 第五步：正式執行

- **樹莓派**：`sudo systemctl start xmoto-queue`（安裝時已設定開機自動執行）。查看紀錄：`journalctl -u xmoto-queue -f`
- 用一般電腦測試時：`python queue_counter.py --config config.json`

## 可調整的設定

| 設定 | 說明 |
|---|---|
| `interval_seconds` | 幾秒算一次（預設 30，與網頁同步） |
| `smoothing_samples` | 取最近幾次的中位數，避免路人經過數字亂跳（預設 3） |
| `business_hours` | 預設 `null` = 24 小時營業。若之後有固定休息時段，可設定如 `{"1":["09:00","20:00"], ..., "7":null}`（1=週一…7=週日），休息時網頁顯示「休息中」 |
| `detection.model` | `yolov8n.pt` 較快、`yolov8s.pt` 較準（預設），電腦夠力可用 `yolov8m.pt` |
| `detection.confidence` | 調高可減少誤判，調低可減少漏數 |
| `camera.stream` | `stream1` 高畫質（較準）、`stream2` 低畫質（較省資源） |

## 網頁 `status.json` 格式

```json
{"connected": true, "open": true, "count": 4, "machines": [{"name": "機器", "inUse": true}], "updatedAt": "2026-11-19T06:30:00Z"}
```

網頁加上 `?demo=1` 可看示範畫面。

## 注意事項

- 攝影機角度越高、越俯視，機車越不會互相遮擋，數得越準。
- 先在 `--preview` 模式實際比對幾天，確認準確度後再公開網址。
- 依個資法，店內應張貼「錄影監控中」告示（本程式不對外傳送影像）。
