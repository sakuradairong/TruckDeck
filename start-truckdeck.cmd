@echo off
title TruckDeck
cd /d "%~dp0"

echo ============================================================
echo   TruckDeck 中控服务
echo   模式：自动判定（游戏在运行 = 实时遥测，否则模拟 mock）
echo   端口：4000    WebSocket 路径：/ws
echo   停止：按 Ctrl+C，或直接关闭本窗口
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

echo Node 版本：
node --version
echo.
echo 本机可用地址，手机与电脑在同一网段时任选其一：
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do echo    http://%%a:4000
echo.
echo -------------------- 启动日志 --------------------
echo.

npm start

echo.
echo -------------------- 服务已退出 --------------------
echo 若日志出现 EADDRINUSE，说明 4000 端口被占用。
echo 查看占用： netstat -ano ^| findstr :4000
echo 结束占用： taskkill /PID 上面的PID /T /F
echo.
pause
exit /b 0

:nonode
echo [错误] 未找到 node 命令。
echo 请先安装 Node.js 22 或更高版本，并加入 PATH：https://nodejs.org/
echo.
pause
exit /b 1
