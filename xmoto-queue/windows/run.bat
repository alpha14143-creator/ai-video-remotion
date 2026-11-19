@echo off
rem 由工作排程器在開機時執行；程式結束或當掉會在 20 秒後自動重啟
cd /d "%~dp0..\counter"
if not exist logs mkdir logs
:loop
for %%A in (logs\counter.log) do if %%~zA GTR 10000000 move /Y logs\counter.log logs\counter.old.log >nul
venv\Scripts\python queue_counter.py --config config.json >> logs\counter.log 2>&1
timeout /t 20 /nobreak >nul
goto loop
