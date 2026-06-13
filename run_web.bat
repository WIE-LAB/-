@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo   语音绘图 VoicePaint Web 版
echo   浏览器语音识别 + 通义万相文生图
echo ========================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python，请先安装 Python 3.10+
    pause
    exit /b 1
)

if not exist "venv\Scripts\python.exe" (
    echo [1/3] 创建虚拟环境...
    python -m venv venv
)

echo [2/3] 安装依赖...
venv\Scripts\pip install -r requirements.txt -q

echo [3/3] 启动 Web 服务并打开浏览器...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr "LISTENING"') do (
    echo 关闭占用 8765 端口的旧进程 PID=%%a
    taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:8765"
venv\Scripts\python -m voice_paint.web_server
pause
