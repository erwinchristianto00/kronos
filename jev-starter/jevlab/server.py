"""A tiny local web server for the dashboards. Serves this folder on 127.0.0.1 only."""

from __future__ import annotations

import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class _Handler(SimpleHTTPRequestHandler):
    page = "loop.html"  # which dashboard "/" opens
    data = None         # when set, the dashboard's /results/loop.json is served from this results file instead

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.path = f"/dashboard/{self.page}"
        elif self.data and self.path.split("?")[0] == "/results/loop.json":
            self.path = f"/results/{self.data}"
        return super().do_GET()

    def log_message(self, *args):  # keep the terminal clean
        pass


def serve(port: int = 8765, open_browser: bool = True, page: str = "loop.html", data: str | None = None) -> ThreadingHTTPServer:
    handler = type("Handler", (_Handler,), {"page": page, "data": data})
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), partial(handler, directory=str(ROOT)))
    except OSError:
        raise SystemExit(f"  port {port} is busy. Stop the other dashboard (Ctrl+C) or add --port {port + 1}")
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/"
    print(f"  dashboard: {url}")
    if open_browser:
        webbrowser.open(url)
    return server
