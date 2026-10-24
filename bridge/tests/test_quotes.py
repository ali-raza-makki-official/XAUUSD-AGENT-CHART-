"""Related-market quotes. Uses the test-only fake MT5 module; the product never ships fake data."""
import json
import threading
import unittest
import urllib.error
import urllib.request
from types import SimpleNamespace as NS

from aurum_bridge.mt5_feed import Mt5Feed
from aurum_bridge.server import serve
from tests.test_mt5_feed import FakeMt5


class FakeMarkets(FakeMt5):
    """GOLD plus a few broker symbols. DXY has history; USOIL has a tick but no daily history; US500 has no tick."""

    TIMEFRAME_D1 = 16408
    TICKS = {
        "GOLD": NS(bid=2650.10, ask=2650.30, time=1_700_000_000, time_msc=1_700_000_000_500),
        "DXY": NS(bid=104.0, ask=104.2, time=1_700_000_100, time_msc=0),
        "USOIL": NS(bid=71.5, ask=71.55, time=1_700_000_200, time_msc=1_700_000_200_250),
        "US500": NS(bid=0, ask=0, time=0, time_msc=0),
    }

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.selected = []

    def symbol_info(self, s):
        return NS(digits=2, point=0.01, trade_contract_size=100.0, trade_tick_size=0.01, trade_tick_value=1.0,
                  volume_min=0.01, volume_max=200.0, volume_step=0.01) if s in self.TICKS else None

    def symbol_select(self, s, v):
        self.selected.append(s)
        return s != "NOSELECT"

    def symbol_info_tick(self, s):
        return self.TICKS.get(s)

    def copy_rates_from_pos(self, s, tf, pos, n):
        if tf == self.TIMEFRAME_D1:
            if s == "DXY":
                return [{"time": 1, "close": 103.0}, {"time": 2, "close": 104.1}]
            if s == "USOIL":
                raise RuntimeError("history not synced")
            return None
        return super().copy_rates_from_pos(s, tf, pos, n)


class QuotesTest(unittest.TestCase):
    def feed(self):
        return Mt5Feed("GOLD", mt5_module=FakeMarkets())

    def test_each_symbol_answers_on_its_own(self):
        q = {x["symbol"]: x for x in self.feed().quotes(["DXY", "USOIL", "US500", "NOPE"])["quotes"]}
        self.assertEqual((q["DXY"]["ok"], q["DXY"]["bid"], q["DXY"]["ask"], q["DXY"]["prevClose"]), (True, 104.0, 104.2, 103.0))
        self.assertEqual(q["DXY"]["time"], 1_700_000_100.0)
        self.assertTrue(q["USOIL"]["ok"])
        self.assertIsNone(q["USOIL"]["prevClose"])  # missing history must not hide a good quote
        self.assertEqual(q["USOIL"]["time"], 1_700_000_200.25)
        self.assertFalse(q["US500"]["ok"])
        self.assertIn("No tick", q["US500"]["error"])
        self.assertFalse(q["NOPE"]["ok"])
        self.assertIn("not found", q["NOPE"]["error"])
        self.assertNotIn("bid", q["NOPE"])  # a failed symbol carries no price at all

    def test_adds_symbols_to_market_watch_and_dedupes(self):
        m = FakeMarkets()
        out = Mt5Feed("GOLD", mt5_module=m).quotes(["DXY", " DXY ", ""])
        self.assertEqual(len(out["quotes"]), 1)
        self.assertIn("DXY", m.selected)

    def test_validates_input(self):
        f = self.feed()
        with self.assertRaises(ValueError):
            f.quotes([])
        with self.assertRaises(ValueError):
            f.quotes(["BAD SYMBOL;rm"])
        with self.assertRaises(ValueError):
            f.quotes([f"S{i}" for i in range(13)])

    def test_requires_a_real_terminal(self):
        from aurum_bridge.mt5_feed import FeedError
        with self.assertRaises(FeedError):
            Mt5Feed("GOLD", mt5_module=FakeMarkets(init_ok=False)).quotes(["DXY"])

    def test_http_endpoint_needs_token_and_returns_quotes(self):
        srv = serve(self.feed(), "tok", 0)
        port = srv.server_address[1]
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            def get(path, token="tok"):
                req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"X-Aurum-Token": token})
                try:
                    with urllib.request.urlopen(req, timeout=5) as r:
                        return r.status, json.loads(r.read())
                except urllib.error.HTTPError as e:
                    return e.code, json.loads(e.read())

            status, body = get("/quotes?symbols=DXY,USOIL")
            self.assertEqual(status, 200)
            self.assertEqual([x["symbol"] for x in body["quotes"]], ["DXY", "USOIL"])
            self.assertEqual(get("/quotes?symbols=DXY", token="wrong")[0], 401)
            self.assertEqual(get("/quotes")[0], 400)
            self.assertEqual(get("/quotes?symbols=a%20b")[0], 400)
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
