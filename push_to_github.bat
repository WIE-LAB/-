@echo off
chcp 65001 >nul
cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 (
    echo [错误] 未安装 Git。请先安装: https://git-scm.com/download/win
    echo 安装后重新运行本脚本。
    pause
    exit /b 1
)

if not exist "config.json" (
    echo [提示] 未找到 config.json，从 config.example.json 复制一份...
    copy config.example.json config.json >nul
)

if not exist ".git" (
    echo [1/4] 初始化 Git 仓库...
    git init
    git branch -M main
)

echo [2/4] 添加文件...
git add .
git status

echo.
echo [3/4] 提交...
git commit -m "feat: VoicePaint Web - 纯语音 AI 绘图" 2>nul
if errorlevel 1 (
    echo 没有新改动需要提交，或提交失败。
)

echo.
echo [4/4] 推送到 GitHub...
echo.
echo 如果还没创建远程仓库，请先在 GitHub 网页上新建仓库（不要勾选 README），
echo 然后执行（把 YOUR_USERNAME 和 REPO_NAME 换成你的）:
echo.
echo   git remote add origin https://github.com/YOUR_USERNAME/REPO_NAME.git
echo   git push -u origin main
echo.
set /p HAS_REMOTE="是否已添加 remote 并要现在推送? (y/n): "
if /i "%HAS_REMOTE%"=="y" (
    git push -u origin main
)

pause
