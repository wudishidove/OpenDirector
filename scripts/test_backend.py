# -*- coding: utf-8 -*-
"""Functional tests for the OpenDirector backend (no GUI needed).

Run:  python scripts/test_backend.py

Uses real ffmpeg/ffprobe: generates small fixtures, then exercises probe,
the local media server, project save/load, preview proxy, export, and
export cancellation. Everything runs inside a temp directory.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from opendirector.ffmpeg_backend import OpenDirectorApi  # noqa: E402

PASS = 0
FAIL = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ok  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name}  {detail}")


def run_ffmpeg(api: OpenDirectorApi, args: list[str]) -> None:
    subprocess.run(
        [api._ffmpeg_path, "-hide_banner", "-loglevel", "error", "-y", *args],
        check=True,
        timeout=120,
    )


def make_fixtures(api: OpenDirectorApi, root: Path) -> dict[str, Path]:
    video = root / "fixture-video.mp4"
    audio = root / "fixture-audio.m4a"
    long_video = root / "fixture-long.mp4"
    run_ffmpeg(api, [
        "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=3",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(video),
    ])
    run_ffmpeg(api, [
        "-f", "lavfi", "-i", "sine=frequency=330:duration=2",
        "-c:a", "aac", str(audio),
    ])
    run_ffmpeg(api, [
        "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=25",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=25",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(long_video),
    ])
    return {"video": video, "audio": audio, "long": long_video}


def wait_export(api: OpenDirectorApi, job_id: str, timeout: float = 180.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = api.get_export_status(job_id)
        job = status["job"]
        if job["state"] in {"done", "failed", "cancelled"}:
            return job
        time.sleep(0.25)
    raise TimeoutError("export did not finish in time")


def wait_preview(api: OpenDirectorApi, job_id: str, timeout: float = 120.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = api.get_preview_proxy_status(job_id)
        job = status["job"]
        if job["state"] in {"done", "failed"}:
            return job
        time.sleep(0.25)
    raise TimeoutError("preview proxy did not finish in time")


def project_for(fixtures: dict[str, Path]) -> dict:
    return {
        "name": "測試專案",
        "width": 1280,
        "height": 720,
        "fps": 30,
        # Export honours the timeline length (pads black past the last clip),
        # so keep total == last clip end for the duration assertion below.
        "total": 3,
        "tracks": [
            {"id": "v1", "type": "video", "name": "影片軌 1", "clips": [
                {
                    "id": "c1", "start": 0, "duration": 2, "sourceIn": 0.5, "speed": 1,
                    "label": "主片段", "source": str(fixtures["video"]), "hasAudio": True,
                    # runtime junk that must survive export but be stripped on save
                    "url": "http://127.0.0.1:9/media/dead/beef.mp4",
                    "proxyState": "done", "proxyTried": True,
                },
                {
                    "id": "c2", "start": 2, "duration": 1, "sourceIn": 0, "speed": 2,
                    "label": "2x 片段", "source": str(fixtures["video"]), "hasAudio": True,
                },
            ]},
            {"id": "m1", "type": "audio", "name": "音訊軌", "clips": [
                {"id": "a1", "start": 0.5, "duration": 1.5, "sourceIn": 0, "speed": 1,
                 "label": "配樂", "source": str(fixtures["audio"]), "hasAudio": True},
            ]},
            {"id": "s1", "type": "subtitle", "name": "字幕軌", "clips": [
                {"id": "t1", "start": 0.2, "duration": 2.0, "label": "你好，OpenDirector: 100%"},
            ]},
        ],
    }


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="opendirector-test-"))
    print(f"workdir: {tmp}")
    api = OpenDirectorApi(tmp)

    status = api.get_status()
    check("get_status ok", status["ok"] and status["ffmpegFound"] and status["ffprobeFound"], json.dumps(status, default=str))
    check("default encoder chosen", bool(status["defaultEncoder"]), str(status["defaultEncoder"]))
    print(f"  ..  encoders available: default={status['defaultEncoder']}, gpu={[g['name'] for g in status['gpuEncoders']]}")

    fixtures = make_fixtures(api, tmp)

    # --- probe ---
    probed = api.probe_media(str(fixtures["video"]))
    media = probed.get("media", {})
    check("probe video ok", probed["ok"], str(probed))
    check("probe video kind/duration", media.get("kind") == "video" and 2.5 < media.get("duration", 0) < 3.6, str(media))
    check("probe video has audio + dims", media.get("hasAudio") is True and media.get("width") == 1280, str(media))
    probed_audio = api.probe_media(str(fixtures["audio"]))
    check("probe audio kind", probed_audio["ok"] and probed_audio["media"]["kind"] == "audio", str(probed_audio))
    missing = api.probe_media(str(tmp / "nope.mp4"))
    check("probe missing file errors", missing["ok"] is False, str(missing))

    # --- probe cache invalidation on file change ---
    dup = tmp / "dup.mp4"
    dup.write_bytes(fixtures["video"].read_bytes())
    first = api.probe_media(str(dup))["media"]["duration"]
    time.sleep(0.02)
    dup.write_bytes(fixtures["audio"].read_bytes())  # replace contents
    second = api.probe_media(str(dup))
    check("probe cache invalidates on change", second["ok"] and second["media"]["kind"] == "audio", str(second)[:200])
    check("probe cache first read sane", 2.5 < first < 3.6, str(first))

    # --- media server (range requests) ---
    url = media["url"]
    with urllib.request.urlopen(url, timeout=10) as resp:
        body = resp.read()
        check("media server full GET 200", resp.status == 200 and len(body) == fixtures["video"].stat().st_size)
        check("media server accept-ranges", resp.headers.get("Accept-Ranges") == "bytes")
    req = urllib.request.Request(url, headers={"Range": "bytes=0-99"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        chunk = resp.read()
        check("media server range 206", resp.status == 206 and len(chunk) == 100, f"status={resp.status} len={len(chunk)}")
        check("media server content-range", resp.headers.get("Content-Range", "").startswith("bytes 0-99/"))
    req = urllib.request.Request(url, headers={"Range": "bytes=-50"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        check("media server suffix range", resp.status == 206 and len(resp.read()) == 50)
    bad = url.rsplit("/media/", 1)[0] + "/media/deadbeef/x.mp4"
    try:
        urllib.request.urlopen(bad, timeout=10)
        check("media server 404 unknown token", False, "expected 404")
    except urllib.error.HTTPError as exc:
        check("media server 404 unknown token", exc.code == 404, str(exc.code))

    # --- project save / load roundtrip ---
    project = project_for(fixtures)
    proj_path = tmp / "roundtrip.odproj"
    saved = api.save_project(project, str(proj_path))
    check("save_project ok", saved["ok"] and Path(saved["path"]).exists(), str(saved))
    loaded = api.load_project(saved["path"])
    check("load_project ok", loaded["ok"], str(loaded)[:300])
    lp = loaded["project"]
    check("roundtrip keeps name/size", lp["name"] == "測試專案" and lp["width"] == 1280 and lp["height"] == 720, str({k: lp[k] for k in ('name', 'width', 'height')}))
    check("roundtrip keeps 3 tracks + clips", len(lp["tracks"]) == 3 and len(lp["tracks"][0]["clips"]) == 2, str([len(t['clips']) for t in lp['tracks']]))
    clip0 = lp["tracks"][0]["clips"][0]
    check("runtime fields stripped on save", "url" not in clip0 and "proxyState" not in clip0 and "proxyTried" not in clip0, str(clip0))
    check("clip fields preserved", clip0["sourceIn"] == 0.5 and clip0["source"] == str(fixtures["video"]), str(clip0))
    check("no missing media reported", loaded["missingMedia"] == [], str(loaded["missingMedia"]))

    # save without extension gets .odproj
    saved2 = api.save_project(project, str(tmp / "noext"))
    check("save adds .odproj extension", saved2["ok"] and saved2["path"].endswith(".odproj"), str(saved2))

    # missing media detection
    broken = json.loads(json.dumps(project))
    broken["tracks"][0]["clips"][0]["source"] = str(tmp / "gone.mp4")
    saved3 = api.save_project(broken, str(tmp / "broken.odproj"))
    loaded3 = api.load_project(saved3["path"])
    check("missing media detected", loaded3["ok"] and loaded3["missingMedia"] == [str(tmp / "gone.mp4")], str(loaded3.get("missingMedia")))

    # invalid files rejected
    junk = tmp / "junk.odproj"
    junk.write_text("not json at all", encoding="utf-8")
    check("invalid json rejected", api.load_project(str(junk))["ok"] is False)
    other = tmp / "other.json"
    other.write_text(json.dumps({"hello": 1}), encoding="utf-8")
    check("non-project json rejected", api.load_project(str(other))["ok"] is False)
    future = tmp / "future.odproj"
    future.write_text(json.dumps({"app": "OpenDirector", "version": 999, "project": {"tracks": []}}), encoding="utf-8")
    check("future version rejected", api.load_project(str(future))["ok"] is False)
    check("nonexistent project file rejected", api.load_project(str(tmp / "missing.odproj"))["ok"] is False)

    # --- export (CPU encoder for determinism) ---
    out_path = tmp / "export.mp4"
    started = api.start_export(project, {
        "output": str(out_path), "encoder": "libx264", "preset": "ultrafast",
        "width": 1280, "height": 720, "fps": 30, "crf": 23, "includeSubtitles": True,
    })
    check("start_export ok", started["ok"], str(started))
    job = wait_export(api, started["jobId"])
    check("export finishes done", job["state"] == "done", f"state={job['state']} msg={job.get('message')} log={job.get('log', [])[-8:]}")
    check("export output exists", out_path.exists() and out_path.stat().st_size > 1000)
    check("no partial file left", not (tmp / "export.partial.mp4").exists())
    out_probe = api.probe_media(str(out_path))
    om = out_probe.get("media", {})
    check("export duration ≈ 3s", out_probe["ok"] and 2.6 < om.get("duration", 0) < 3.5, str(om.get("duration")))
    check("export is h264 + audio", om.get("videoCodec") == "h264" and om.get("hasAudio") is True, str(om))

    # export with no media must fail cleanly
    started_bad = api.start_export({"tracks": []}, {"output": str(tmp / "empty.mp4")})
    job_bad = wait_export(api, started_bad["jobId"], timeout=30)
    check("empty project export fails cleanly", job_bad["state"] == "failed" and "no media" in job_bad["message"].lower(), str(job_bad["message"]))
    check("missing output path rejected", api.start_export(project, {})["ok"] is False)

    # --- export cancel: state must stay cancelled, no output left ---
    slow_project = {
        "name": "slow", "width": 1920, "height": 1080, "fps": 30, "total": 25,
        "tracks": [{"id": "v1", "type": "video", "name": "v", "clips": [
            {"id": "c1", "start": 0, "duration": 25, "sourceIn": 0, "speed": 1,
             "label": "long", "source": str(fixtures["long"]), "hasAudio": True},
        ]}],
    }
    slow_out = tmp / "slow.mp4"
    slow = api.start_export(slow_project, {
        "output": str(slow_out), "encoder": "libx264", "preset": "veryslow",
        "width": 1920, "height": 1080, "fps": 30, "crf": 18,
    })
    time.sleep(1.5)  # let ffmpeg spin up
    cancelled = api.cancel_export(slow["jobId"])
    check("cancel_export ok", cancelled["ok"], str(cancelled))
    job_slow = wait_export(api, slow["jobId"], timeout=30)
    check("cancelled state not overwritten by worker", job_slow["state"] == "cancelled", f"state={job_slow['state']}")
    time.sleep(1.0)  # give cleanup a beat
    check("cancelled export leaves no files", not slow_out.exists() and not (tmp / "slow.partial.mp4").exists())
    check("cancel unknown job errors", api.cancel_export("nope")["ok"] is False)
    check("status unknown job errors", api.get_export_status("nope")["ok"] is False)

    # --- preview proxy ---
    ready = api.get_ready_preview(str(fixtures["video"]))
    check("get_ready_preview not ready before build", ready["ok"] and ready["ready"] is False, str(ready))
    proxy = api.start_preview_proxy(str(fixtures["video"]))
    check("start_preview_proxy ok", proxy["ok"], str(proxy))
    if not proxy.get("ready"):
        pjob = wait_preview(api, proxy["jobId"])
        check("preview proxy done", pjob["state"] == "done", f"state={pjob['state']} msg={pjob.get('message')} log={pjob.get('log', [])[-8:]}")
        preview = pjob.get("preview") or {}
    else:
        preview = proxy["preview"]
    ppath = Path(preview.get("path", ""))
    check("proxy file exists", ppath.exists() and ppath.stat().st_size > 1000, str(ppath))
    pprobe = api.probe_media(str(ppath))
    check("proxy is h264 ≤960w", pprobe["ok"] and pprobe["media"]["videoCodec"] == "h264" and pprobe["media"]["width"] <= 960, str(pprobe.get("media", {}).get('width')))
    again = api.start_preview_proxy(str(fixtures["video"]))
    check("proxy cache hit on second call", again["ok"] and again.get("ready") is True, str(again))
    ready2 = api.get_ready_preview(str(fixtures["video"]))
    check("get_ready_preview finds built proxy", ready2["ok"] and ready2["ready"] is True, str(ready2))

    # --- shutdown terminates stray children ---
    slow2 = api.start_export(slow_project, {
        "output": str(tmp / "slow2.mp4"), "encoder": "libx264", "preset": "veryslow",
        "width": 1920, "height": 1080, "fps": 30, "crf": 18,
    })
    time.sleep(1.5)
    down = api.shutdown()
    check("shutdown terminates running ffmpeg", down["ok"] and down["terminated"] >= 1, str(down))
    job2 = wait_export(api, slow2["jobId"], timeout=30)
    check("shutdown marks job cancelled", job2["state"] == "cancelled", f"state={job2['state']}")

    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
