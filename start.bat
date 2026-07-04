@echo off
chcp 65001 >nul
REM ============================================================
REM  OpenDirector 啟動腳本
REM  - 檢查 Python
REM  - 首次執行自動安裝相依套件 (pywebview)
REM  - 啟動 app.py
REM ============================================================

setlocal
cd /d "%~dp0"

REM --- 找到 Python ---
set "PYTHON=python"
where %PYTHON% >nul 2>nul
if errorlevel 1 (
    set "PYTHON=py"
    where py >nul 2>nul
    if errorlevel 1 (
        echo [錯誤] 找不到 Python，請先安裝 Python 3.10 以上版本並加入 PATH。
        echo        下載： https://www.python.org/downloads/
        pause
        exit /b 1
    )
)

REM --- 確認 pywebview 是否已安裝，缺少則安裝相依套件 ---
%PYTHON% -c "import webview" >nul 2>nul
if errorlevel 1 (
    echo [資訊] 首次啟動，安裝相依套件中...
    %PYTHON% -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [錯誤] 相依套件安裝失敗，請檢查網路或 pip 設定。
        pause
        exit /b 1
    )
)

REM --- 啟動應用程式 (可加 --debug 開啟開發者工具) ---
echo [資訊] 啟動 OpenDirector...
%PYTHON% app.py %*
if errorlevel 1 (
    echo.
    echo [錯誤] 應用程式異常結束。
    pause
    exit /b 1
)

endlocal
