# 模擬器版（家裡電腦＋BlueStacks＋Tapo App）

不用重置攝影機、店裡不用放電腦。安裝在 `C:\xmoto-queue`：

| 檔案 | 用途 |
|---|---|
| `emu_counter.py`、`queue_counter.py` | 辨識程式（從 `counter/` 複製） |
| `emu-config.json` | 設定（從 `counter/emu-config.example.json` 複製，token 要和 n8n「Xmoto 狀態上傳」流程一致） |
| `empty_lf_day.jpg`、`empty_lf_night.jpg` | 洗車間沒車時的空機照片（`--save-reference` 拍攝） |
| `run_emu.bat` | 執行程式，當掉 20 秒後自動重啟 |
| `run_hidden.vbs` | 用隱藏視窗執行 `run_emu.bat` |

工作排程器「Xmoto Emu Counter」：登入 Windows 時執行 `wscript.exe "C:\xmoto-queue\run_hidden.vbs"`。

需求：BlueStacks 開著、ADB 已開啟、Tapo App 停在首頁；家裡 n8n 開著（「Xmoto 狀態上傳」流程已發布）。
停止：工作管理員結束 `python.exe`（emu_counter）與 `cmd.exe`（run_emu.bat），或在工作排程器停用該工作。
紀錄：`C:\xmoto-queue\emu_counter.log`；最近一輪截圖：`last_queue.jpg`、`last_machine.jpg`。
