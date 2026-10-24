from __future__ import annotations

import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from .mt5_feed import FeedError, Mt5Feed


def make_handler(feed: Mt5Feed, token: str, dev: bool):
    class Handler(BaseHTTPRequestHandler):
        server_version = "AurumBridge/0.1"

        def log_message(self, fmt: str, *args: Any) -> None:  # keep stdout quiet
            pass

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            if dev:
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "X-Aurum-Token")
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self) -> None:  # CORS preflight, dev only
            self._send(204 if dev else 403, {})

        def do_GET(self) -> None:
            supplied = self.headers.get("X-Aurum-Token", "")
            if not hmac.compare_digest(supplied, token):
                return self._send(401, {"error": "unauthorized"})
            url = urlparse(self.path)
            q = parse_qs(url.query)
            try:
                if url.path == "/health":
                    return self._send(200, feed.health())
                if url.path == "/tick":
                    return self._send(200, feed.tick())
                if url.path == "/account":
                    return self._send(200, feed.account())
                if url.path == "/symbol":
                    return self._send(200, feed.symbol_spec())
                if url.path == "/symbols":
                    needles = (q.get("q", ["XAU,GOLD"])[0]).split(",")
                    return self._send(200, {"symbols": feed.find_symbols(needles)})
                if url.path == "/candles":
                    tf = q.get("tf", ["M15"])[0]
                    count = int(q.get("count", ["500"])[0])
                    return self._send(200, feed.candles(tf, count))
                return self._send(404, {"error": "not found"})
            except FeedError as exc:
                return self._send(503, {"error": str(exc)})
            except (ValueError, TypeError) as exc:
                return self._send(400, {"error": str(exc)})

    return Handler


def serve(feed: Mt5Feed, token: str, port: int, dev: bool = False) -> ThreadingHTTPServer:
    # Loopback only: the bridge must never be reachable from the network.
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(feed, token, dev))
