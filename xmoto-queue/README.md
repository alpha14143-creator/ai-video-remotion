# Xmoto 現場狀況網頁

網頁只顯示兩件事：**機器有沒有使用中**、**現場等待機車台數**。不顯示任何畫面。

Tapo C210 拍等候區 → 店內舊電腦用 AI 數機車 → 每 30 秒把 `status.json` 上傳到 Cloudflare R2 → 客人開網頁看到數字。

```
[Tapo C210] --RTSP(店內 Wi-Fi)--> [店內電腦: queue_counter.py] --上傳--> [R2: status.json] <--讀取-- [網頁 index.html]
```

- **只上傳數字，不上傳畫面**：客人的臉和車牌不會出現在網路上。
- 電腦關機、攝影機斷線時，網頁會在 2 分鐘後自動改成「資料已過期」，不會顯示錯的數字。

## 需要準備：一台舊電腦（建議做法，不用買新設備）

| 項目 | 最低需求 |
|---|---|
| 作業系統 | Windows 10 或 11（64 位元） |
| CPU | 近 10 年內的 Intel / AMD 都可以（太舊的話把 `detection.model` 改成 `yolov8n.pt`） |
| 記憶體 | 4GB 以上 |
| 硬碟空間 | 剩 5GB 以上 |
| 網路 | 最好用**網路線接數據機**（比 Wi-Fi 穩）；用 Wi-Fi 也可以 |

筆電可以闔上螢幕放著，但要在「電源選項 → 闔上螢幕時」設成「不執行任何動作」。

### Windows 安裝步驟（一次性，約 30 分鐘）

1. 安裝 [Python 3.12](https://www.python.org/downloads/)，安裝畫面**務必勾選「Add python.exe to PATH」**
2. 把整個 `xmoto-queue` 資料夾複製到電腦，例如 `C:\xmoto-queue`（路徑不要有中文或空格）
3. 進到 `windows` 資料夾，依序雙擊：

| 檔案 | 用途 |
|---|---|
| `1_install.bat` | 安裝程式，完成後會自動打開兩個設定檔讓你填（見下方「第一～四步」） |
| `2_preview.bat` | 抓一張畫面，產生標註圖 `preview.jpg`，確認框選範圍 |
| `3_save_empty_photo.bat` | 洗車間**沒車**時拍空機照片，白天、晚上各執行一次 |
| `4_enable_autostart.bat` | **按右鍵 →「以系統管理員身分執行」**：設定開機自動執行（不用登入 Windows）、電腦永不睡眠，並立即啟動 |
| `5_disable_autostart.bat` | 要停止時用（同樣以系統管理員身分執行） |

執行紀錄在 `counter\logs\counter.log`；程式當掉會在 20 秒後自動重啟。

### 讓舊電腦 24 小時穩定運作

- **停電後自動開機**：開機時按 `Del` 或 `F2` 進入 BIOS，找「Restore on AC Power Loss」或「AC Back」，設成 **Power On**（每台電腦名稱不同；筆電通常不需要，因為有電池）
- **Windows 更新**：設定 → Windows Update → 使用時間，設成你最不希望重開機的時段；更新重開機後程式會自動恢復
- **遠端維修**：安裝「Chrome 遠端桌面」（免費），在家就能連進店裡的電腦看狀況
- **不要裝其他會吃效能的軟體**，關掉不需要的開機程式

## 另一個選擇：樹莓派

店內沒有舊電腦時，也可以放一台**樹莓派（Raspberry Pi）**：巴掌大、插電即用、不用螢幕，24 小時開著很省電。

| 項目 | 說明 | 參考價 |
|---|---|---|
| Raspberry Pi 5（4GB） | 跑計數程式 | 2026 年記憶體漲價後官方定價約 US$110，以店家實際價格為準 |
| 官方 27W 電源、主動散熱器、外殼、64GB 高耐久 microSD | | 約 NT$1,000–2,000 |
| Cloudflare R2 | 就是目前放網頁的地方 | 免費額度內 |

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

## 店內 Wi-Fi 是浮動 IP 也沒關係

- **對外 IP 浮動**：不影響。店內電腦（或樹莓派）只「往外上傳」數字到 R2，外面不需要連進店裡，所以不用固定 IP、不用設定路由器。
- **攝影機在店內的 IP 會變**：`camera.ip` 設為 `"auto"`，程式會自動掃描 Wi-Fi 找到攝影機；IP 換了也會自動重新找。
- 店裡如果有多台 Tapo，在 `camera.mac` 填 C210 的 MAC 位址（Tapo App →「裝置資訊」可查），程式就只會認這一台。

## 第一步：開啟 Tapo C210 的 RTSP

1. Tapo App → 點進攝影機 → 右上角齒輪 →「進階設定」→「攝影機帳戶」
2. 設定一組帳號密碼（這不是你的 TP-Link 帳號，是攝影機專用的）
3. IP 不用查，程式會自動找（`camera.ip` 保持 `"auto"`）。
4. 隱私模式要關閉，不然抓不到畫面。

## 第二步：填設定檔

Windows 舊電腦：執行 `1_install.bat` 就會安裝好，並打開下面兩個檔案。（樹莓派用 `pi/install.sh`；其他系統手動 `pip install -r requirements.txt`，再複製 `config.example.json` → `config.json`、`secrets.example.env` → `secrets.env`。）

- `config.json`：填攝影機帳號（`camera.username`）、R2 的 `account_id` 和 `bucket`。攝影機 IP 保持 `"auto"`
- `secrets.env`：填攝影機密碼和 R2 金鑰。**這個檔案不要分享給別人**

```
TAPO_PASSWORD=攝影機密碼
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
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

`machine_zones` 框住**洗車間玻璃內的地板**。`config.example.json` 已經依照店內 C210 的實際畫面框好：

- 黃框（等候區）：洗車間左邊、上方那格黃黑線停車位與走道
- 紅框（擦車區）：吹水機旁的停車格，洗完在這裡擦車，**不算等候**
- 藍框（洗車機）：白鐵玻璃窗內的地板。洗車時玻璃有水、燈會變藍，AI 常看不到車，主要靠「空機照片比對」判斷
- 畫面最上方路邊停的機車不在黃框內，不會被算進去

**空機照片（建議一定要做）**：洗車間玻璃常有水痕，AI 可能看不清楚裡面的車。所以程式會另外和「洗車間沒車時的照片」比對，畫面差很多就判定為使用中。
在洗車間**沒有車**的時候各拍一張白天、一張晚上（燈光不同）：

```bash
python queue_counter.py --config config.json --save-reference empty_day.jpg    # 白天
python queue_counter.py --config config.json --save-reference empty_night.jpg  # 晚上
```

`--preview` 的圖上會顯示 `change 0.03/0.15`，前面是目前畫面變化量，後面是門檻（`change_threshold`）。
空機時的數字要明顯低於門檻、有車時要明顯高於門檻；不準的話調整 `change_threshold`。
店內擺設或燈光改變後，記得重拍空機照片。

若框內常停放非等候的車，用 `exclude_zones` 排除。

## 第四步：連到 R2

1. Cloudflare 後台 → R2 →「管理 R2 API 權杖」→ 建立權杖，權限選 **物件讀取和寫入**，限定你的 bucket
2. 把 Account ID、bucket 名稱填到 `config.json`，金鑰填到 `secrets.env`
3. `r2.key` 要和網頁放在**同一個資料夾**。例如網頁是 `xmoto-queue/index.html`，key 就是 `xmoto-queue/status.json`
4. 把 `web/index.html` 上傳到同一個資料夾

測試一次：

```bash
python queue_counter.py --config config.json --once
```

打開網頁應該就會看到數字。

## 第五步：正式執行

- **Windows 舊電腦**：以系統管理員身分執行 `windows\4_enable_autostart.bat`，之後開機自動執行
- **樹莓派**：`sudo systemctl start xmoto-queue`（安裝時已設定開機自動執行）。查看紀錄：`journalctl -u xmoto-queue -f`
- 用一般電腦測試時：`python queue_counter.py --config config.json`

## 可調整的設定

| 設定 | 說明 |
|---|---|
| `interval_seconds` | 幾秒算一次（預設 30，與網頁同步） |
| `smoothing_samples` | 取最近幾次的中位數，避免路人經過數字亂跳（預設 3） |
| `business_hours` | 預設 `null` = 24 小時營業。若之後有固定休息時段，可設定如 `{"1":["09:00","20:00"], ..., "7":null}`（1=週一…7=週日），休息時網頁顯示「休息中」 |
| `detection.model` | `yolov8n.pt` 較快、`yolov8s.pt` 較準（預設），電腦夠力可用 `yolov8m.pt` |
| `detection.max_box_height` | 框的高度超過畫面幾成就忽略（避免把牆上的機車海報當成車），預設 0.7 |
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
