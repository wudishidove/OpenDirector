# OpenDirector

Python + pywebview desktop video editor prototype based on `ui/project/影片剪輯介面 1a.dc.html`.

## Requirements

- Python 3.10+
- Local `ffmpeg` and `ffprobe` in `PATH`
- `pywebview`

Install Python dependency:

```powershell
pip install -r requirements.txt
```

If ffmpeg is not in `PATH`, set:

```powershell
$env:OPEN_DIRECTOR_FFMPEG="C:\path\to\ffmpeg.exe"
$env:OPEN_DIRECTOR_FFPROBE="C:\path\to\ffprobe.exe"
```

## Run

Windows 直接雙擊 `start.bat` 即可（首次啟動會自動安裝相依套件）：

```powershell
.\start.bat
```

或手動啟動：

```powershell
python app.py
```

加上 `--debug` 可開啟開發者工具（例如 `.\start.bat --debug`）。

## Project files

- 「儲存專案」/ `Ctrl+S` saves the timeline to a `.odproj` JSON file (`Ctrl+Shift+S` = save-as).
- 「開啟專案」/ `Ctrl+O` loads a `.odproj` file; media paths are re-probed and missing files are reported.
- Project files store only editing data (clip sources, trims, speeds, subtitles) — per-run data such as preview-proxy URLs is stripped on save and rebuilt on load.
- The timeline is also auto-persisted to localStorage between runs, independent of project files.

## Tests

Each subsystem is exercised by scripts (no GUI needed):

```powershell
python scripts/test_backend.py   # probe / media server / export / cancel / preview proxy / save-load
node scripts/test_frontend.mjs   # split / merge / speed / copy-paste / undo / project sanitization
```

## GPU Encoding

The app detects local ffmpeg encoders and prefers GPU encoders in this order:

- `h264_nvenc` / `hevc_nvenc`
- `h264_qsv` / `hevc_qsv`
- `h264_amf` / `hevc_amf`
- `h264_videotoolbox` / `hevc_videotoolbox`

Choose `自動 GPU` in the toolbar to use the first detected GPU encoder, or choose `CPU libx264` to force CPU encoding.
