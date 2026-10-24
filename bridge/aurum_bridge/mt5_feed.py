"""Read-only link to a running MetaTrader 5 terminal.

Uses the official ``MetaTrader5`` Python package, which attaches to the terminal that is already
open and logged in. No EA is involved and no credentials are stored here. This module returns real
broker data only; if the terminal is unavailable it raises FeedError and callers show that state.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Optional

TIMEFRAMES = ("M1", "M5", "M15", "M30", "H1", "H4", "D1")
MAX_CANDLES = 5000
RECONNECT_MIN_INTERVAL = 2.0


class FeedError(Exception):
    """A readable reason why real data is not available right now."""


def _import_mt5() -> Any:
    try:
        import MetaTrader5 as mt5  # type: ignore

        return mt5
    except ImportError as exc:  # non-Windows or package not installed
        raise FeedError(
            "MetaTrader5 Python package is not available. It works on Windows only: "
            "run `pip install MetaTrader5` on the PC where MT5 is installed."
        ) from exc


class Mt5Feed:
    def __init__(self, symbol: str, terminal_path: Optional[str] = None, mt5_module: Any = None):
        self.symbol = symbol
        self.terminal_path = terminal_path
        self._mt5 = mt5_module
        self._lock = threading.Lock()
        self._connected = False
        self._last_error: Optional[str] = None
        self._last_attempt = 0.0

    # -- connection -------------------------------------------------------------------------
    def _module(self) -> Any:
        if self._mt5 is None:
            self._mt5 = _import_mt5()
        return self._mt5

    def _connect_locked(self) -> None:
        mt5 = self._module()
        ok = mt5.initialize(self.terminal_path) if self.terminal_path else mt5.initialize()
        if not ok:
            raise FeedError(f"Cannot attach to MT5 terminal: {mt5.last_error()}. Open MT5 and log in.")
        term = mt5.terminal_info()
        if term is not None and not getattr(term, "connected", True):
            raise FeedError("MT5 terminal is open but not connected to the broker server.")
        if mt5.account_info() is None:
            raise FeedError("MT5 terminal has no logged-in account.")
        if mt5.symbol_info(self.symbol) is None:
            raise FeedError(
                f"Symbol '{self.symbol}' not found on this broker. Use /symbols to find the gold symbol name."
            )
        if not mt5.symbol_select(self.symbol, True):
            raise FeedError(f"Could not add '{self.symbol}' to Market Watch: {mt5.last_error()}")
        self._connected = True
        self._last_error = None

    def ensure_connected(self) -> None:
        with self._lock:
            if self._connected:
                return
            now = time.monotonic()
            if now - self._last_attempt < RECONNECT_MIN_INTERVAL and self._last_error:
                raise FeedError(self._last_error)
            self._last_attempt = now
            try:
                self._connect_locked()
            except FeedError as exc:
                self._connected = False
                self._last_error = str(exc)
                raise

    def _drop(self, reason: str) -> FeedError:
        self._connected = False
        self._last_error = reason
        return FeedError(reason)

    # -- data -------------------------------------------------------------------------------
    def health(self) -> dict:
        try:
            self.ensure_connected()
        except FeedError:
            pass
        return {
            "ok": True,
            "connected": self._connected,
            "symbol": self.symbol,
            "error": None if self._connected else self._last_error,
            "version": "0.1.0",
        }

    def account(self) -> dict:
        self.ensure_connected()
        with self._lock:
            mt5 = self._module()
            info = mt5.account_info()
            if info is None:
                raise self._drop("MT5 account info unavailable (terminal logged out?)")
            demo = info.trade_mode == getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0)
            return {
                "login": int(info.login),
                "server": str(info.server),
                "currency": str(info.currency),
                "demo": bool(demo),
                "name": str(getattr(info, "name", "")) or None,
            }

    def tick(self) -> dict:
        self.ensure_connected()
        with self._lock:
            mt5 = self._module()
            t = mt5.symbol_info_tick(self.symbol)
            if t is None or (t.bid == 0 and t.ask == 0):
                raise self._drop(f"No tick for {self.symbol}: {mt5.last_error()}")
            tms = getattr(t, "time_msc", 0)
            ts = tms / 1000.0 if tms else float(t.time)
            return {
                "symbol": self.symbol,
                "bid": float(t.bid),
                "ask": float(t.ask),
                "time": ts,
                "spread": round(float(t.ask) - float(t.bid), 10),
            }

    def candles(self, tf: str, count: int) -> dict:
        if tf not in TIMEFRAMES:
            raise ValueError(f"Unknown timeframe {tf}")
        count = max(1, min(int(count), MAX_CANDLES))
        self.ensure_connected()
        with self._lock:
            mt5 = self._module()
            rates = mt5.copy_rates_from_pos(self.symbol, getattr(mt5, f"TIMEFRAME_{tf}"), 0, count)
            if rates is None or len(rates) == 0:
                raise self._drop(f"No {tf} candles for {self.symbol}: {mt5.last_error()}")
            out = [
                {
                    "time": int(r["time"]),
                    "open": float(r["open"]),
                    "high": float(r["high"]),
                    "low": float(r["low"]),
                    "close": float(r["close"]),
                    "volume": float(r["tick_volume"]),
                }
                for r in rates
            ]
            return {"symbol": self.symbol, "tf": tf, "candles": out}

    def symbol_spec(self) -> dict:
        """Contract specification used by the deterministic risk engine."""
        self.ensure_connected()
        with self._lock:
            mt5 = self._module()
            s = mt5.symbol_info(self.symbol)
            if s is None:
                raise self._drop(f"No symbol info for {self.symbol}")
            return {
                "symbol": self.symbol,
                "digits": int(s.digits),
                "point": float(s.point),
                "contractSize": float(s.trade_contract_size),
                "tickSize": float(s.trade_tick_size),
                "tickValue": float(s.trade_tick_value),
                "volumeMin": float(s.volume_min),
                "volumeMax": float(s.volume_max),
                "volumeStep": float(s.volume_step),
            }

    def find_symbols(self, needles: list[str]) -> list[str]:
        self.ensure_connected()
        with self._lock:
            mt5 = self._module()
            syms = mt5.symbols_get() or []
            wanted = [n.upper() for n in needles]
            return sorted(s.name for s in syms if any(w in s.name.upper() for w in wanted))[:50]
