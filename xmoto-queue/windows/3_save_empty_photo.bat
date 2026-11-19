@echo off
chcp 65001 >nul
cd /d "%~dp0..\counter"
echo 請確認「洗車間裡沒有機車」再繼續。
echo   1 = 白天照片 (empty_day.jpg)
echo   2 = 晚上照片 (empty_night.jpg)
set /p CHOICE=請輸入 1 或 2：
if "%CHOICE%"=="1" set NAME=empty_day.jpg
if "%CHOICE%"=="2" set NAME=empty_night.jpg
if not defined NAME (echo 輸入錯誤 & pause & exit /b 1)
venv\Scripts\python queue_counter.py --config config.json --save-reference %NAME%
if exist %NAME% start "" %NAME%
pause
