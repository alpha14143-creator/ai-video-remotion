@echo off
chcp 65001 >nul
cd /d "%~dp0..\counter"
echo ==== Xmoto 等候計數器：安裝 ====
where python >nul 2>nul || (
  echo [錯誤] 找不到 Python。請先到 https://www.python.org/downloads/ 安裝 Python 3.12，
  echo        安裝時務必勾選「Add python.exe to PATH」，裝好後重新執行本檔案。
  pause & exit /b 1
)
if not exist venv (
  echo 建立執行環境...
  python -m venv venv || (echo [錯誤] 建立失敗 & pause & exit /b 1)
)
echo 安裝套件（第一次約 5-15 分鐘）...
venv\Scripts\python -m pip install --upgrade pip
venv\Scripts\python -m pip install -r requirements.txt || (echo [錯誤] 套件安裝失敗 & pause & exit /b 1)
echo 下載 AI 模型...
venv\Scripts\python -c "from ultralytics import YOLO; YOLO('yolov8s.pt')"
if not exist config.json copy config.example.json config.json >nul
if not exist secrets.env copy secrets.example.env secrets.env >nul
echo.
echo 安裝完成！接下來：
echo   1. 用記事本打開 counter\config.json  填攝影機帳號、R2 資料
echo   2. 用記事本打開 counter\secrets.env  填攝影機密碼、R2 金鑰
echo   3. 執行 2_preview.bat 檢查畫面
start "" notepad config.json
start "" notepad secrets.env
pause
