"""Read-only link to a running MetaTrader 5 terminal.

Uses the official ``MetaTrader5`` Python package, which attaches to the terminal that is already
open and logged in. No EA is involved and no credentials are stored here. This module returns real
broker data only; if the terminal is unavailable it raises FeedError and callers show that state.
"""
from __future__ import annotations

import re
import glob as _glob
import os
import threading
import time
from typing import Any, Optional

TIMEFRAMES = ("M1", "M5", "M15", "M30", "H1", "H4", "D1")
MAX_CANDLES = 5000
MAX_QUOTE_SYMBOLS = 12
# MT5 symbol names: letters, digits and a few separators (e.g. US500.cash, #USTEC, DXY.f, XAUUSDm).
_SYMBOL_OK = re.compile(r"^[A-Za-z0-9._#@!$&+\-]{1,32}$")
RECONNECT_MIN_INTERVAL = 2.0


def candidate_terminals(env=None, find=_glob.glob) -> list:
    """MT5 terminals installed on this PC (Windows). Brokers install to names like 'MetaTrader 5 EXNESS'."""
    env = env if env is not None else os.environ
    roots = [env.get(k) for k in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "LOCALAPPDATA") if env.get(k)]
    found: list = []
    for root in roots:
        for pattern in (os.path.join(root, "*MetaTrader*", "terminal64.exe"), os.path.join(root, "Programs", "*MetaTrader*", "terminal64.exe")):
            for p in sorted(find(pattern)):
                if p not in found:
                    found.append(p)
    return found


def explain_init_error(err) -> str:
    """Turn MT5's numeric initialize() error into something a trader can act on."""
    code = err[0] if isinstance(err, (tuple, list)) and err else None
    if code == -6:
        return ("MT5 refused the connection (Authorization failed). Check that: (1) the MT5 terminal is open and logged in to your "
                "account (green connection bars at the bottom right); (2) MT5 and Aurum run at the same privilege level (do not run "
                "one of them as Administrator); (3) if several MT5 terminals are installed, set the terminal path in Settings > General.")
    if code in (-10003, -10004):
        return "Aurum could not start or find the MT5 terminal. Set the full path to terminal64.exe in Settings > General."
    if code == -10005:
        return "MT5 did not answer in time. Wait for the terminal to finish loading, then press Retry."
    if code == -2:
        return "MT5 reported an invalid argument. Check the terminal path in Settings > General."
    return f"Cannot attach to the MT5 terminal: {err}. Open MT5 and log in."


class FeedError(Exception):
    """A readable reason why real data is not available right now."""


def _import_mt5() -> Any:
    try:
        import MetaTrader5 as mt5  # type: ignore

        return mt5
    except ImportError as exc:
        import platform
        import sys

        exe = sys.executable or "python"
        where = f"Aurum is using Python {platform.python_version()} at {exe}."
        if sys.platform != "win32":
            raise FeedError(f"The MetaTrader5 package only works on Windows. {where}") from exc
        raise FeedError(
            f"Cannot import the MetaTrader5 package ({exc}). {where} Install it for exactly this Python: "
            f'"{exe}" -m pip install MetaTrader5. If pip finds no matching version, this Python is too new or 32-bit: '
            "install 64-bit Python 3.12 and set the environment variable AURUM_PYTHON to its python.exe."
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
        self.terminal_path_used: Optional[str] = None

    # -- connection -------------------------------------------------------------------------
    def _module(self) -> Any:
        if self._mt5 is None:
            self._mt5 = _import_mt5()
        return self._mt5

    def _connect_locked(self) -> None:
        mt5 = self._module()
        tries = [self.terminal_path] if self.terminal_path else [None] + candidate_terminals()
        first_error = None
        ok = False
        for path in tries:
            ok = mt5.initialize(path) if path else mt5.initialize()
            if ok:
                self.terminal_path_used = path
                break
            first_error = first_error if first_error is not None else mt5.last_error()
            try:
                mt5.shutdown()
            except Exception:
                pass
        if not ok:
            tried = f" Tried: {', '.join(p or 'the running terminal' for p in tries)}." if len(tries) > 1 else ""
            raise FeedError(explain_init_error(first_error) + tried)
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
                "balance": float(info.balance),
                "equity": float(info.equity),
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

    def quotes(self, symbols: list[str]) -> dict:
        """Latest bid/ask for any broker symbols (related markets: DXY, US10Y, oil, indices, silver).

        Real MT5 data only. Each symbol answers on its own: a symbol the broker does not have comes back
        with ok=False and a reason, never with a made-up price. prevClose is the previous completed D1
        close when MT5 provides it, so the app can show a real % change.
        """
        wanted: list[str] = []
        for s in symbols:
            s = s.strip()
            if not s:
                continue
            if not _SYMBOL_OK.match(s):
                raise ValueError(f"Invalid symbol name '{s}'")
            if s not in wanted:
                wanted.append(s)
        if not wanted:
            raise ValueError("No symbols given")
        if len(wanted) > MAX_QUOTE_SYMBOLS:
            raise ValueError(f"At most {MAX_QUOTE_SYMBOLS} symbols per request")
        self.ensure_connected()
        out = []
        with self._lock:
            mt5 = self._module()
            for name in wanted:
                if mt5.symbol_info(name) is None:
                    out.append({"symbol": name, "ok": False, "error": f"Symbol '{name}' not found on this broker. Use Find symbols in Settings."})
                    continue
                # Adds the symbol to Market Watch (needed for MT5 to stream a tick for it).
                if not mt5.symbol_select(name, True):
                    out.append({"symbol": name, "ok": False, "error": f"Could not add '{name}' to Market Watch: {mt5.last_error()}"})
                    continue
                t = mt5.symbol_info_tick(name)
                if t is None or (t.bid == 0 and t.ask == 0):
                    out.append({"symbol": name, "ok": False, "error": f"No tick for '{name}' (market closed or no data subscription)."})
                    continue
                tms = getattr(t, "time_msc", 0)
                prev = None
                try:
                    rates = mt5.copy_rates_from_pos(name, getattr(mt5, "TIMEFRAME_D1"), 0, 2)
                    if rates is not None and len(rates) == 2:
                        prev = float(rates[0]["close"])
                except Exception:  # prevClose is optional; its absence must not hide a good quote
                    prev = None
                out.append({
                    "symbol": name,
                    "ok": True,
                    "bid": float(t.bid),
                    "ask": float(t.ask),
                    "time": tms / 1000.0 if tms else float(t.time),
                    "prevClose": prev,
                    "error": None,
                })
        return {"quotes": out}
