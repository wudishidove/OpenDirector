from __future__ import annotations

import json
import mimetypes
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote
from pathlib import Path
from typing import Any


VIDEO_FILE_TYPES = (
    "Media files (*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v;*.mp3;*.wav;*.aac;*.flac;*.m4a;*.ogg)",
    "Video files (*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v)",
    "Audio files (*.mp3;*.wav;*.aac;*.flac;*.m4a;*.ogg)",
    "All files (*.*)",
)

GPU_ENCODER_PREFERENCE = (
    "h264_nvenc",
    "hevc_nvenc",
    "h264_qsv",
    "hevc_qsv",
    "h264_amf",
    "hevc_amf",
    "h264_videotoolbox",
    "hevc_videotoolbox",
)

PROJECT_FILE_VERSION = 1

PROJECT_FILE_TYPES = (
    "OpenDirector project (*.odproj;*.json)",
    "All files (*.*)",
)

# Fields on a clip that only make sense within one app run (media-server URLs,
# proxy bookkeeping). They must never be persisted into a project file.
CLIP_RUNTIME_FIELDS = {"url", "fileUrl", "proxyUrl", "proxyPath", "proxyState", "proxyTried"}

GPU_ENCODER_LABELS = {
    "h264_nvenc": "NVIDIA NVENC H.264",
    "hevc_nvenc": "NVIDIA NVENC HEVC",
    "h264_qsv": "Intel Quick Sync H.264",
    "hevc_qsv": "Intel Quick Sync HEVC",
    "h264_amf": "AMD AMF H.264",
    "hevc_amf": "AMD AMF HEVC",
    "h264_videotoolbox": "Apple VideoToolbox H.264",
    "hevc_videotoolbox": "Apple VideoToolbox HEVC",
}



# The <video> element aborts in-flight Range requests whenever it seeks,
# reloads, or has buffered enough. On the server side that surfaces as one of
# these. It is expected, not an error worth logging.
_CLIENT_DISCONNECT = (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)


class _QuietThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        if isinstance(sys.exc_info()[1], _CLIENT_DISCONNECT):
            return  # client hung up mid-stream — normal for <video> seeking
        super().handle_error(request, client_address)


class LocalMediaServer:
    def __init__(self) -> None:
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._paths: dict[str, Path] = {}
        self._tokens_by_path: dict[str, str] = {}
        self._lock = threading.Lock()

    def url_for(self, path: Path) -> str:
        resolved = path.resolve()
        with self._lock:
            self._ensure_started_locked()
            key = str(resolved)
            token = self._tokens_by_path.get(key)
            if not token:
                token = uuid.uuid4().hex
                self._tokens_by_path[key] = token
                self._paths[token] = resolved
            port = self._server.server_address[1] if self._server else 0
        return f"http://127.0.0.1:{port}/media/{token}/{quote(resolved.name)}"

    def path_for_token(self, token: str) -> Path | None:
        with self._lock:
            return self._paths.get(token)

    def _ensure_started_locked(self) -> None:
        if self._server:
            return
        self._server = _QuietThreadingHTTPServer(("127.0.0.1", 0), _RangeRequestHandler)
        self._server.media_server = self
        self._thread = threading.Thread(target=self._server.serve_forever, name="OpenDirectorMediaServer", daemon=True)
        self._thread.start()


class _RangeRequestHandler(BaseHTTPRequestHandler):
    server: ThreadingHTTPServer

    def log_message(self, format: str, *args: Any) -> None:
        return

    def do_HEAD(self) -> None:
        self._send_file(send_body=False)

    def do_GET(self) -> None:
        self._send_file(send_body=True)

    def _send_file(self, send_body: bool) -> None:
        token = self._token_from_path()
        media_server = getattr(self.server, "media_server", None)
        path = media_server.path_for_token(token) if media_server and token else None
        if not path or not path.exists() or not path.is_file():
            self.send_error(404)
            return

        size = path.stat().st_size
        start, end = self._range(size)
        status = 206 if self.headers.get("Range") else 200
        content_length = end - start + 1
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(content_length))
        self.send_header("Access-Control-Allow-Origin", "*")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if not send_body:
            return

        try:
            with path.open("rb") as handle:
                handle.seek(start)
                remaining = content_length
                while remaining > 0:
                    chunk = handle.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except _CLIENT_DISCONNECT:
            # <video> aborted this Range request (seek / reload). Stop quietly.
            return

    def _token_from_path(self) -> str | None:
        parts = self.path.split("?", 1)[0].split("/")
        if len(parts) >= 3 and parts[1] == "media":
            return parts[2]
        return None

    def _range(self, size: int) -> tuple[int, int]:
        header = self.headers.get("Range")
        if not header or not header.startswith("bytes="):
            return 0, max(0, size - 1)
        raw = header.removeprefix("bytes=").split(",", 1)[0].strip()
        start_raw, _, end_raw = raw.partition("-")
        try:
            if start_raw:
                start = int(start_raw)
                end = int(end_raw) if end_raw else size - 1
            else:
                suffix = int(end_raw)
                start = max(0, size - suffix)
                end = size - 1
        except ValueError:
            return 0, max(0, size - 1)
        start = max(0, min(start, size - 1))
        end = max(start, min(end, size - 1))
        return start, end


class OpenDirectorApi:
    def __init__(self, root: Path) -> None:
        self._root = root
        self._window: Any | None = None
        self._ffmpeg_path = os.environ.get("OPEN_DIRECTOR_FFMPEG") or shutil.which("ffmpeg")
        self._ffprobe_path = os.environ.get("OPEN_DIRECTOR_FFPROBE") or shutil.which("ffprobe")
        self._encoder_cache: dict[str, Any] | None = None
        self._probe_cache: dict[str, dict[str, Any]] = {}
        self._jobs: dict[str, dict[str, Any]] = {}
        self._media_server = LocalMediaServer()
        self._preview_dir = self._root / ".opendirector" / "preview"
        self._preview_jobs: dict[str, dict[str, Any]] = {}
        self._preview_cache: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def bind_window(self, window: Any) -> None:
        self._window = window

    def get_status(self) -> dict[str, Any]:
        encoders = self._detect_encoders()
        gpu = [
            {"name": name, "label": GPU_ENCODER_LABELS.get(name, name)}
            for name in GPU_ENCODER_PREFERENCE
            if name in encoders
        ]
        return {
            "ok": True,
            "ffmpeg": self._ffmpeg_path,
            "ffprobe": self._ffprobe_path,
            "ffmpegFound": bool(self._ffmpeg_path),
            "ffprobeFound": bool(self._ffprobe_path),
            "encoders": sorted(encoders),
            "gpuEncoders": gpu,
            "defaultEncoder": gpu[0]["name"] if gpu else "libx264",
            "message": "ffmpeg ready" if self._ffmpeg_path else "ffmpeg not found in PATH",
        }

    def _create_file_dialog(self, kind: str, **kwargs: Any) -> Any:
        """Open a native dialog. kind is "open" or "save"; supports both the
        modern webview.FileDialog enum and the legacy *_DIALOG constants."""
        if not self._window:
            raise RuntimeError("Webview window is not ready.")
        import webview

        file_dialog = getattr(webview, "FileDialog", None)
        if file_dialog:
            dialog_type = file_dialog.SAVE if kind == "save" else file_dialog.OPEN
        else:
            dialog_type = webview.SAVE_DIALOG if kind == "save" else webview.OPEN_DIALOG
        return self._window.create_file_dialog(dialog_type, **kwargs)

    @staticmethod
    def _single_dialog_result(result: Any) -> str | None:
        if isinstance(result, (list, tuple)):
            result = result[0] if result else None
        return str(result) if result else None

    def choose_media(self) -> dict[str, Any]:
        try:
            paths = self._create_file_dialog("open", allow_multiple=True, file_types=VIDEO_FILE_TYPES)
        except Exception as exc:  # pragma: no cover - depends on native dialog
            return self._error(f"Cannot open file dialog: {exc}")
        if not paths:
            return {"ok": True, "files": []}
        files = []
        for raw in paths:
            probed = self.probe_media(str(raw))
            if probed.get("ok"):
                files.append(probed["media"])
            else:
                files.append({"ok": False, "path": str(raw), "error": probed.get("error", "Probe failed")})
        return {"ok": True, "files": files}

    def probe_media(self, path: str) -> dict[str, Any]:
        try:
            media = self._probe_path(Path(path))
            return {"ok": True, "media": media}
        except Exception as exc:
            return self._error(str(exc))

    def choose_export_path(self, default_name: str = "opendirector-export.mp4") -> dict[str, Any]:
        try:
            result = self._create_file_dialog(
                "save",
                save_filename=default_name,
                file_types=("MP4 video (*.mp4)", "All files (*.*)"),
            )
        except Exception as exc:  # pragma: no cover - depends on native dialog
            return self._error(f"Cannot open save dialog: {exc}")
        return {"ok": True, "path": self._single_dialog_result(result)}

    def save_project(self, project: dict[str, Any], path: str | None = None) -> dict[str, Any]:
        """Persist the project to a .odproj JSON file.

        With no path, opens a save dialog (returns cancelled=True if dismissed).
        With an explicit path, writes directly — this is also the testable path.
        """
        try:
            sanitized = self._sanitize_project(project)
        except Exception as exc:
            return self._error(f"Invalid project payload: {exc}")
        target = str(path or "").strip()
        if not target:
            try:
                default_name = f"{self._safe_filename(sanitized['name'])}.odproj"
                result = self._create_file_dialog(
                    "save",
                    save_filename=default_name,
                    file_types=PROJECT_FILE_TYPES,
                )
            except Exception as exc:  # pragma: no cover - depends on native dialog
                return self._error(f"Cannot open save dialog: {exc}")
            target = self._single_dialog_result(result)
            if not target:
                return {"ok": True, "path": None, "cancelled": True}
        try:
            out = Path(target).expanduser()
            if not out.suffix:
                out = out.with_suffix(".odproj")
            out.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "app": "OpenDirector",
                "version": PROJECT_FILE_VERSION,
                "savedAt": time.time(),
                "project": sanitized,
            }
            tmp = out.with_name(out.name + ".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, out)
            return {"ok": True, "path": str(out)}
        except Exception as exc:
            return self._error(str(exc))

    def open_project(self) -> dict[str, Any]:
        """Pick a project file with a dialog and load it."""
        try:
            result = self._create_file_dialog("open", allow_multiple=False, file_types=PROJECT_FILE_TYPES)
        except Exception as exc:  # pragma: no cover - depends on native dialog
            return self._error(f"Cannot open file dialog: {exc}")
        target = self._single_dialog_result(result)
        if not target:
            return {"ok": True, "path": None, "cancelled": True}
        return self.load_project(target)

    def load_project(self, path: str) -> dict[str, Any]:
        try:
            source = Path(path).expanduser()
            if not source.exists():
                return self._error(f"Project file does not exist: {source}")
            data = json.loads(source.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("project"), dict):
                version = data.get("version")
                if isinstance(version, int) and version > PROJECT_FILE_VERSION:
                    return self._error(
                        f"Project file version {version} is newer than this app supports ({PROJECT_FILE_VERSION})."
                    )
                raw_project = data["project"]
            elif isinstance(data, dict) and "tracks" in data:
                raw_project = data  # bare project dict (pre-versioned saves)
            else:
                return self._error("Not an OpenDirector project file.")
            project = self._sanitize_project(raw_project)
            missing = [item for item in self._project_sources(project) if not Path(item).exists()]
            return {"ok": True, "path": str(source), "project": project, "missingMedia": missing}
        except json.JSONDecodeError as exc:
            return self._error(f"Not a valid project file: {exc}")
        except Exception as exc:
            return self._error(str(exc))

    def _sanitize_project(self, project: Any) -> dict[str, Any]:
        """Validate/normalize a project payload and strip per-run clip fields."""
        if not isinstance(project, dict):
            raise ValueError("Project payload must be an object.")
        tracks: list[dict[str, Any]] = []
        for track in project.get("tracks") or []:
            if not isinstance(track, dict):
                continue
            track_type = track.get("type")
            if track_type not in {"video", "audio", "subtitle"}:
                continue
            clips: list[dict[str, Any]] = []
            for clip in track.get("clips") or []:
                if not isinstance(clip, dict):
                    continue
                cleaned = {key: value for key, value in clip.items() if key not in CLIP_RUNTIME_FIELDS}
                cleaned["id"] = str(cleaned.get("id") or uuid.uuid4().hex[:10])
                cleaned["start"] = self._float(cleaned.get("start"), 0.0, 0.0, 100000.0)
                cleaned["duration"] = self._float(cleaned.get("duration"), 1.0, 0.05, 100000.0)
                clips.append(cleaned)
            tracks.append({
                "id": str(track.get("id") or uuid.uuid4().hex[:6]),
                "type": track_type,
                "name": str(track.get("name") or track_type),
                "clips": clips,
            })
        return {
            "name": str(project.get("name") or "未命名專案"),
            "width": self._int(project.get("width"), 1920, 160, 7680),
            "height": self._int(project.get("height"), 1080, 90, 4320),
            "fps": self._float(project.get("fps"), 30.0, 1.0, 120.0),
            "total": self._float(project.get("total"), 48.0, 1.0, 100000.0),
            "pxPerSec": self._float(project.get("pxPerSec"), 18.0, 8.0, 48.0),
            "playhead": self._float(project.get("playhead"), 0.0, 0.0, 100000.0),
            "showSubs": bool(project.get("showSubs", True)),
            "encoder": str(project.get("encoder") or "auto-gpu"),
            "tracks": tracks,
        }

    def _project_sources(self, project: dict[str, Any]) -> list[str]:
        paths: list[str] = []
        seen: set[str] = set()
        for clip in self._clips(project):
            source = self._clip_source(clip)
            if source and source not in seen:
                seen.add(source)
                paths.append(source)
        return paths

    @staticmethod
    def _safe_filename(name: str) -> str:
        cleaned = re.sub(r'[\\/:*?"<>|]+', "_", str(name)).strip().strip(".")
        return cleaned or "opendirector"

    def start_preview_proxy(self, path: str) -> dict[str, Any]:
        if not self._ffmpeg_path:
            return self._error("ffmpeg was not found. Install ffmpeg or set OPEN_DIRECTOR_FFMPEG.")
        try:
            source = Path(path).expanduser().resolve()
            if not source.exists():
                return self._error(f"File does not exist: {source}")
            cache_key = self._preview_cache_key(source)
            cached = self._preview_cache.get(cache_key)
            if cached and Path(cached["path"]).exists():
                return {"ok": True, "ready": True, "preview": cached}

            self._preview_dir.mkdir(parents=True, exist_ok=True)
            output = self._preview_dir / f"{cache_key}.mp4"
            # A completed proxy from a previous session is still valid (the cache
            # key encodes the source path/size/mtime). Reuse it instead of burning
            # minutes transcoding again. Partial transcodes never land here because
            # the worker only renames into place on success.
            if output.exists() and output.stat().st_size > 0:
                preview = {"path": str(output), "url": self._media_server.url_for(output)}
                self._preview_cache[cache_key] = preview
                return {"ok": True, "ready": True, "preview": preview}
            job_id = uuid.uuid4().hex
            status = {
                "id": job_id,
                "state": "queued",
                "progress": 0.0,
                "message": "Preparing preview proxy",
                "source": str(source),
                "output": str(output),
                "preview": None,
                "log": [],
                "process": None,
            }
            with self._lock:
                self._preview_jobs[job_id] = status
            thread = threading.Thread(target=self._run_preview_proxy, args=(job_id, source, output, cache_key), daemon=True)
            thread.start()
            return {"ok": True, "ready": False, "jobId": job_id}
        except Exception as exc:
            return self._error(str(exc))

    def get_ready_preview(self, path: str) -> dict[str, Any]:
        """Return an already-built proxy for a source without ever transcoding.

        Used on project load to re-attach a cached proxy (whose URL/token died
        with the previous run) instead of flashing an error for undecodable
        sources. Never kicks off ffmpeg — if no proxy exists, reports not ready.
        """
        try:
            source = Path(path).expanduser().resolve()
            if not source.exists():
                return {"ok": True, "ready": False}
            cache_key = self._preview_cache_key(source)
            cached = self._preview_cache.get(cache_key)
            if cached and Path(cached["path"]).exists():
                return {"ok": True, "ready": True, "preview": cached}
            output = self._preview_dir / f"{cache_key}.mp4"
            if output.exists() and output.stat().st_size > 0:
                preview = {"path": str(output), "url": self._media_server.url_for(output)}
                self._preview_cache[cache_key] = preview
                return {"ok": True, "ready": True, "preview": preview}
            return {"ok": True, "ready": False}
        except Exception as exc:
            return self._error(str(exc))

    def get_preview_proxy_status(self, job_id: str) -> dict[str, Any]:
        job = self._job_snapshot(self._preview_jobs, job_id, log_limit=40)
        if not job:
            return self._error("Unknown preview job.")
        return {"ok": True, "job": job}

    def _run_preview_proxy(self, job_id: str, source: Path, output: Path, cache_key: str) -> None:
        tmp_output = output.with_name(f"{output.stem}.partial.mp4")
        try:
            duration = 0.0
            try:
                duration = float(self._probe_path(source).get("duration") or 0.0)
            except Exception:
                duration = 0.0
            encoder = self._select_preview_encoder()
            command = [
                self._ffmpeg_path or "ffmpeg",
                "-hide_banner",
                # Best-effort hardware decode (big win for HEVC, the main reason a
                # proxy is needed); ffmpeg falls back to software when unavailable.
                "-hwaccel",
                "auto",
                "-y",
                "-i",
                str(source),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                # 960p is plenty for the preview pane and roughly halves the pixels
                # to encode versus 1280p, so the proxy is ready sooner.
                "-vf",
                "scale=960:-2:force_original_aspect_ratio=decrease,format=yuv420p",
            ]
            command.extend(self._encoder_args(encoder, {"crf": 28, "preset": "veryfast", "videoBitrate": "4M"}))
            command.extend(["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(tmp_output)])
            self._update_job(self._preview_jobs, job_id, state="running", message=f"Building H.264 preview proxy with {encoder}", command=command)
            process = self._spawn_ffmpeg(command)
            self._update_job(self._preview_jobs, job_id, process=process)
            assert process.stdout is not None
            for raw_line in process.stdout:
                line = raw_line.strip()
                if not line:
                    continue
                self._append_job_log(self._preview_jobs, job_id, line, limit=160)
                if duration > 0:
                    match = re.search(r"time=(\d+:\d+:\d+\.\d+)", line)
                    if match:
                        seconds = self._parse_timecode(match.group(1))
                        if seconds is not None:
                            self._update_job(self._preview_jobs, job_id, progress=max(0.0, min(0.99, seconds / duration)))
            code = process.wait()
            if code != 0:
                self._cleanup_file(tmp_output)
                self._update_job(self._preview_jobs, job_id, state="failed", message=f"ffmpeg exited with code {code}", process=None)
                return
            os.replace(tmp_output, output)
            preview = {"path": str(output), "url": self._media_server.url_for(output)}
            with self._lock:
                self._preview_cache[cache_key] = preview
            self._update_job(self._preview_jobs, job_id, state="done", progress=1.0, message="Preview proxy ready", preview=preview, process=None)
        except Exception as exc:
            self._cleanup_file(tmp_output)
            self._append_job_log(self._preview_jobs, job_id, str(exc), limit=160)
            self._update_job(self._preview_jobs, job_id, state="failed", message=str(exc), process=None)

    def _cleanup_file(self, path: Path) -> None:
        try:
            if path.exists():
                path.unlink()
        except OSError:
            pass
    def start_export(self, project: dict[str, Any], options: dict[str, Any]) -> dict[str, Any]:
        if not self._ffmpeg_path:
            return self._error("ffmpeg was not found. Install ffmpeg or set OPEN_DIRECTOR_FFMPEG.")

        output = str(options.get("output") or "").strip()
        if not output:
            return self._error("Missing output path.")

        job_id = uuid.uuid4().hex
        status = {
            "id": job_id,
            "state": "queued",
            "progress": 0.0,
            "message": "Preparing export",
            "output": output,
            "command": [],
            "log": [],
            "startedAt": time.time(),
            "finishedAt": None,
            "process": None,
        }
        with self._lock:
            self._jobs[job_id] = status

        thread = threading.Thread(target=self._run_export, args=(job_id, project, options), daemon=True)
        thread.start()
        return {"ok": True, "jobId": job_id}

    def get_export_status(self, job_id: str) -> dict[str, Any]:
        job = self._job_snapshot(self._jobs, job_id, log_limit=80)
        if not job:
            return self._error("Unknown export job.")
        return {"ok": True, "job": job}

    def cancel_export(self, job_id: str) -> dict[str, Any]:
        # Mark cancelled *before* terminating so the worker thread (which sees a
        # non-zero exit code) knows not to overwrite the state with "failed".
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return self._error("Unknown export job.")
            if job.get("state") in {"done", "failed", "cancelled"}:
                return {"ok": True}
            process = job.get("process")
            job.update(state="cancelled", message="Export cancelled", finishedAt=time.time())
        if process and process.poll() is None:
            process.terminate()
        return {"ok": True}

    def _run_export(self, job_id: str, project: dict[str, Any], options: dict[str, Any]) -> None:
        output = Path(str(options["output"]))
        # Render into a sibling temp file and only rename into place on success,
        # so a cancelled/failed export never leaves a truncated file at the
        # user's chosen path.
        tmp_output = output.with_name(f"{output.stem}.partial{output.suffix or '.mp4'}")
        try:
            command, total = self._build_ffmpeg_command(project, {**options, "output": str(tmp_output)})
            self._update_job(self._jobs, job_id, state="running", message="ffmpeg is rendering", command=command)
            process = self._spawn_ffmpeg(command)
            self._update_job(self._jobs, job_id, process=process)
            assert process.stdout is not None
            for raw_line in process.stdout:
                line = raw_line.strip()
                if not line:
                    continue
                self._append_job_log(self._jobs, job_id, line, limit=300)
                progress = self._progress_from_line(line, total)
                if progress is not None and self._job_state(self._jobs, job_id) == "running":
                    self._update_job(self._jobs, job_id, progress=progress, message=f"Rendering {int(progress * 100)}%")
            code = process.wait()
            if self._job_state(self._jobs, job_id) == "cancelled":
                self._cleanup_file(tmp_output)
                self._update_job(self._jobs, job_id, process=None)
                return
            if code == 0:
                os.replace(tmp_output, output)
                self._update_job(
                    self._jobs,
                    job_id,
                    state="done",
                    progress=1.0,
                    message="Export complete",
                    finishedAt=time.time(),
                    process=None,
                )
            else:
                self._cleanup_file(tmp_output)
                self._update_job(
                    self._jobs,
                    job_id,
                    state="failed",
                    message=f"ffmpeg exited with code {code}",
                    finishedAt=time.time(),
                    process=None,
                )
        except Exception as exc:
            self._cleanup_file(tmp_output)
            self._append_job_log(self._jobs, job_id, str(exc), limit=300)
            if self._job_state(self._jobs, job_id) != "cancelled":
                self._update_job(self._jobs, job_id, state="failed", message=str(exc), finishedAt=time.time(), process=None)
            else:
                self._update_job(self._jobs, job_id, process=None)

    def _build_ffmpeg_command(self, project: dict[str, Any], options: dict[str, Any]) -> tuple[list[str], float]:
        width = self._int(options.get("width"), 1920, 160, 7680)
        height = self._int(options.get("height"), 1080, 90, 4320)
        fps = self._float(options.get("fps"), 30.0, 1.0, 120.0)
        total = max(0.1, self._project_duration(project))
        output = str(options["output"])
        Path(output).parent.mkdir(parents=True, exist_ok=True)

        clips = self._clips(project)
        input_paths = self._input_paths(clips)
        if not input_paths:
            raise ValueError("Project has no media clips. Import a video or audio file first.")

        input_index = {path: i for i, path in enumerate(input_paths)}
        command = [self._ffmpeg_path or "ffmpeg", "-hide_banner", "-y"]
        for path in input_paths:
            command.extend(["-i", path])

        filters: list[str] = []
        video_label = self._build_video_filters(project, input_index, width, height, fps, total, filters)
        audio_label = self._build_audio_filters(project, input_index, total, filters)
        if options.get("includeSubtitles", True):
            video_label = self._append_subtitle_filters(project, video_label, width, height, filters)

        encoder = self._select_encoder(str(options.get("encoder") or "auto-gpu"))
        command.extend(["-filter_complex", ";".join(filters)])
        command.extend(["-map", f"[{video_label}]", "-map", f"[{audio_label}]"])
        command.extend(self._encoder_args(encoder, options))
        command.extend(["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", str(options.get("audioBitrate") or "192k")])
        command.extend(["-movflags", "+faststart", "-shortest", "-progress", "pipe:1", "-nostats", output])
        return command, total

    def _build_video_filters(
        self,
        project: dict[str, Any],
        input_index: dict[str, int],
        width: int,
        height: int,
        fps: float,
        total: float,
        filters: list[str],
    ) -> str:
        tracks = [track for track in project.get("tracks", []) if track.get("type") == "video"]
        boundaries = {0.0, total}
        for track in tracks:
            for clip in track.get("clips", []):
                if not self._clip_source(clip):
                    continue
                start = self._float(clip.get("start"), 0.0, 0.0, total)
                end = min(total, start + self._float(clip.get("duration"), 0.0, 0.0, total))
                if end > start:
                    boundaries.add(start)
                    boundaries.add(end)
        points = sorted(boundaries)
        labels: list[str] = []
        for i, (start, end) in enumerate(zip(points, points[1:])):
            duration = end - start
            if duration <= 0.001:
                continue
            clip = self._visible_clip_at(tracks, start + duration / 2)
            label = f"vseg{i}"
            if clip:
                path = self._clip_source(clip)
                idx = input_index[path]
                speed = max(0.05, self._float(clip.get("speed"), 1.0, 0.05, 16.0))
                src_start = self._float(clip.get("sourceIn"), 0.0, 0.0, 100000.0) + (start - self._float(clip.get("start"), 0.0, 0.0, total)) * speed
                src_duration = duration * speed
                filters.append(
                    f"[{idx}:v]trim=start={src_start:.6f}:duration={src_duration:.6f},"
                    f"setpts=(PTS-STARTPTS)/{speed:.6f},fps={fps:.6f},"
                    f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                    f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1[{label}]"
                )
            else:
                filters.append(f"color=c=black:s={width}x{height}:r={fps:.6f}:d={duration:.6f}[{label}]")
            labels.append(label)

        if not labels:
            filters.append(f"color=c=black:s={width}x{height}:r={fps:.6f}:d={total:.6f}[vbase]")
            return "vbase"
        if len(labels) == 1:
            return labels[0]
        joined = "".join(f"[{label}]" for label in labels)
        filters.append(f"{joined}concat=n={len(labels)}:v=1:a=0[vbase]")
        return "vbase"

    def _build_audio_filters(
        self,
        project: dict[str, Any],
        input_index: dict[str, int],
        total: float,
        filters: list[str],
    ) -> str:
        labels: list[str] = []
        for i, item in enumerate(self._audio_source_clips(project)):
            clip = item["clip"]
            path = self._clip_source(clip)
            if not path or path not in input_index:
                continue
            if clip.get("hasAudio") is False:
                continue
            if "hasAudio" not in clip:
                try:
                    if not self._probe_path(Path(path)).get("hasAudio"):
                        continue
                except Exception:
                    continue
            idx = input_index[path]
            label = f"aud{i}"
            start = self._float(clip.get("start"), 0.0, 0.0, total)
            duration = max(0.05, self._float(clip.get("duration"), 0.0, 0.0, total))
            speed = max(0.05, self._float(clip.get("speed"), 1.0, 0.05, 16.0))
            source_in = self._float(clip.get("sourceIn"), 0.0, 0.0, 100000.0)
            source_duration = duration * speed
            delay_ms = max(0, int(round(start * 1000)))
            tempo = ",".join(f"atempo={value:.6f}" for value in self._atempo_chain(speed))
            filters.append(
                f"[{idx}:a]atrim=start={source_in:.6f}:duration={source_duration:.6f},"
                f"asetpts=PTS-STARTPTS,{tempo},adelay={delay_ms}:all=1,"
                f"apad,atrim=start=0:duration={total:.6f}[{label}]"
            )
            labels.append(label)

        if not labels:
            filters.append(f"anullsrc=channel_layout=stereo:sample_rate=48000:d={total:.6f}[aout]")
            return "aout"
        if len(labels) == 1:
            return labels[0]
        joined = "".join(f"[{label}]" for label in labels)
        filters.append(f"{joined}amix=inputs={len(labels)}:duration=longest:dropout_transition=0,atrim=start=0:duration={total:.6f}[aout]")
        return "aout"

    def _append_subtitle_filters(
        self,
        project: dict[str, Any],
        input_label: str,
        width: int,
        height: int,
        filters: list[str],
    ) -> str:
        label = input_label
        fontsize = max(18, round(height * 0.036))
        y_expr = "h-h*0.12-text_h"
        font_arg = self._fontfile_filter_arg()
        n = 0
        for track in project.get("tracks", []):
            if track.get("type") != "subtitle":
                continue
            for clip in sorted(track.get("clips", []), key=lambda item: self._float(item.get("start"), 0, 0, 100000)):
                text = str(clip.get("label") or "").strip()
                if not text:
                    continue
                start = self._float(clip.get("start"), 0.0, 0.0, 100000.0)
                end = start + self._float(clip.get("duration"), 0.0, 0.0, 100000.0)
                out = f"vsub{n}"
                filters.append(
                    f"[{label}]drawtext=text='{self._escape_drawtext(text)}':"
                    f"enable='between(t\\,{start:.3f}\\,{end:.3f})':"
                    f"x=(w-text_w)/2:y={y_expr}:fontcolor=white:fontsize={fontsize}:"
                    f"box=1:boxcolor=black@0.62:boxborderw={max(8, round(width * 0.007))}"
                    f"{font_arg}[{out}]"
                )
                label = out
                n += 1
        return label

    def _select_preview_encoder(self) -> str:
        encoders = self._detect_encoders()
        for name in ("h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"):
            if name in encoders:
                return name
        return "libx264"

    def _preview_cache_key(self, path: Path) -> str:
        stat = path.stat()
        return uuid.uuid5(uuid.NAMESPACE_URL, f"{path.resolve()}:{stat.st_size}:{stat.st_mtime_ns}").hex
    def _select_encoder(self, requested: str) -> str:
        encoders = self._detect_encoders()
        if requested in ("auto", "auto-gpu", "gpu"):
            for name in GPU_ENCODER_PREFERENCE:
                if name in encoders:
                    return name
            return "libx264"
        return requested if requested else "libx264"

    def _encoder_args(self, encoder: str, options: dict[str, Any]) -> list[str]:
        crf = str(self._int(options.get("crf"), 20, 0, 51))
        preset = str(options.get("preset") or "medium")
        bitrate = str(options.get("videoBitrate") or "8M")
        if encoder == "libx264":
            return ["-c:v", "libx264", "-preset", preset, "-crf", crf]
        if encoder in {"h264_nvenc", "hevc_nvenc"}:
            return ["-c:v", encoder, "-preset", "p5", "-cq", crf, "-b:v", "0"]
        if encoder in {"h264_qsv", "hevc_qsv"}:
            return ["-c:v", encoder, "-global_quality", crf]
        if encoder in {"h264_amf", "hevc_amf"}:
            return ["-c:v", encoder, "-quality", "balanced", "-rc", "cqp", "-qp_i", crf, "-qp_p", crf]
        if encoder in {"h264_videotoolbox", "hevc_videotoolbox"}:
            return ["-c:v", encoder, "-b:v", bitrate]
        return ["-c:v", encoder, "-b:v", bitrate]

    def _detect_encoders(self) -> set[str]:
        if self._encoder_cache and time.time() - self._encoder_cache["time"] < 30:
            return set(self._encoder_cache["encoders"])
        encoders: set[str] = set()
        if self._ffmpeg_path:
            try:
                result = subprocess.run(
                    [self._ffmpeg_path, "-hide_banner", "-encoders"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=20,
                    check=False,
                )
                for line in result.stdout.splitlines():
                    parts = line.split()
                    if len(parts) >= 2 and parts[0].startswith("V"):
                        encoders.add(parts[1])
            except Exception:
                pass
        encoders.add("libx264")
        self._encoder_cache = {"time": time.time(), "encoders": sorted(encoders)}
        return encoders

    def _probe_path(self, path: Path) -> dict[str, Any]:
        resolved = path.expanduser().resolve()
        if not resolved.exists():
            raise FileNotFoundError(f"File does not exist: {resolved}")
        # Key on size+mtime too, so replacing a file on disk invalidates the entry.
        stat = resolved.stat()
        key = f"{resolved}:{stat.st_size}:{stat.st_mtime_ns}"
        if key in self._probe_cache:
            return dict(self._probe_cache[key])
        if not self._ffprobe_path:
            raise RuntimeError("ffprobe was not found. Install ffmpeg or set OPEN_DIRECTOR_FFPROBE.")
        result = subprocess.run(
            [
                self._ffprobe_path,
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(resolved),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "ffprobe failed")
        data = json.loads(result.stdout or "{}")
        streams = data.get("streams") or []
        video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
        audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
        duration = self._duration_from_probe(data, video, audio)
        fps = self._fps(video.get("avg_frame_rate") or video.get("r_frame_rate")) if video else 0.0
        media = {
            "path": str(resolved),
            "url": self._media_server.url_for(resolved),
            "fileUrl": resolved.as_uri(),
            "name": resolved.name,
            "kind": "video" if video else "audio" if audio else "unknown",
            "duration": duration,
            "width": int(video.get("width") or 0) if video else 0,
            "height": int(video.get("height") or 0) if video else 0,
            "fps": fps,
            "hasAudio": bool(audio),
            "videoCodec": video.get("codec_name") if video else "",
            "audioCodec": audio.get("codec_name") if audio else "",
            "format": (data.get("format") or {}).get("format_long_name") or (data.get("format") or {}).get("format_name") or "",
        }
        self._probe_cache[key] = dict(media)
        return media

    def _duration_from_probe(self, data: dict[str, Any], video: dict[str, Any] | None, audio: dict[str, Any] | None) -> float:
        for obj in (data.get("format") or {}, video or {}, audio or {}):
            try:
                value = float(obj.get("duration"))
                if math.isfinite(value) and value > 0:
                    return value
            except (TypeError, ValueError):
                pass
        return 1.0

    def _fps(self, raw: str | None) -> float:
        if not raw or raw == "0/0":
            return 0.0
        if "/" in raw:
            a, b = raw.split("/", 1)
            try:
                denom = float(b)
                return float(a) / denom if denom else 0.0
            except ValueError:
                return 0.0
        try:
            return float(raw)
        except ValueError:
            return 0.0

    def _project_duration(self, project: dict[str, Any]) -> float:
        total = self._float(project.get("total"), 0.0, 0.0, 100000.0)
        for clip in self._clips(project):
            start = self._float(clip.get("start"), 0.0, 0.0, 100000.0)
            duration = self._float(clip.get("duration"), 0.0, 0.0, 100000.0)
            total = max(total, start + duration)
        return total

    def _clips(self, project: dict[str, Any]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for track in project.get("tracks", []):
            for clip in track.get("clips", []):
                if isinstance(clip, dict):
                    out.append(clip)
        return out

    def _audio_source_clips(self, project: dict[str, Any]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for track in project.get("tracks", []):
            if track.get("type") not in {"video", "audio"}:
                continue
            for clip in track.get("clips", []):
                if self._clip_source(clip):
                    out.append({"track": track, "clip": clip})
        return out

    def _input_paths(self, clips: list[dict[str, Any]]) -> list[str]:
        paths: list[str] = []
        seen: set[str] = set()
        for clip in clips:
            path = self._clip_source(clip)
            if not path or path in seen:
                continue
            if not Path(path).exists():
                raise FileNotFoundError(f"Missing source media: {path}")
            seen.add(path)
            paths.append(path)
        return paths

    def _visible_clip_at(self, tracks: list[dict[str, Any]], at: float) -> dict[str, Any] | None:
        for track in reversed(tracks):
            for clip in sorted(track.get("clips", []), key=lambda item: self._float(item.get("start"), 0, 0, 100000), reverse=True):
                if not self._clip_source(clip):
                    continue
                start = self._float(clip.get("start"), 0.0, 0.0, 100000.0)
                duration = self._float(clip.get("duration"), 0.0, 0.0, 100000.0)
                if start <= at < start + duration:
                    return clip
        return None

    def _clip_source(self, clip: dict[str, Any]) -> str:
        return str(clip.get("source") or clip.get("path") or "").strip()

    def _atempo_chain(self, speed: float) -> list[float]:
        values: list[float] = []
        value = speed
        while value > 2.0:
            values.append(2.0)
            value /= 2.0
        while value < 0.5:
            values.append(0.5)
            value /= 0.5
        values.append(value)
        return values

    def _progress_from_line(self, line: str, total: float) -> float | None:
        if "=" not in line:
            return None
        key, value = line.split("=", 1)
        seconds: float | None = None
        if key in {"out_time_ms", "out_time_us"}:
            try:
                seconds = int(value) / 1_000_000
            except ValueError:
                return None
        elif key == "out_time":
            seconds = self._parse_timecode(value)
        if seconds is None:
            return None
        return max(0.0, min(0.999, seconds / max(0.001, total)))

    def _parse_timecode(self, value: str) -> float | None:
        match = re.match(r"(\d+):(\d+):(\d+(?:\.\d+)?)", value)
        if not match:
            return None
        hours, minutes, seconds = match.groups()
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)

    def _escape_drawtext(self, value: str) -> str:
        return (
            value.replace("\\", "\\\\")
            .replace(":", "\\:")
            .replace("'", "\\'")
            .replace("%", "\\%")
            .replace(",", "\\,")
            .replace(";", "\\;")
            .replace("[", "\\[")
            .replace("]", "\\]")
            .replace("\r", " ")
            .replace("\n", " ")
        )

    def _fontfile_filter_arg(self) -> str:
        candidates = []
        if os.name == "nt":
            windir = Path(os.environ.get("WINDIR", "C:/Windows"))
            candidates.extend([
                windir / "Fonts" / "msjh.ttc",
                windir / "Fonts" / "mingliu.ttc",
                windir / "Fonts" / "arial.ttf",
            ])
        else:
            candidates.extend([
                Path("/System/Library/Fonts/PingFang.ttc"),
                Path("/Library/Fonts/Arial Unicode.ttf"),
                Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
                Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            ])
        for path in candidates:
            if path.exists():
                escaped = path.as_posix().replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
                return f":fontfile='{escaped}'"
        return ""
    # ---- shared job-store helpers (export jobs and preview-proxy jobs) ----

    def _spawn_ffmpeg(self, command: list[str]) -> subprocess.Popen:
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW") else 0
        return subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=flags,
        )

    def _update_job(self, store: dict[str, dict[str, Any]], job_id: str, **updates: Any) -> None:
        with self._lock:
            job = store.get(job_id)
            if job:
                job.update(updates)

    def _job_state(self, store: dict[str, dict[str, Any]], job_id: str) -> str | None:
        with self._lock:
            job = store.get(job_id)
            return job.get("state") if job else None

    def _job_snapshot(self, store: dict[str, dict[str, Any]], job_id: str, log_limit: int) -> dict[str, Any] | None:
        with self._lock:
            job = store.get(job_id)
            if not job:
                return None
            public = {k: v for k, v in job.items() if k != "process"}
            public["log"] = list(public.get("log", []))[-log_limit:]
            return public

    def _append_job_log(self, store: dict[str, dict[str, Any]], job_id: str, line: str, limit: int) -> None:
        with self._lock:
            job = store.get(job_id)
            if not job:
                return
            log = job.setdefault("log", [])
            log.append(line)
            if len(log) > limit:
                del log[:-limit]

    def shutdown(self) -> dict[str, Any]:
        """Terminate every ffmpeg child still running (exports and preview
        proxies). Called on window close so no orphan encoders outlive the app."""
        processes = []
        with self._lock:
            for job in list(self._jobs.values()) + list(self._preview_jobs.values()):
                process = job.get("process")
                if process is not None and process.poll() is None:
                    processes.append(process)
                    job.update(state="cancelled", message="Application closed", finishedAt=time.time())
        for process in processes:
            try:
                process.terminate()
            except OSError:
                pass
        return {"ok": True, "terminated": len(processes)}

    def _int(self, value: Any, default: int, minimum: int, maximum: int) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = default
        return max(minimum, min(maximum, parsed))

    def _float(self, value: Any, default: float, minimum: float, maximum: float) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            parsed = default
        if not math.isfinite(parsed):
            parsed = default
        return max(minimum, min(maximum, parsed))

    def _error(self, message: str) -> dict[str, Any]:
        return {"ok": False, "error": message}
