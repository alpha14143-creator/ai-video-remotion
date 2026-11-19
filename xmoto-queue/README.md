# Xmoto 現場狀況網頁

網頁只顯示兩件事：**機器有沒有使用中**、**現場等待機車台數**。不顯示任何畫面。

Tapo C210 拍等候區 → 店內電腦用 AI 數機車 → 每 30 秒把 `status.json` 上傳到 Cloudflare R2 → 客人開網頁看到數字。

```
[Tapo C210] --RTSP(店內網路)--> [店內電腦: queue_counter.py] --上傳--> [R2: status.json] <--讀取-- [網頁 index.html]
```

- **只上傳數字，不上傳畫面**：客人的臉和車牌不會出現在網路上。
- 電腦關機、攝影機斷線時，網頁會在 2 分鐘後自動改成「資料已過期」，不會顯示錯的數字。

## 需要準備

| 項目 | 說明 |
|---|---|
| 店內電腦 | 一台 Windows / Mac / 迷你電腦皆可，要一直開著，和攝影機在**同一個 Wi-Fi**。普通筆電 CPU 就跑得動（每 30 秒算一次）。 |
| Python 3.10 以上 | https://www.python.org/downloads/ |
| Cloudflare R2 | 就是目前放網頁的地方 |

## 第一步：開啟 Tapo C210 的 RTSP

1. Tapo App → 點進攝影機 → 右上角齒輪 →「進階設定」→「攝影機帳戶」
2. 設定一組帳號密碼（這不是你的 TP-Link 帳號，是攝影機專用的）
3. 「裝置資訊」裡查看攝影機的 **IP 位址**（例如 `192.168.1.50`）
   - 建議在路由器把這個 IP 設為固定，不然重開機後可能會變。
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

## 第五步：正式執行（開機自動啟動）

```bash
python queue_counter.py --config config.json
```

- **Windows**：工作排程器 →「建立基本工作」→ 觸發：電腦啟動時 → 動作：啟動 `python`，引數 `queue_counter.py --config config.json`，起始位置填 counter 資料夾
- **Mac**：可用 `launchd`；**Linux / 樹莓派**：用 systemd 或 `crontab @reboot`

## 可調整的設定

| 設定 | 說明 |
|---|---|
| `interval_seconds` | 幾秒算一次（預設 30，與網頁同步） |
| `smoothing_samples` | 取最近幾次的中位數，避免路人經過數字亂跳（預設 3） |
| `business_hours` | 營業時間（1=週一…7=週日，`null`=公休），非營業時間網頁顯示「非營業時間」 |
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
