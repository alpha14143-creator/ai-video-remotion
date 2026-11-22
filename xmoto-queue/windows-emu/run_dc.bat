@echo off
rem Desktop Commander 遠端連線：斷掉 30 秒後自動重新連線
:loop
call npx.cmd --yes --cache "%TEMP%\dc-cache" @wonderwhy-er/desktop-commander@latest remote >> "C:\xmoto-queue\dc.log" 2>&1
timeout /t 30 /nobreak >nul
goto loop
