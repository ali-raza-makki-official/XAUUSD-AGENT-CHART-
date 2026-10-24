from __future__ import annotations

import hmac
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from .mt5_feed import FeedError, Mt5Feed
from .trading import Mt5Trader, TradeError

MAX_BODY = 16 * 1024
TRADE_ACTIONS = {
    "/trade/open_market": "open_market",
    "/trade/open_pending": "open_pending",
    "/trade/modify_sltp": "modify_sltp",
    "/trade/close_position": "close_position",
    "/trade/partial_close": "partial_close",
    "/trade/cancel_pending": "cancel_pending",
}


def make_handler(feed: Mt5Feed, token: str, dev: bool, trader: Mt5Trader | None = None):
    trader = trader or Mt5Trader(feed)  # disabled by default
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

        def _host_ok(self) -> bool:
            # DNS-rebinding guard: only loopback host names are served.
            host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
            return host in ("127.0.0.1", "localhost", "::1")

        def do_POST(self) -> None:
            supplied = self.headers.get("X-Aurum-Token", "")
            if not hmac.compare_digest(supplied, token):
                return self._send(401, {"error": "unauthorized", "sent": False})
            if not self._host_ok():
                return self._send(403, {"error": "bad host", "sent": False})
            path = urlparse(self.path).path
            action = TRADE_ACTIONS.get(path)
            if action is None:
                return self._send(404, {"error": "not found", "sent": False})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY:
                    return self._send(400, {"error": "body required (max 16 KiB)", "sent": False})
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    return self._send(400, {"error": "JSON object required", "sent": False})
            except (ValueError, TypeError):
                return self._send(400, {"error": "invalid JSON", "sent": False})
            try:
                return self._send(200, trader.execute(action, body))
            except TradeError as exc:
                # Any non-200 answer means order_send was NOT called.
                return self._send(exc.status, {"error": exc.message, "code": exc.code, "sent": False})
            except FeedError as exc:
                return self._send(503, {"error": str(exc), "code": "not_connected", "sent": False})
            except Exception as exc:  # noqa: BLE001 - before-send failure: still "not sent" by construction
                return self._send(500, {"error": f"internal error before sending: {type(exc).__name__}: {exc}", "code": "internal", "sent": False})

        def do_GET(self) -> None:
            supplied = self.headers.get("X-Aurum-Token", "")
            if not hmac.compare_digest(supplied, token):
                return self._send(401, {"error": "unauthorized"})
            if not self._host_ok():
                return self._send(403, {"error": "bad host"})
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
                if url.path == "/trade/status":
                    return self._send(200, trader.status())
                if url.path == "/positions":
                    return self._send(200, {"positions": trader.positions()})
                if url.path == "/orders":
                    return self._send(200, {"orders": trader.orders()})
                if url.path == "/deals":
                    since = q.get("since", [None])[0]
                    return self._send(200, trader.deals(float(since) if since else None))
                if url.path == "/trade/find":
                    cid = q.get("commandId", [""])[0]
                    if not (8 <= len(cid) <= 80):
                        return self._send(400, {"error": "commandId required"})
                    ticket = q.get("ticket", [None])[0]
                    since = q.get("since", [None])[0]
                    return self._send(200, trader.evidence(cid, int(ticket) if ticket else None, float(since) if since else None))
                if url.path == "/candles":
                    tf = q.get("tf", ["M15"])[0]
                    count = int(q.get("count", ["500"])[0])
                    return self._send(200, feed.candles(tf, count))
                return self._send(404, {"error": "not found"})
            except TradeError as exc:
                return self._send(exc.status, {"error": exc.message, "code": exc.code})
            except FeedError as exc:
                return self._send(503, {"error": str(exc)})
            except (ValueError, TypeError) as exc:
                return self._send(400, {"error": str(exc)})

    return Handler


def serve(feed: Mt5Feed, token: str, port: int, dev: bool = False, trader: Mt5Trader | None = None) -> ThreadingHTTPServer:
    # Loopback only: the bridge must never be reachable from the network.
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(feed, token, dev, trader))
