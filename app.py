from __future__ import annotations

import atexit
import sys
from pathlib import Path

from opendirector.ffmpeg_backend import OpenDirectorApi


def main() -> int:
    try:
        import webview
    except ModuleNotFoundError:
        print("pywebview is not installed. Run: pip install -r requirements.txt", file=sys.stderr)
        return 1

    root = Path(__file__).resolve().parent
    api = OpenDirectorApi(root)
    window = webview.create_window(
        "OpenDirector 剪輯室",
        str(root / "web" / "index.html"),
        js_api=api,
        width=1280,
        height=860,
        min_size=(1024, 700),
    )
    api.bind_window(window)
    # Make sure background ffmpeg children (exports / preview proxies) die with
    # the app instead of becoming orphans.
    atexit.register(api.shutdown)

    def on_closed() -> None:
        # pywebview collects handler return values into a set, so this must
        # return None — api.shutdown() returns an (unhashable) dict.
        api.shutdown()

    try:
        window.events.closed += on_closed
    except Exception:
        pass  # older pywebview without the events API — atexit still covers us
    webview.start(debug="--debug" in sys.argv, private_mode=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
