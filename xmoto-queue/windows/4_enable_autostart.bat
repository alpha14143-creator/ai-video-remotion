@echo off
chcp 65001 >nul
net session >nul 2>&1 || (
  echo 請在這個檔案上按右鍵 →「以系統管理員身分執行」
  pause & exit /b 1
)
set RUN=%~dp0run.bat
echo 設定開機自動執行（不用登入 Windows 也會跑）...
schtasks /Create /TN "Xmoto Queue Counter" /TR "\"%RUN%\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F || (pause & exit /b 1)
echo 設定每天 04:00 自動重開機（要改時間就改下面的 04:00）...
schtasks /Create /TN "Xmoto Daily Reboot" /TR "shutdown /r /f /t 60 /c \"Xmoto daily reboot\"" /SC DAILY /ST 04:00 /RU SYSTEM /RL HIGHEST /F
echo 設定電腦永不睡眠、不休眠...
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0
echo 立即啟動...
schtasks /Run /TN "Xmoto Queue Counter"
echo.
echo 完成！每天 04:00 會自動重開機，重開後程式自動恢復。
echo 執行紀錄在 counter\logs\counter.log
echo 要停止：執行 5_disable_autostart.bat
pause
