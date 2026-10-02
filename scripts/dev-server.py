#!/usr/bin/env python3
"""Local PythOnline server with the headers required for cross-origin isolation."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1] / "site"
HOST = "127.0.0.1"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class Handler(SimpleHTTPRequestHandler):
    def _redirect_untrusted_loopback(self):
        host = self.headers.get("Host", "").split(":", 1)[0]
        if host == "0.0.0.0":
            location = f"http://{HOST}:{PORT}{self.path}"
            self.send_response(302)
            self.send_header("Location", location)
            self.end_headers()
            return True
        return False

    def do_GET(self):
        if self._redirect_untrusted_loopback():
            return
        super().do_GET()

    def do_HEAD(self):
        if self._redirect_untrusted_loopback():
            return
        super().do_HEAD()

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()


if not ROOT.is_dir():
    raise SystemExit(f"site directory does not exist: {ROOT}")

server = ThreadingHTTPServer(
    (HOST, PORT),
    lambda *args, **kwargs: Handler(*args, directory=str(ROOT), **kwargs),
)
print(f"PythOnline: http://{HOST}:{PORT}/")
print(f"Serving: {ROOT}")
print("COOP: same-origin")
print("COEP: require-corp")
server.serve_forever()
