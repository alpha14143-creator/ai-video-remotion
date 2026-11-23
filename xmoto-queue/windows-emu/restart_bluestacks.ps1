# 每日例行重開 BlueStacks（清掉長時間運作累積的問題），開完直接進 Tapo
Get-Process HD-Player -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 8
Start-Process -FilePath 'C:\Program Files\BlueStacks_nxt\HD-Player.exe' -ArgumentList '--instance Tiramisu64 --cmd launchApp --package "com.tplink.iot"' -WorkingDirectory 'C:\Program Files\BlueStacks_nxt'
