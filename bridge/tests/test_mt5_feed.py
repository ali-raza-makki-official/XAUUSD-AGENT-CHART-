"""Tests use a stand-in for the MetaTrader5 module (test-only). The product never ships fake data."""
import unittest
from types import SimpleNamespace as NS

from aurum_bridge.mt5_feed import FeedError, Mt5Feed


class FakeMt5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    TIMEFRAME_M15 = 15

    def __init__(self, init_ok=True, symbol_ok=True, demo=True):
        self.init_ok, self.symbol_ok, self.demo = init_ok, symbol_ok, demo

    def initialize(self, *a):
        return self.init_ok

    def last_error(self):
        return (1, "fail")

    def terminal_info(self):
        return NS(connected=True)

    def account_info(self):
        return NS(login=123, server="Exness-MT5Trial", currency="USD", name="T", trade_mode=0 if self.demo else 2)

    def symbol_info(self, s):
        return NS(digits=2, point=0.01, trade_contract_size=100.0, trade_tick_size=0.01,
                  trade_tick_value=1.0, volume_min=0.01, volume_max=200.0, volume_step=0.01) if self.symbol_ok else None

    def symbol_select(self, s, v):
        return True

    def symbol_info_tick(self, s):
        return NS(bid=2650.10, ask=2650.30, time=1_700_000_000, time_msc=1_700_000_000_500)

    def copy_rates_from_pos(self, s, tf, pos, n):
        return [{"time": 1000 + i * 900, "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "tick_volume": 7} for i in range(n)]

    def symbols_get(self):
        return [NS(name="GOLD"), NS(name="EURUSD"), NS(name="XAUUSDm")]


class Mt5FeedTest(unittest.TestCase):
    def test_tick_and_spread(self):
        t = Mt5Feed("GOLD", mt5_module=FakeMt5()).tick()
        self.assertEqual(t["time"], 1_700_000_000.5)
        self.assertAlmostEqual(t["spread"], 0.2)

    def test_candles_clamped_and_shaped(self):
        c = Mt5Feed("GOLD", mt5_module=FakeMt5()).candles("M15", 3)
        self.assertEqual(len(c["candles"]), 3)
        self.assertEqual(c["candles"][0]["volume"], 7.0)

    def test_demo_flag(self):
        self.assertTrue(Mt5Feed("GOLD", mt5_module=FakeMt5(demo=True)).account()["demo"])
        self.assertFalse(Mt5Feed("GOLD", mt5_module=FakeMt5(demo=False)).account()["demo"])

    def test_unknown_symbol_is_a_clear_error(self):
        with self.assertRaises(FeedError) as cm:
            Mt5Feed("NOPE", mt5_module=FakeMt5(symbol_ok=False)).tick()
        self.assertIn("not found", str(cm.exception))

    def test_terminal_not_running_is_reported_not_faked(self):
        feed = Mt5Feed("GOLD", mt5_module=FakeMt5(init_ok=False))
        self.assertFalse(feed.health()["connected"])
        self.assertIn("Cannot attach", feed.health()["error"])

    def test_bad_timeframe_rejected(self):
        with self.assertRaises(ValueError):
            Mt5Feed("GOLD", mt5_module=FakeMt5()).candles("M7", 1)

    def test_find_symbols(self):
        self.assertEqual(Mt5Feed("GOLD", mt5_module=FakeMt5()).find_symbols(["XAU", "GOLD"]), ["GOLD", "XAUUSDm"])


if __name__ == "__main__":
    unittest.main()
