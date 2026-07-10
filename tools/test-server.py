#!/usr/bin/env python3
"""Repo file server for browser smoke tests, port 8932.

Adds a /hang endpoint that starts an image response and never finishes it:
a page containing `<img src="/hang" hidden>` keeps its load event pending,
so `chromium --headless=new --dump-dom --timeout=N` executes the page for N
REAL milliseconds instead of dumping at the load event.

Needed because Pyodide-in-a-worker (convert-smoke.html) deadlocks under
--virtual-time-budget: the main frame's virtual clock races ahead while the
worker's timers starve, so loadPyodide never settles. Run smoke tests that
involve the conversion worker in real time:

    python3 tools/test-server.py &
    chromium --headless=new --disable-gpu --no-sandbox --timeout=60000 \
        --dump-dom http://localhost:8932/test/browser/convert-smoke.html

Serve from the repo root (the directory you run it from).

By default responses carry COOP/COEP (like the Cloudflare Pages `_headers`),
so pages are crossOriginIsolated and the audio system takes the
SharedArrayBuffer snapshot path. Run `tools/test-server.py --plain [port]`
for a second, non-isolated instance to exercise the postMessage fallback
(default plain port 8933).
"""
import http.server
import sys
import time

ISOLATE = "--plain" not in sys.argv
PORT = next((int(a) for a in sys.argv[1:] if a.isdigit()), 8932 if ISOLATE else 8933)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        if ISOLATE:
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/hang"):
            try:
                self.send_response(200)
                self.send_header("Content-Type", "image/gif")
                self.send_header("Content-Length", "999999")
                self.end_headers()
                time.sleep(600)
            except Exception:
                pass  # client gone — fine
            return
        super().do_GET()


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
