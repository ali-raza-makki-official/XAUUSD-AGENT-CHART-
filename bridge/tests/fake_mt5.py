"""Test-only stand-in for the MetaTrader5 module with trading support. NEVER shipped, never a default.

It is a small broker simulator (positions, pending orders, deal history) with scripted faults, so the bridge's
retcode, timeout and "result unknown" paths can be exercised. It proves our logic, not MT5's real behaviour.
"""
from __future__ import annotations

import threading
from types import SimpleNamespace as NS
from typing import Any, Optional

FOK, IOC, RETURN = 0, 1, 2


class FakeMt5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    TRADE_ACTION_DEAL, TRADE_ACTION_PENDING, TRADE_ACTION_SLTP, TRADE_ACTION_MODIFY, TRADE_ACTION_REMOVE = 1, 5, 6, 7, 8
    ORDER_TYPE_BUY, ORDER_TYPE_SELL, ORDER_TYPE_BUY_LIMIT, ORDER_TYPE_SELL_LIMIT, ORDER_TYPE_BUY_STOP, ORDER_TYPE_SELL_STOP = 0, 1, 2, 3, 4, 5
    ORDER_FILLING_FOK, ORDER_FILLING_IOC, ORDER_FILLING_RETURN = FOK, IOC, RETURN
    ORDER_TIME_GTC, ORDER_TIME_SPECIFIED = 0, 2
    SYMBOL_TRADE_MODE_DISABLED, SYMBOL_TRADE_MODE_LONGONLY, SYMBOL_TRADE_MODE_SHORTONLY, SYMBOL_TRADE_MODE_CLOSEONLY, SYMBOL_TRADE_MODE_FULL = 0, 1, 2, 3, 4
    TIMEFRAME_M15 = 15

    def __init__(self, demo: bool = True, filling_mode: int = 2, trade_mode: int = 4, stops_level: int = 0, freeze_level: int = 0):
        self.demo = demo
        self.filling_mode, self.trade_mode, self.stops_level, self.freeze_level = filling_mode, trade_mode, stops_level, freeze_level
        self.volume_min, self.volume_max, self.volume_step = 0.01, 200.0, 0.01
        self.bid, self.ask, self.server_time = 2650.10, 2650.30, 1_700_000_000
        self.terminal_trade_allowed, self.account_trade_allowed = True, True
        self.positions: dict[int, NS] = {}
        self.orders: dict[int, NS] = {}
        self.deals: list[NS] = []
        self.hist_orders: list[NS] = []
        self._ticket = 1000
        self.send_calls: list[dict] = []
        self.check_calls: list[dict] = []
        self.send_script: list[tuple] = []   # ("result", retcode[, apply]) | ("none"[, apply]) | ("raise", exc[, apply]) | ("block", Event)
        self.check_script: list[int] = []
        self.query_fail: set[str] = set()    # "positions" | "orders" | "deals" | "history_orders": return None with an error
        self.no_money = False
        self._err = (1, "Success")

    # -- plumbing -----------------------------------------------------------------------------------
    def initialize(self, *a: Any) -> bool:
        return True

    def last_error(self) -> tuple:
        return self._err

    def terminal_info(self) -> NS:
        return NS(connected=True, trade_allowed=self.terminal_trade_allowed)

    def account_info(self) -> NS:
        return NS(login=123, server="Exness-MT5Trial", currency="USD", name="T", balance=10000.0, equity=10000.0,
                  trade_mode=0 if self.demo else 2, trade_allowed=self.account_trade_allowed)

    def symbol_info(self, s: str) -> Optional[NS]:
        if s != "GOLD":
            return None
        return NS(digits=2, point=0.01, trade_contract_size=100.0, trade_tick_size=0.01, trade_tick_value=1.0,
                  volume_min=self.volume_min, volume_max=self.volume_max, volume_step=self.volume_step,
                  filling_mode=self.filling_mode, trade_mode=self.trade_mode, trade_stops_level=self.stops_level,
                  trade_freeze_level=self.freeze_level)

    def symbol_select(self, s: str, v: bool) -> bool:
        return True

    def symbol_info_tick(self, s: str) -> NS:
        return NS(bid=self.bid, ask=self.ask, time=self.server_time, time_msc=self.server_time * 1000)

    def symbols_get(self) -> list:
        return [NS(name="GOLD")]

    # -- queries ------------------------------------------------------------------------------------
    def _q(self, key: str, rows: list) -> Optional[tuple]:
        if key in self.query_fail:
            self._err = (-2, "Terminal: Invalid params")
            return None
        self._err = (1, "Success")
        return tuple(rows)

    def positions_get(self, symbol: Optional[str] = None, ticket: Optional[int] = None) -> Optional[tuple]:
        rows = [p for p in self.positions.values() if (ticket is None or p.ticket == ticket)]
        return self._q("positions", rows)

    def orders_get(self, symbol: Optional[str] = None, ticket: Optional[int] = None) -> Optional[tuple]:
        rows = [o for o in self.orders.values() if (ticket is None or o.ticket == ticket)]
        return self._q("orders", rows)

    def history_deals_get(self, a: Any = None, b: Any = None, **kw: Any) -> Optional[tuple]:
        return self._q("deals", list(self.deals))

    def history_orders_get(self, a: Any = None, b: Any = None, **kw: Any) -> Optional[tuple]:
        return self._q("history_orders", list(self.hist_orders))

    # -- broker simulation ----------------------------------------------------------------------------
    def _next(self) -> int:
        self._ticket += 1
        return self._ticket

    def _filling_ok(self, f: Optional[int]) -> bool:
        if f is None:
            return True
        return {FOK: bool(self.filling_mode & 1), IOC: bool(self.filling_mode & 2), RETURN: True}[f]

    def order_check(self, req: dict) -> NS:
        self.check_calls.append(dict(req))
        if self.check_script:
            return NS(retcode=self.check_script.pop(0), comment="scripted", margin=1.0, margin_free=9999.0)
        if self.no_money and req.get("action") in (1, 5):
            return NS(retcode=10019, comment="No money", margin=1e9, margin_free=0.0)
        if not self._filling_ok(req.get("type_filling")):
            return NS(retcode=10030, comment="Unsupported filling mode", margin=0.0, margin_free=0.0)
        return NS(retcode=0, comment="Done", margin=100.0, margin_free=9900.0)

    def _apply(self, req: dict) -> NS:
        action = req["action"]
        if action == 1:
            if "position" in req:
                pos = self.positions[req["position"]]
                vol = req["volume"]
                self.deals.append(NS(ticket=self._next(), order=self._next(), time=self.server_time, type=req["type"], entry=1, position_id=pos.ticket,
                                     volume=vol, price=req["price"], commission=0.0, swap=0.0, profit=5.0, fee=0.0, reason=0,
                                     symbol="GOLD", magic=req.get("magic", 0), comment=req.get("comment", "")))
                if abs(pos.volume - vol) < 1e-9:
                    del self.positions[pos.ticket]
                else:
                    pos.volume = round(pos.volume - vol, 8)
                return NS(retcode=10009, deal=self._ticket - 1, order=self._ticket, volume=vol, price=req["price"], bid=self.bid, ask=self.ask, comment="Request executed", request_id=1)
            order_t, deal_t = self._next(), self._next()
            self.positions[order_t] = NS(ticket=order_t, time=self.server_time, type=req["type"], volume=req["volume"], price_open=req["price"],
                                         sl=req.get("sl", 0.0), tp=req.get("tp", 0.0), price_current=req["price"], swap=0.0, profit=0.0,
                                         symbol="GOLD", magic=req.get("magic", 0), comment=req.get("comment", ""))
            self.deals.append(NS(ticket=deal_t, order=order_t, time=self.server_time, type=req["type"], entry=0, position_id=order_t, volume=req["volume"],
                                 price=req["price"], commission=-0.5, swap=0.0, profit=0.0, fee=0.0, reason=0, symbol="GOLD",
                                 magic=req.get("magic", 0), comment=req.get("comment", "")))
            return NS(retcode=10009, deal=deal_t, order=order_t, volume=req["volume"], price=req["price"], bid=self.bid, ask=self.ask, comment="Request executed", request_id=1)
        if action == 6:
            pos = self.positions[req["position"]]
            pos.sl, pos.tp = req["sl"], req["tp"]
            return NS(retcode=10009, deal=0, order=0, volume=0.0, price=0.0, bid=self.bid, ask=self.ask, comment="Request executed", request_id=2)
        if action == 5:
            t = self._next()
            self.orders[t] = NS(ticket=t, time_setup=self.server_time, type=req["type"], volume_current=req["volume"], volume_initial=req["volume"],
                                price_open=req["price"], sl=req.get("sl", 0.0), tp=req.get("tp", 0.0), price_current=self.ask, state=1, symbol="GOLD",
                                magic=req.get("magic", 0), comment=req.get("comment", ""), time_expiration=req.get("expiration", 0), position_id=0)
            return NS(retcode=10009, deal=0, order=t, volume=req["volume"], price=req["price"], bid=self.bid, ask=self.ask, comment="Request executed", request_id=3)
        if action == 7:
            o = self.orders[req["order"]]
            o.sl, o.tp = req["sl"], req["tp"]
            return NS(retcode=10009, deal=0, order=o.ticket, volume=o.volume_current, price=o.price_open, bid=self.bid, ask=self.ask, comment="Request executed", request_id=4)
        if action == 8:
            o = self.orders.pop(req["order"])
            self.hist_orders.append(NS(**{**o.__dict__, "state": 2, "comment": req.get("comment", o.comment)}))
            return NS(retcode=10009, deal=0, order=o.ticket, volume=0.0, price=0.0, bid=self.bid, ask=self.ask, comment="Request executed", request_id=5)
        raise AssertionError(f"unsupported action {action}")

    def order_send(self, req: dict) -> Optional[NS]:
        self.send_calls.append(dict(req))
        if self.send_script:
            step = self.send_script.pop(0)
            kind, apply = step[0], (step[-1] is True)
            if kind == "block":
                step[1].wait(30)
                return self._apply(req)
            if kind == "raise":
                if apply:
                    self._apply(req)
                raise step[1]
            if kind == "none":
                if apply:
                    self._apply(req)
                return None
            if kind == "result":
                if apply:
                    self._apply(req)
                return NS(retcode=step[1], deal=0, order=0, volume=0.0, price=0.0, bid=self.bid, ask=self.ask, comment=f"scripted {step[1]}", request_id=9)
        if not self._filling_ok(req.get("type_filling")):
            return NS(retcode=10030, deal=0, order=0, volume=0.0, price=0.0, bid=0.0, ask=0.0, comment="Unsupported filling mode", request_id=0)
        return self._apply(req)

    # helpers for tests
    def add_position(self, side: str = "buy", volume: float = 0.10, price: float = 2640.0, sl: float = 2630.0, tp: float = 0.0, magic: int = 0, comment: str = "") -> int:
        t = self._next()
        self.positions[t] = NS(ticket=t, time=self.server_time, type=0 if side == "buy" else 1, volume=volume, price_open=price, sl=sl, tp=tp,
                               price_current=self.bid, swap=0.0, profit=0.0, symbol="GOLD", magic=magic, comment=comment)
        return t

    def add_order(self, otype: int = 2, volume: float = 0.1, price: float = 2600.0, sl: float = 0.0, tp: float = 0.0) -> int:
        t = self._next()
        self.orders[t] = NS(ticket=t, time_setup=self.server_time, type=otype, volume_current=volume, volume_initial=volume, price_open=price, sl=sl, tp=tp,
                            price_current=self.ask, state=1, symbol="GOLD", magic=0, comment="", time_expiration=0, position_id=0)
        return t


def blocker() -> threading.Event:
    return threading.Event()
