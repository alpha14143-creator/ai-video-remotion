@echo off
chcp 65001 >nul
net session >nul 2>&1 || (
  echo 請在這個檔案上按右鍵 →「以系統管理員身分執行」
  pause & exit /b 1
)
schtasks /End /TN "Xmoto Queue Counter" >nul 2>&1
schtasks /Delete /TN "Xmoto Queue Counter" /F
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*xmoto-queue*run.bat*' -or $_.CommandLine -like '*queue_counter.py*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo 已停止並取消開機自動執行。
pause
