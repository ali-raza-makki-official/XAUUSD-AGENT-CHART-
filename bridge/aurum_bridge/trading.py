"""Order management through the official MetaTrader5 Python API.

SAFETY CONTRACT (read before changing anything here):

* Trading is OFF unless the process was started with ``AURUM_TRADING=1`` (set only by the Aurum main
  process, from an explicit owner setting). Non-demo accounts are refused unless ``AURUM_ALLOW_LIVE=1``
  is ALSO set. The account type is re-checked on every request, because the owner can log into another
  account in the terminal at any time.
* Any non-200 HTTP answer from a trading endpoint means ``order_send`` was NOT called. A 200 answer carries
  ``status``: ``done`` | ``partial`` | ``rejected`` | ``unknown``. ``unknown`` means the request may or may not
  have reached the broker; the caller must reconcile (``/trade/find``) and must NEVER blindly resend.
* Every order carries a fixed ``magic`` and a ``comment`` derived from the command id, so a command can be found
  again after a crash or a timeout.
* order_check runs before order_send. Filling modes are only retried when the broker said the filling mode was
  invalid (nothing was executed). A timeout or an exception is never retried here.

This module needs a real MT5 terminal for the real behaviour. It is tested against a stand-in module only.
"""
from __future__ import annotations

import hashlib
import math
import threading
import time
from decimal import Decimal
from typing import Any, Callable, Optional

from .mt5_feed import FeedError, Mt5Feed

#: "AURU" as ASCII, fits an unsigned 32 bit integer. Every Aurum order carries this magic number.
AURUM_MAGIC = 1096041045
COMMENT_PREFIX = "AU:"
MAX_COMMENT = 31
TAG_HEX = 24  # 96 bits of sha256: collision-safe for any realistic number of commands
RESULT_CACHE_MAX = 500
MAX_DEVIATION_POINTS = 1000

# -- retcodes ---------------------------------------------------------------------------------------------
# kind: done | partial | unknown | rejected. "unknown" means the order may have been executed.
RETCODES: dict[int, tuple[str, str, str]] = {
    10004: ("REQUOTE", "The broker requoted the price. Nothing was executed; review the new price and try again.", "rejected"),
    10006: ("REJECT", "The broker rejected the request.", "rejected"),
    10007: ("CANCEL", "The request was cancelled.", "rejected"),
    10008: ("PLACED", "The order was placed.", "done"),
    10009: ("DONE", "The request was executed.", "done"),
    10010: ("DONE_PARTIAL", "The request was executed only partially. Check the volume that was filled.", "partial"),
    10011: ("ERROR", "The broker reported a request processing error.", "rejected"),
    10012: ("TIMEOUT", "The request timed out. It may or may not have been executed; it will be reconciled, not resent.", "unknown"),
    10013: ("INVALID", "The broker says the request is invalid.", "rejected"),
    10014: ("INVALID_VOLUME", "The broker says the volume is invalid (minimum, maximum or step).", "rejected"),
    10015: ("INVALID_PRICE", "The broker says the price is invalid.", "rejected"),
    10016: ("INVALID_STOPS", "The broker says the stop loss or take profit is invalid (too close to the price or on the wrong side).", "rejected"),
    10017: ("TRADE_DISABLED", "Trading is disabled for this account or symbol.", "rejected"),
    10018: ("MARKET_CLOSED", "The market is closed.", "rejected"),
    10019: ("NO_MONEY", "Not enough free margin for this order.", "rejected"),
    10020: ("PRICE_CHANGED", "The price changed. Nothing was executed; review the new price and try again.", "rejected"),
    10021: ("PRICE_OFF", "There are no quotes to process the request.", "rejected"),
    10022: ("INVALID_EXPIRATION", "The broker says the order expiration is invalid.", "rejected"),
    10023: ("ORDER_CHANGED", "The order state changed meanwhile.", "rejected"),
    10024: ("TOO_MANY_REQUESTS", "Too many requests in a short time. Wait a moment.", "rejected"),
    10025: ("NO_CHANGES", "Nothing to change: the position already has these values.", "done"),
    10026: ("SERVER_DISABLES_AT", "Auto trading is disabled by the broker server.", "rejected"),
    10027: ("CLIENT_DISABLES_AT", "Auto trading is disabled in the MT5 terminal. Press the Algo Trading button in MT5.", "rejected"),
    10028: ("LOCKED", "The request is blocked because the order or position is being processed.", "rejected"),
    10029: ("FROZEN", "The order or position is frozen (price is inside the broker freeze level).", "rejected"),
    10030: ("INVALID_FILL", "The broker does not accept this filling mode.", "rejected"),
    10031: ("CONNECTION", "No connection with the trade server. It will be reconciled, not resent.", "unknown"),
    10032: ("ONLY_REAL", "The operation is allowed only on real accounts.", "rejected"),
    10033: ("LIMIT_ORDERS", "The limit of pending orders has been reached.", "rejected"),
    10034: ("LIMIT_VOLUME", "The volume limit for this symbol has been reached.", "rejected"),
    10035: ("INVALID_ORDER", "The order type is invalid or not allowed.", "rejected"),
    10036: ("POSITION_CLOSED", "The position is already closed.", "rejected"),
    10038: ("INVALID_CLOSE_VOLUME", "The close volume is larger than the position volume.", "rejected"),
    10039: ("CLOSE_ORDER_EXIST", "A close order already exists for this position.", "rejected"),
    10040: ("LIMIT_POSITIONS", "The limit of open positions has been reached.", "rejected"),
    10041: ("REJECT_CANCEL", "The pending order activation request was rejected and the order cancelled.", "rejected"),
    10042: ("LONG_ONLY", "Only long positions are allowed on this symbol.", "rejected"),
    10043: ("SHORT_ONLY", "Only short positions are allowed on this symbol.", "rejected"),
    10044: ("CLOSE_ONLY", "Only closing positions is allowed on this symbol.", "rejected"),
    10045: ("FIFO_CLOSE", "Closing is blocked by the FIFO rule.", "rejected"),
    10046: ("HEDGE_PROHIBITED", "Hedging (opposite positions) is prohibited on this account.", "rejected"),
}
CHECK_OK = (0, 10009, 10008)


def retcode_info(code: Optional[int]) -> tuple[str, str, str]:
    if code is None:
        return ("NO_RESULT", "MT5 returned no result. The order may or may not have been executed; it will be reconciled, not resent.", "unknown")
    return RETCODES.get(int(code), (f"RETCODE_{code}", f"Unknown MT5 return code {code}.", "rejected"))


def command_tag(command_id: str) -> str:
    """Deterministic, collision-safe comment for a command id. Always <= 31 chars (MT5 limit)."""
    digest = hashlib.sha256(command_id.encode("utf-8")).hexdigest()[:TAG_HEX]
    tag = f"{COMMENT_PREFIX}{digest}"
    assert len(tag) <= MAX_COMMENT
    return tag


class TradeError(Exception):
    """A refusal BEFORE order_send. The HTTP layer answers non-200, so callers know nothing was sent."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class TradeQueryError(TradeError):
    def __init__(self, message: str):
        super().__init__(503, "query_failed", message)


ORDER_TYPE_NAMES = {0: "buy", 1: "sell", 2: "buy_limit", 3: "sell_limit", 4: "buy_stop", 5: "sell_stop", 6: "buy_stop_limit", 7: "sell_stop_limit", 8: "close_by"}
DEAL_TYPE_NAMES = {0: "buy", 1: "sell", 2: "balance", 3: "credit", 4: "charge", 5: "correction", 6: "bonus", 7: "commission"}
DEAL_ENTRY_NAMES = {0: "in", 1: "out", 2: "inout", 3: "out_by"}
DEAL_REASON_NAMES = {0: "client", 1: "mobile", 2: "web", 3: "expert", 4: "sl", 5: "tp", 6: "so", 7: "rollover", 8: "vmargin", 9: "split"}
PENDING_TYPES = ("buy_limit", "sell_limit", "buy_stop", "sell_stop")


def _g(obj: Any, name: str, default: Any = None) -> Any:
    return getattr(obj, name, default)


def _num(v: Any) -> Optional[float]:
    return None if v is None or v == 0 else float(v)


def pos_dict(p: Any) -> dict:
    t = int(_g(p, "type", 0))
    return {
        "ticket": int(p.ticket), "time": int(_g(p, "time", 0)), "type": "buy" if t == 0 else "sell",
        "volume": float(p.volume), "priceOpen": float(p.price_open), "sl": _num(_g(p, "sl")), "tp": _num(_g(p, "tp")),
        "priceCurrent": float(_g(p, "price_current", 0.0)), "swap": float(_g(p, "swap", 0.0)), "profit": float(_g(p, "profit", 0.0)),
        "symbol": str(_g(p, "symbol", "")), "magic": int(_g(p, "magic", 0)), "comment": str(_g(p, "comment", "")),
    }


def order_dict(o: Any) -> dict:
    return {
        "ticket": int(o.ticket), "time": int(_g(o, "time_setup", 0)), "type": ORDER_TYPE_NAMES.get(int(_g(o, "type", -1)), "unknown"),
        "volume": float(_g(o, "volume_current", _g(o, "volume_initial", 0.0))), "priceOpen": float(_g(o, "price_open", 0.0)),
        "sl": _num(_g(o, "sl")), "tp": _num(_g(o, "tp")), "priceCurrent": float(_g(o, "price_current", 0.0)),
        "state": int(_g(o, "state", 0)), "symbol": str(_g(o, "symbol", "")), "magic": int(_g(o, "magic", 0)),
        "comment": str(_g(o, "comment", "")), "expiration": int(_g(o, "time_expiration", 0)) or None, "positionId": int(_g(o, "position_id", 0)) or None,
    }


def deal_dict(d: Any) -> dict:
    return {
        "ticket": int(d.ticket), "order": int(_g(d, "order", 0)), "time": int(_g(d, "time", 0)),
        "type": DEAL_TYPE_NAMES.get(int(_g(d, "type", -1)), "other"), "entry": DEAL_ENTRY_NAMES.get(int(_g(d, "entry", -1)), "other"),
        "positionId": int(_g(d, "position_id", 0)), "volume": float(_g(d, "volume", 0.0)), "price": float(_g(d, "price", 0.0)),
        "commission": float(_g(d, "commission", 0.0)), "swap": float(_g(d, "swap", 0.0)), "profit": float(_g(d, "profit", 0.0)),
        "fee": float(_g(d, "fee", 0.0)), "reason": DEAL_REASON_NAMES.get(int(_g(d, "reason", -1)), "other"),
        "symbol": str(_g(d, "symbol", "")), "magic": int(_g(d, "magic", 0)), "comment": str(_g(d, "comment", "")),
    }


def _dec(x: float) -> Decimal:
    return Decimal(repr(float(x)))


def volume_is_valid(volume: Any, vmin: float, vmax: float, vstep: float) -> Optional[str]:
    if not isinstance(volume, (int, float)) or isinstance(volume, bool) or not math.isfinite(volume):
        return "Volume must be a finite number."
    if volume < vmin - 1e-12:
        return f"Volume {volume} is below the broker minimum {vmin}."
    if volume > vmax + 1e-12:
        return f"Volume {volume} is above the broker maximum {vmax}."
    if vstep > 0:
        steps = (_dec(volume) - _dec(vmin)) / _dec(vstep)
        if abs(steps - steps.to_integral_value()) > Decimal("1e-9"):
            return f"Volume {volume} is not a multiple of the broker step {vstep} (from minimum {vmin})."
    return None


class Mt5Trader:
    def __init__(
        self,
        feed: Mt5Feed,
        enabled: bool = False,
        allow_live: bool = False,
        send_timeout: float = 20.0,
        lock_timeout: float = 10.0,
    ):
        self.feed = feed
        self.enabled = bool(enabled)
        self.allow_live = bool(allow_live)
        self.send_timeout = send_timeout
        self.lock_timeout = lock_timeout
        self._results: dict[str, dict] = {}
        self._pending_send: Optional[threading.Thread] = None

    # -- helpers ---------------------------------------------------------------------------------------
    def _const(self, mt5: Any, name: str, default: int) -> int:
        return int(getattr(mt5, name, default))

    def status(self) -> dict:
        out: dict[str, Any] = {"enabled": self.enabled, "allowLive": self.allow_live, "canTrade": False, "reason": None, "demo": None, "magic": AURUM_MAGIC}
        if not self.enabled:
            out["reason"] = "Trading is disabled. Enable order placement in Aurum Settings (the bridge is started with AURUM_TRADING=1)."
            return out
        try:
            self.feed.ensure_connected()
            acc = self.feed.account()
            out["demo"] = bool(acc["demo"])
            if not acc["demo"] and not self.allow_live:
                out["reason"] = "This is a LIVE account and live trading has not been explicitly allowed."
            else:
                out["canTrade"] = True
        except FeedError as exc:
            out["reason"] = str(exc)
        return out

    def _gate(self) -> None:
        if not self.enabled:
            raise TradeError(403, "trading_disabled", "Trading endpoints are disabled. Start the bridge with AURUM_TRADING=1 (Aurum does this only when the owner enables order placement).")
        try:
            self.feed.ensure_connected()
            acc = self.feed.account()
        except FeedError as exc:
            raise TradeError(503, "not_connected", str(exc))
        if not acc["demo"] and not self.allow_live:
            raise TradeError(403, "live_refused", "This is a LIVE account. The bridge refuses to trade on live accounts unless live trading was explicitly allowed (AURUM_ALLOW_LIVE=1).")
        pend = self._pending_send
        if pend is not None:
            if pend.is_alive():
                raise TradeError(409, "send_pending", "A previous order_send has not returned yet. Trading is paused until it does; reconcile before doing anything else.")
            self._pending_send = None

    def _locked(self):
        lock = self.feed._lock
        if not lock.acquire(timeout=self.lock_timeout):
            raise TradeError(409, "busy", "The MT5 link is busy. Try again in a moment.")
        return lock

    def _symbol(self, mt5: Any, params: dict) -> Any:
        sym = params.get("symbol")
        if sym is not None and sym != self.feed.symbol:
            raise TradeError(400, "symbol_not_allowed", f"This bridge only trades {self.feed.symbol}, not {sym}.")
        info = mt5.symbol_info(self.feed.symbol)
        if info is None:
            raise TradeError(503, "no_symbol", f"No symbol info for {self.feed.symbol}.")
        return info

    def _terminal_checks(self, mt5: Any) -> None:
        term = mt5.terminal_info()
        if term is not None and getattr(term, "trade_allowed", True) is False:
            raise TradeError(409, "algo_trading_off", "Algo Trading is switched off in the MT5 terminal (the toolbar button). Turn it on to allow API orders.")
        acc = mt5.account_info()
        if acc is not None and getattr(acc, "trade_allowed", True) is False:
            raise TradeError(409, "account_trade_disabled", "Trading is not allowed on this account (investor/read-only password or broker restriction).")

    def _tick(self, mt5: Any) -> Any:
        t = mt5.symbol_info_tick(self.feed.symbol)
        if t is None or not (t.bid > 0 and t.ask > 0) or t.ask < t.bid:
            raise TradeError(409, "no_quotes", f"No valid quote for {self.feed.symbol} right now (market closed or no data).")
        return t

    @staticmethod
    def _round(info: Any, price: Optional[float]) -> Optional[float]:
        return None if price is None else round(float(price), int(info.digits))

    def _mode_allows(self, mt5: Any, info: Any, side: str, opening: bool) -> None:
        mode = int(getattr(info, "trade_mode", 4))
        disabled = self._const(mt5, "SYMBOL_TRADE_MODE_DISABLED", 0)
        longonly = self._const(mt5, "SYMBOL_TRADE_MODE_LONGONLY", 1)
        shortonly = self._const(mt5, "SYMBOL_TRADE_MODE_SHORTONLY", 2)
        closeonly = self._const(mt5, "SYMBOL_TRADE_MODE_CLOSEONLY", 3)
        if mode == disabled:
            raise TradeError(409, "symbol_trading_disabled", f"Trading is disabled for {self.feed.symbol} (market closed or restricted).")
        if opening and mode == closeonly:
            raise TradeError(409, "close_only", f"{self.feed.symbol} is in close-only mode: new positions cannot be opened.")
        if opening and mode == longonly and side == "sell":
            raise TradeError(409, "long_only", f"{self.feed.symbol} allows long positions only.")
        if opening and mode == shortonly and side == "buy":
            raise TradeError(409, "short_only", f"{self.feed.symbol} allows short positions only.")

    def _check_volume(self, info: Any, volume: Any) -> float:
        msg = volume_is_valid(volume, float(info.volume_min), float(info.volume_max), float(info.volume_step))
        if msg:
            raise TradeError(400, "invalid_volume", msg)
        return float(volume)

    def _opt_price(self, params: dict, key: str) -> Optional[float]:
        v = params.get(key)
        if v is None:
            return None
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
            raise TradeError(400, "invalid_price", f"{key} must be a non-negative number.")
        return float(v)

    def _deviation(self, params: dict) -> int:
        d = params.get("deviationPoints", 20)
        if isinstance(d, bool) or not isinstance(d, (int, float)) or d < 0 or d > MAX_DEVIATION_POINTS:
            raise TradeError(400, "invalid_deviation", f"deviationPoints must be between 0 and {MAX_DEVIATION_POINTS}.")
        return int(d)

    def _stops_ok(self, side: str, ref: float, sl: Optional[float], tp: Optional[float], stops: float, label: str) -> None:
        """SL/TP must be on the right side of `ref` and at least the broker stops level away from it."""
        eps = 1e-9
        if side == "buy":
            if sl and not sl <= ref - stops + eps:
                raise TradeError(400, "invalid_sl", f"Stop loss {sl} must be at least {stops:.5f} below {label} {ref} for a buy.")
            if tp and not tp >= ref + stops - eps:
                raise TradeError(400, "invalid_tp", f"Take profit {tp} must be at least {stops:.5f} above {label} {ref} for a buy.")
        else:
            if sl and not sl >= ref + stops - eps:
                raise TradeError(400, "invalid_sl", f"Stop loss {sl} must be at least {stops:.5f} above {label} {ref} for a sell.")
            if tp and not tp <= ref - stops + eps:
                raise TradeError(400, "invalid_tp", f"Take profit {tp} must be at least {stops:.5f} below {label} {ref} for a sell.")

    # -- read endpoints --------------------------------------------------------------------------------
    def _seq(self, mt5: Any, value: Any, what: str) -> list:
        if value is None:
            err = mt5.last_error()
            if isinstance(err, tuple) and err and int(err[0]) not in (1, 0):
                raise TradeQueryError(f"MT5 could not return {what}: {err}")
            return []
        return list(value)

    def positions(self) -> list[dict]:
        self.feed.ensure_connected()
        with self.feed._lock:
            mt5 = self.feed._module()
            return [pos_dict(p) for p in self._seq(mt5, mt5.positions_get(symbol=self.feed.symbol), "positions")]

    def orders(self) -> list[dict]:
        self.feed.ensure_connected()
        with self.feed._lock:
            mt5 = self.feed._module()
            return [order_dict(o) for o in self._seq(mt5, mt5.orders_get(symbol=self.feed.symbol), "orders")]

    def _window(self, mt5: Any, since: Optional[float]) -> tuple[Any, Any, float, float]:
        from datetime import datetime, timezone

        t = mt5.symbol_info_tick(self.feed.symbol)
        server_now = float(getattr(t, "time", 0)) if t is not None else 0.0
        if server_now <= 0:
            server_now = time.time()
        start = (since if since else server_now - 2 * 86400) - 3600
        end = server_now + 86400

        def conv(ts: float) -> Any:
            return datetime.fromtimestamp(ts, tz=timezone.utc)

        return conv(start), conv(end), start, end

    def deals(self, since: Optional[float] = None) -> dict:
        self.feed.ensure_connected()
        with self.feed._lock:
            mt5 = self.feed._module()
            a, b, s, e = self._window(mt5, since)
            rows = self._seq(mt5, mt5.history_deals_get(a, b), "deal history")
            out = [deal_dict(d) for d in rows if str(_g(d, "symbol", "")) in (self.feed.symbol, "")]
            return {"deals": out, "from": s, "to": e}

    def evidence(self, command_id: str, ticket: Optional[int] = None, since: Optional[float] = None) -> dict:
        """Everything MT5 knows about a command, found by magic + comment (never by guessing)."""
        self.feed.ensure_connected()
        tag = command_tag(command_id)
        with self.feed._lock:
            mt5 = self.feed._module()
            return self._evidence_locked(mt5, tag, ticket, since)

    def _evidence_locked(self, mt5: Any, tag: str, ticket: Optional[int], since: Optional[float]) -> dict:
        def mine(x: Any) -> bool:
            return int(_g(x, "magic", 0)) == AURUM_MAGIC and tag in str(_g(x, "comment", ""))

        positions = [pos_dict(p) for p in self._seq(mt5, mt5.positions_get(symbol=self.feed.symbol), "positions")]
        orders = [order_dict(o) for o in self._seq(mt5, mt5.orders_get(symbol=self.feed.symbol), "orders")]
        a, b, s, e = self._window(mt5, since)
        deals_raw = self._seq(mt5, mt5.history_deals_get(a, b), "deal history")
        hist_raw = self._seq(mt5, mt5.history_orders_get(a, b), "order history")
        out: dict[str, Any] = {
            "tag": tag, "magic": AURUM_MAGIC, "window": {"from": s, "to": e},
            "queried": {"positions": True, "orders": True, "deals": True, "historyOrders": True},
            "positions": [p for p in positions if p["magic"] == AURUM_MAGIC and tag in p["comment"]],
            "orders": [o for o in orders if o["magic"] == AURUM_MAGIC and tag in o["comment"]],
            "deals": [deal_dict(d) for d in deals_raw if mine(d)],
            "historyOrders": [order_dict(o) for o in hist_raw if mine(o)],
            "target": None,
        }
        if ticket is not None:
            out["target"] = {
                "ticket": int(ticket),
                "position": next((p for p in positions if p["ticket"] == int(ticket)), None),
                "order": next((o for o in orders if o["ticket"] == int(ticket)), None),
                "deals": [deal_dict(d) for d in deals_raw if int(_g(d, "position_id", 0)) == int(ticket)],
            }
        return out

    # -- trading ---------------------------------------------------------------------------------------
    def execute(self, action: str, params: dict) -> dict:
        builders: dict[str, Callable[..., tuple[dict, dict]]] = {
            "open_market": self._build_open_market,
            "open_pending": self._build_open_pending,
            "modify_sltp": self._build_modify,
            "close_position": self._build_close,
            "partial_close": self._build_close,
            "cancel_pending": self._build_cancel,
        }
        if action not in builders:
            raise TradeError(404, "unknown_action", f"Unknown trade action '{action}'.")
        command_id = params.get("commandId")
        if not isinstance(command_id, str) or not (8 <= len(command_id) <= 80):
            raise TradeError(400, "invalid_command_id", "commandId (8-80 chars) is required.")
        self._gate()
        tag = command_tag(command_id)
        lock = self._locked()
        try:
            cached = self._results.get(tag)
            if cached is not None:
                return {**cached, "duplicate": True}
            mt5 = self.feed._module()
            self._terminal_checks(mt5)
            info = self._symbol(mt5, params)
            req, ctx = builders[action](mt5, info, action, params, tag)
            guard = self._duplicate_guard(mt5, action, tag)
            outcome = guard if guard is not None else self._send(mt5, info, action, req, ctx, tag)
            self._remember(tag, outcome)
            return outcome
        finally:
            lock.release()

    def _remember(self, tag: str, outcome: dict) -> None:
        if len(self._results) >= RESULT_CACHE_MAX:
            self._results.pop(next(iter(self._results)))
        self._results[tag] = outcome

    def _duplicate_guard(self, mt5: Any, action: str, tag: str) -> Optional[dict]:
        """If MT5 already holds a trace of this command (e.g. after a bridge restart), do not send it again."""
        if action not in ("open_market", "open_pending", "close_position", "partial_close"):
            return None
        ev = self._evidence_locked(mt5, tag, None, None)
        if action in ("open_market", "open_pending"):
            hits = ev["positions"] or ev["orders"] or [d for d in ev["deals"] if d["entry"] == "in"] or ev["historyOrders"]
            hit = hits[0] if hits else None
        else:
            hit = next((d for d in ev["deals"] if d["entry"] in ("out", "out_by")), None)
        if hit is None:
            return None
        return {
            "status": "done", "stage": "duplicate_guard", "action": action, "tag": tag, "magic": AURUM_MAGIC, "retcode": None,
            "retcodeName": "ALREADY_EXECUTED", "message": "MT5 already holds an order or deal for this command id. Nothing was sent again.",
            "brokerComment": None, "order": hit.get("order") or hit.get("ticket"), "deal": hit.get("ticket") if "entry" in hit else None,
            "positionTicket": hit.get("positionId") or hit.get("ticket"), "volume": hit.get("volume"), "price": hit.get("price") or hit.get("priceOpen"),
        }

    # request builders: return (request dict, context). They raise TradeError for anything wrong BEFORE sending.
    def _side(self, params: dict) -> str:
        side = params.get("side")
        if side not in ("buy", "sell"):
            raise TradeError(400, "invalid_side", "side must be 'buy' or 'sell'.")
        return side

    def _build_open_market(self, mt5: Any, info: Any, action: str, params: dict, tag: str) -> tuple[dict, dict]:
        side = self._side(params)
        volume = self._check_volume(info, params.get("volume"))
        self._mode_allows(mt5, info, side, True)
        tick = self._tick(mt5)
        sl, tp = self._round(info, self._opt_price(params, "sl")), self._round(info, self._opt_price(params, "tp"))
        stops = float(getattr(info, "trade_stops_level", 0)) * float(info.point)
        self._stops_ok(side, float(tick.bid if side == "buy" else tick.ask), sl, tp, stops, "the current price")
        price = float(tick.ask if side == "buy" else tick.bid)
        req = {
            "action": self._const(mt5, "TRADE_ACTION_DEAL", 1), "symbol": self.feed.symbol, "volume": volume,
            "type": self._const(mt5, "ORDER_TYPE_BUY" if side == "buy" else "ORDER_TYPE_SELL", 0 if side == "buy" else 1),
            "price": price, "sl": sl or 0.0, "tp": tp or 0.0, "deviation": self._deviation(params), "magic": AURUM_MAGIC,
            "comment": tag, "type_time": self._const(mt5, "ORDER_TIME_GTC", 0),
        }
        return req, {"fill": "deal", "positionFromOrder": True}

    def _build_open_pending(self, mt5: Any, info: Any, action: str, params: dict, tag: str) -> tuple[dict, dict]:
        otype = params.get("orderType")
        if otype not in PENDING_TYPES:
            raise TradeError(400, "invalid_order_type", f"orderType must be one of {', '.join(PENDING_TYPES)}.")
        side = "buy" if otype.startswith("buy") else "sell"
        volume = self._check_volume(info, params.get("volume"))
        self._mode_allows(mt5, info, side, True)
        tick = self._tick(mt5)
        price = self._round(info, self._opt_price(params, "price"))
        if not price:
            raise TradeError(400, "invalid_price", "price is required for a pending order.")
        sl, tp = self._round(info, self._opt_price(params, "sl")), self._round(info, self._opt_price(params, "tp"))
        stops = float(getattr(info, "trade_stops_level", 0)) * float(info.point)
        ask, bid = float(tick.ask), float(tick.bid)
        eps = 1e-9
        bad = {
            "buy_limit": price > ask - stops + eps, "buy_stop": price < ask + stops - eps,
            "sell_limit": price < bid + stops - eps, "sell_stop": price > bid - stops + eps,
        }[otype]
        if bad:
            raise TradeError(400, "invalid_price", f"{otype} price {price} is on the wrong side of the market (ask {ask}, bid {bid}) or closer than the broker stops level {stops:.5f}.")
        self._stops_ok(side, price, sl, tp, stops, "the order price")
        expiration = params.get("expiration")
        if expiration is not None and (isinstance(expiration, bool) or not isinstance(expiration, (int, float)) or expiration <= 0):
            raise TradeError(400, "invalid_expiration", "expiration must be a unix timestamp (broker server time).")
        req = {
            "action": self._const(mt5, "TRADE_ACTION_PENDING", 5), "symbol": self.feed.symbol, "volume": volume,
            "type": self._const(mt5, "ORDER_TYPE_" + otype.upper(), {"buy_limit": 2, "sell_limit": 3, "buy_stop": 4, "sell_stop": 5}[otype]),
            "price": price, "sl": sl or 0.0, "tp": tp or 0.0, "deviation": self._deviation(params), "magic": AURUM_MAGIC, "comment": tag,
            "type_time": self._const(mt5, "ORDER_TIME_SPECIFIED", 2) if expiration else self._const(mt5, "ORDER_TIME_GTC", 0),
        }
        if expiration:
            req["expiration"] = int(expiration)
        return req, {"fill": "pending"}

    def _one(self, mt5: Any, rows: Any, what: str) -> Optional[Any]:
        seq = self._seq(mt5, rows, what)
        return seq[0] if seq else None

    def _ticket(self, params: dict, key: str = "ticket") -> int:
        t = params.get(key)
        if isinstance(t, bool) or not isinstance(t, int) or t <= 0:
            raise TradeError(400, "invalid_ticket", f"{key} must be a positive integer.")
        return t

    def _build_modify(self, mt5: Any, info: Any, action: str, params: dict, tag: str) -> tuple[dict, dict]:
        ticket = self._ticket(params)
        kind = params.get("ticketKind", "position")
        if kind not in ("position", "order"):
            raise TradeError(400, "invalid_ticket_kind", "ticketKind must be 'position' or 'order'.")
        tick = self._tick(mt5)
        stops = float(getattr(info, "trade_stops_level", 0)) * float(info.point)
        freeze = float(getattr(info, "trade_freeze_level", 0)) * float(info.point)
        # Absent key = keep the current value; null/0 = remove it. SLTP requests ALWAYS carry both values,
        # otherwise MT5 would clear the omitted one.
        od: dict = {}
        if kind == "position":
            p = self._one(mt5, mt5.positions_get(ticket=ticket), "position")
            if p is None or str(_g(p, "symbol", "")) != self.feed.symbol:
                raise TradeError(404, "position_not_found", f"Position #{ticket} was not found on {self.feed.symbol}.")
            side = "buy" if int(p.type) == 0 else "sell"
            cur_sl, cur_tp = _num(_g(p, "sl")), _num(_g(p, "tp"))
            ref = float(tick.bid if side == "buy" else tick.ask)
        else:
            o = self._one(mt5, mt5.orders_get(ticket=ticket), "order")
            if o is None or str(_g(o, "symbol", "")) != self.feed.symbol:
                raise TradeError(404, "order_not_found", f"Pending order #{ticket} was not found on {self.feed.symbol}.")
            od = order_dict(o)
            if od["type"] not in PENDING_TYPES:
                raise TradeError(400, "invalid_order_type", "Only limit/stop pending orders can be modified.")
            side = "buy" if od["type"].startswith("buy") else "sell"
            cur_sl, cur_tp = od["sl"], od["tp"]
            ref = float(od["priceOpen"])
        new_sl = cur_sl if "sl" not in params else (self._round(info, self._opt_price(params, "sl")) or None)
        new_tp = cur_tp if "tp" not in params else (self._round(info, self._opt_price(params, "tp")) or None)
        changed_sl, changed_tp = new_sl != cur_sl, new_tp != cur_tp
        if not changed_sl and not changed_tp:
            return {}, {"noop": True}
        if kind == "position" and freeze > 0:
            for label, cur in (("stop loss", cur_sl), ("take profit", cur_tp)):
                if cur and abs(ref - cur) <= freeze + 1e-9:
                    raise TradeError(409, "freeze_level", f"The current price is within the broker freeze level ({freeze:.5f}) of the existing {label} {cur}; the position cannot be modified right now.")
        self._stops_ok(side, ref, new_sl if changed_sl else None, new_tp if changed_tp else None, stops, "the current price" if kind == "position" else "the order price")
        if kind == "position":
            req = {
                "action": self._const(mt5, "TRADE_ACTION_SLTP", 6), "symbol": self.feed.symbol, "position": ticket,
                "sl": new_sl or 0.0, "tp": new_tp or 0.0, "magic": AURUM_MAGIC,
            }
            return req, {"fill": None}
        if freeze > 0:
            cur_price = float(tick.ask if side == "buy" else tick.bid)
            if abs(cur_price - od["priceOpen"]) <= freeze + 1e-9:
                raise TradeError(409, "freeze_level", f"The market is within the broker freeze level ({freeze:.5f}) of this pending order; it cannot be modified right now.")
        req = {
            "action": self._const(mt5, "TRADE_ACTION_MODIFY", 7), "order": ticket, "symbol": self.feed.symbol,
            "price": od["priceOpen"], "sl": new_sl or 0.0, "tp": new_tp or 0.0,
            "type_time": self._const(mt5, "ORDER_TIME_SPECIFIED", 2) if od["expiration"] else self._const(mt5, "ORDER_TIME_GTC", 0),
        }
        if od["expiration"]:
            req["expiration"] = od["expiration"]
        return req, {"fill": "pending"}

    def _build_close(self, mt5: Any, info: Any, action: str, params: dict, tag: str) -> tuple[dict, dict]:
        ticket = self._ticket(params)
        p = self._one(mt5, mt5.positions_get(ticket=ticket), "position")
        if p is None or str(_g(p, "symbol", "")) != self.feed.symbol:
            raise TradeError(404, "position_not_found", f"Position #{ticket} was not found on {self.feed.symbol} (already closed?).")
        pos_vol = float(p.volume)
        if action == "partial_close":
            vol = self._check_volume(info, params.get("volume"))
            if vol >= pos_vol - 1e-12:
                raise TradeError(400, "invalid_volume", f"A partial close must be smaller than the position volume {pos_vol}. Use close_position to close it all.")
            remainder = float(_dec(pos_vol) - _dec(vol))
            if remainder < float(info.volume_min) - 1e-12:
                raise TradeError(400, "invalid_volume", f"Closing {vol} would leave {remainder}, below the broker minimum {info.volume_min}.")
        else:
            vol = pos_vol
            given = params.get("volume")
            if given is not None and abs(float(given) - pos_vol) > 1e-9:
                raise TradeError(400, "invalid_volume", "close_position closes the whole position; use partial_close for a smaller volume.")
        side_pos = "buy" if int(p.type) == 0 else "sell"
        self._mode_allows(mt5, info, side_pos, False)
        tick = self._tick(mt5)
        close_buy = side_pos == "buy"  # a long is closed by selling at bid
        req = {
            "action": self._const(mt5, "TRADE_ACTION_DEAL", 1), "symbol": self.feed.symbol, "volume": vol, "position": ticket,
            "type": self._const(mt5, "ORDER_TYPE_SELL" if close_buy else "ORDER_TYPE_BUY", 1 if close_buy else 0),
            "price": float(tick.bid if close_buy else tick.ask), "deviation": self._deviation(params), "magic": AURUM_MAGIC,
            "comment": tag, "type_time": self._const(mt5, "ORDER_TIME_GTC", 0),
        }
        return req, {"fill": "deal", "positionTicket": ticket, "volumeBefore": pos_vol}

    def _build_cancel(self, mt5: Any, info: Any, action: str, params: dict, tag: str) -> tuple[dict, dict]:
        ticket = self._ticket(params)
        o = self._one(mt5, mt5.orders_get(ticket=ticket), "order")
        if o is None or str(_g(o, "symbol", "")) != self.feed.symbol:
            raise TradeError(404, "order_not_found", f"Pending order #{ticket} was not found on {self.feed.symbol}.")
        freeze = float(getattr(info, "trade_freeze_level", 0)) * float(info.point)
        if freeze > 0:
            tick = self._tick(mt5)
            od = order_dict(o)
            mkt = float(tick.ask if od["type"].startswith("buy") else tick.bid)
            if abs(mkt - od["priceOpen"]) <= freeze + 1e-9:
                raise TradeError(409, "freeze_level", f"The market is within the broker freeze level ({freeze:.5f}) of this pending order; it cannot be cancelled right now.")
        return {"action": self._const(mt5, "TRADE_ACTION_REMOVE", 8), "order": ticket, "comment": tag}, {"fill": None, "skipCheck": True}

    # -- sending ---------------------------------------------------------------------------------------
    def _filling_candidates(self, mt5: Any, info: Any, kind: Optional[str]) -> list[Optional[int]]:
        if kind is None:
            return [None]
        fok = self._const(mt5, "ORDER_FILLING_FOK", 0)
        ioc = self._const(mt5, "ORDER_FILLING_IOC", 1)
        ret = self._const(mt5, "ORDER_FILLING_RETURN", 2)
        flags = int(getattr(info, "filling_mode", 0))
        allowed: list[Optional[int]] = []
        if flags & 2:
            allowed.append(ioc)
        if flags & 1:
            allowed.append(fok)
        # RETURN is not a symbol flag: it is available for pending orders and for non-market execution modes.
        if kind == "pending":
            return [ret, *allowed]
        return [*allowed, ret]

    @staticmethod
    def _fail(base: dict, status: str, stage: str, retcode: Optional[int], name: str, message: str, **extra: Any) -> dict:
        return {**base, "status": status, "stage": stage, "retcode": retcode, "retcodeName": name, "message": message,
                "brokerComment": extra.pop("brokerComment", None), "order": None, "deal": None, "positionTicket": None, **extra}

    def _send(self, mt5: Any, info: Any, action: str, req: dict, ctx: dict, tag: str) -> dict:
        base = {"action": action, "tag": tag, "magic": AURUM_MAGIC, "request": dict(req)}
        if ctx.get("noop"):
            return self._fail(base, "done", "precheck", 10025, "NO_CHANGES", retcode_info(10025)[1])
        candidates = self._filling_candidates(mt5, info, ctx.get("fill"))
        last_check: Optional[dict] = None
        for i, filling in enumerate(candidates):
            is_last = i == len(candidates) - 1
            if filling is not None:
                req["type_filling"] = filling
                base["request"] = dict(req)
            if not ctx.get("skipCheck"):
                try:
                    chk = mt5.order_check(req)
                except Exception as exc:  # order_check failing means nothing was sent
                    raise TradeError(503, "order_check_failed", f"order_check raised: {exc}")
                if chk is None:
                    raise TradeError(503, "order_check_failed", f"order_check returned nothing: {mt5.last_error()}")
                rc = int(chk.retcode)
                last_check = {"retcode": rc, "name": retcode_info(rc)[0], "comment": str(_g(chk, "comment", "")),
                              "margin": _g(chk, "margin"), "marginFree": _g(chk, "margin_free")}
                if rc == 10030:
                    if is_last:
                        break
                    continue  # this filling mode is not accepted: try the next one (nothing was executed)
                if rc == 10025:
                    return self._fail(base, "done", "check", rc, "NO_CHANGES", retcode_info(rc)[1], check=last_check, brokerComment=last_check["comment"])
                if rc not in CHECK_OK:
                    name, msg, _ = retcode_info(rc)
                    return self._fail(base, "rejected", "check", rc, name, f"{msg} (order_check, nothing was sent)", check=last_check,
                                      brokerComment=last_check["comment"], filling=filling)
            outcome = self._order_send(mt5, req, ctx, base, filling, last_check)
            if outcome["retcode"] == 10030 and not is_last:
                continue
            return outcome
        return self._fail(base, "rejected", "check", 10030, "INVALID_FILL", "No filling mode accepted by the broker for this symbol. Nothing was sent.", check=last_check)

    def _order_send(self, mt5: Any, req: dict, ctx: dict, base: dict, filling: Optional[int], check: Optional[dict]) -> dict:
        holder: dict[str, Any] = {}

        def run() -> None:
            try:
                holder["result"] = mt5.order_send(req)
            except BaseException as exc:  # noqa: BLE001 - anything raised here means "unknown", never "not sent"
                holder["error"] = exc

        th = threading.Thread(target=run, daemon=True, name="aurum-order-send")
        th.start()
        th.join(self.send_timeout)
        extra = {"filling": filling, "check": check}
        if th.is_alive():
            self._pending_send = th
            return self._fail(base, "unknown", "send", None, "SEND_TIMEOUT",
                              f"order_send did not return within {self.send_timeout:g}s. The order may or may not have been executed; it will be reconciled, not resent. Trading is paused until MT5 answers.", **extra)
        if "error" in holder:
            err = holder["error"]
            return self._fail(base, "unknown", "send", None, "SEND_EXCEPTION",
                              f"order_send raised {type(err).__name__}: {err}. The order may or may not have been executed; it will be reconciled, not resent.", **extra)
        res = holder.get("result")
        if res is None:
            return self._fail(base, "unknown", "send", None, "NO_RESULT", f"{retcode_info(None)[1]} (MT5 last_error: {mt5.last_error()})", **extra)
        rc = int(res.retcode)
        name, msg, kind = retcode_info(rc)
        order_t, deal_t = int(_g(res, "order", 0)) or None, int(_g(res, "deal", 0)) or None
        position_ticket = ctx.get("positionTicket")
        if position_ticket is None and ctx.get("positionFromOrder") and kind in ("done", "partial"):
            position_ticket = order_t  # on hedging accounts the position id equals the opening order ticket
        out = {
            **base, "status": kind, "stage": "send", "retcode": rc, "retcodeName": name, "message": msg,
            "brokerComment": str(_g(res, "comment", "")), "order": order_t, "deal": deal_t, "positionTicket": position_ticket,
            "volume": float(_g(res, "volume", 0.0)), "price": float(_g(res, "price", 0.0)), "bid": float(_g(res, "bid", 0.0)),
            "ask": float(_g(res, "ask", 0.0)), "requestId": int(_g(res, "request_id", 0)), **extra,
        }
        if "volumeBefore" in ctx:
            out["volumeBefore"] = ctx["volumeBefore"]
        return out
