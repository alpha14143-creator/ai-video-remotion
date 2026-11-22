@echo off
rem Xmoto 等候計數器（模擬器版）：當掉 20 秒後自動重啟
cd /d C:\xmoto-queue
:loop
C:\xmoto-queue\venv\Scripts\python.exe emu_counter.py --config emu-config.json >> C:\xmoto-queue\run.log 2>&1
timeout /t 20 /nobreak >nul
goto loop
