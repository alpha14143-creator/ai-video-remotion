@echo off
chcp 65001 >nul
cd /d "%~dp0..\counter"
echo 抓取攝影機畫面並分析中...
venv\Scripts\python queue_counter.py --config config.json --preview
if exist preview.jpg start "" preview.jpg
pause
