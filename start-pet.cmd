@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo [whale-pet-shell] 依赖还没装，先运行:  npm install
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
