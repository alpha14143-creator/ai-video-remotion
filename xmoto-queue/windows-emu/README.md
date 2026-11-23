# 模擬器版（家裡電腦＋BlueStacks＋Tapo App）

不用重置攝影機、店裡不用放電腦。安裝在 `C:\xmoto-queue`：

| 檔案 | 用途 |
|---|---|
| `emu_counter.py`、`queue_counter.py` | 辨識程式（從 `counter/` 複製） |
| `emu-config.json` | 設定（從 `counter/emu-config.example.json` 複製，token 要和 n8n「Xmoto 狀態上傳」流程一致） |
| `empty_lf_day.jpg`、`empty_lf_night.jpg` | 洗車間沒車時的空機照片（`--save-reference` 拍攝） |
| `run_emu.bat` | 執行程式，當掉 20 秒後自動重啟 |
| `run_hidden.vbs` | 用隱藏視窗執行 `run_emu.bat` |

工作排程器（全部在登入 Windows 時自動啟動，不會出現視窗）：

| 工作名稱 | 執行 | 用途 |
|---|---|---|
| Xmoto BlueStacks Tapo | `HD-Player.exe --instance Tiramisu64 --cmd launchApp --package "com.tplink.iot"`（延遲 30 秒） | 開 BlueStacks 並直接進 Tapo |
| Xmoto Emu Counter | `wscript.exe run_hidden.vbs` → `run_emu.bat` | 辨識程式，當掉 20 秒後自動重啟 |
| Xmoto n8n | `wscript.exe run_n8n.vbs` | 背景執行 n8n（上傳結果到 R2） |
| Xmoto BlueStacks Daily Restart | 每天 04:00 執行 `restart_bluestacks.ps1` | 每日重開 BlueStacks，預防模擬器長時間運作卡死 |
| Xmoto Desktop Commander | `wscript.exe run_dc_hidden.vbs` → `run_dc.bat` | 遠端維護連線，斷線 30 秒後自動重連 |

需求：BlueStacks 開著、ADB 已開啟、Tapo App 停在首頁；家裡 n8n 開著（「Xmoto 狀態上傳」流程已發布）。
停止：工作管理員結束 `python.exe`（emu_counter）與 `cmd.exe`（run_emu.bat），或在工作排程器停用該工作。
紀錄：`C:\xmoto-queue\emu_counter.log`；最近一輪截圖：`last_queue.jpg`、`last_machine.jpg`。
