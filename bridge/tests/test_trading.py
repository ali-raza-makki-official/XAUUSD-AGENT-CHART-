"""Trading tests run against a stand-in MT5 (tests/fake_mt5.py). They prove the bridge's decisions, not MT5 itself."""
import json
import threading
import unittest
import urllib.error
import urllib.request

from aurum_bridge.mt5_feed import Mt5Feed
from aurum_bridge.server import serve
from aurum_bridge.trading import (AURUM_MAGIC, MAX_COMMENT, RETCODES, Mt5Trader, TradeError, command_tag, retcode_info, volume_is_valid)
from tests.fake_mt5 import FakeMt5

CID = "cmd-0000000001"


def make(fake=None, enabled=True, allow_live=False, **kw):
    fake = fake or FakeMt5()
    feed = Mt5Feed("GOLD", mt5_module=fake)
    return fake, Mt5Trader(feed, enabled=enabled, allow_live=allow_live, **kw)


def buy(**over):
    return {"commandId": CID, "side": "buy", "volume": 0.10, "sl": 2640.0, "tp": 2670.0, "deviationPoints": 30, **over}


class TagTest(unittest.TestCase):
    def test_tag_is_short_deterministic_and_collision_safe(self):
        self.assertEqual(command_tag("x" * 80), command_tag("x" * 80))
        self.assertLessEqual(len(command_tag("a-very-long-command-id-" * 3)), MAX_COMMENT)
        tags = {command_tag(f"cmd-{i:012d}") for i in range(20000)}
        self.assertEqual(len(tags), 20000)
        self.assertTrue(command_tag(CID).startswith("AU:"))

    def test_magic_is_the_documented_constant(self):
        self.assertEqual(AURUM_MAGIC, 1096041045)  # "AURU"; the TypeScript core asserts the same literal


class GateTest(unittest.TestCase):
    def test_disabled_by_default_refuses_everything_and_never_sends(self):
        fake, tr = make(enabled=False)
        with self.assertRaises(TradeError) as cm:
            tr.execute("open_market", buy())
        self.assertEqual((cm.exception.status, cm.exception.code), (403, "trading_disabled"))
        self.assertEqual(fake.send_calls, [])
        self.assertEqual(fake.check_calls, [])

    def test_default_trader_is_disabled(self):
        feed = Mt5Feed("GOLD", mt5_module=FakeMt5())
        self.assertFalse(Mt5Trader(feed).enabled)

    def test_live_account_refused_without_second_flag(self):
        fake, tr = make(FakeMt5(demo=False), enabled=True, allow_live=False)
        with self.assertRaises(TradeError) as cm:
            tr.execute("open_market", buy())
        self.assertEqual((cm.exception.status, cm.exception.code), (403, "live_refused"))
        self.assertEqual(fake.send_calls, [])

    def test_live_account_allowed_with_both_flags(self):
        fake, tr = make(FakeMt5(demo=False), enabled=True, allow_live=True)
        self.assertEqual(tr.execute("open_market", buy())["status"], "done")

    def test_allow_live_alone_does_not_enable_trading(self):
        fake, tr = make(FakeMt5(demo=False), enabled=False, allow_live=True)
        with self.assertRaises(TradeError):
            tr.execute("open_market", buy())

    def test_account_is_rechecked_on_every_request(self):
        fake, tr = make()
        self.assertEqual(tr.execute("open_market", buy())["status"], "done")
        fake.demo = False  # the owner logs into a live account in the terminal
        with self.assertRaises(TradeError) as cm:
            tr.execute("open_market", buy(commandId="cmd-0000000002"))
        self.assertEqual(cm.exception.code, "live_refused")

    def test_algo_trading_off_and_account_trade_disabled(self):
        fake, tr = make()
        fake.terminal_trade_allowed = False
        with self.assertRaises(TradeError) as cm:
            tr.execute("open_market", buy())
        self.assertEqual(cm.exception.code, "algo_trading_off")
        fake.terminal_trade_allowed, fake.account_trade_allowed = True, False
        with self.assertRaises(TradeError) as cm:
            tr.execute("open_market", buy())
        self.assertEqual(cm.exception.code, "account_trade_disabled")

    def test_other_symbol_refused(self):
        _, tr = make()
        with self.assertRaises(TradeError) as cm:
            tr.execute("open_market", buy(symbol="EURUSD"))
        self.assertEqual(cm.exception.code, "symbol_not_allowed")

    def test_command_id_required_and_unknown_action(self):
        _, tr = make()
        with self.assertRaises(TradeError):
            tr.execute("open_market", {"side": "buy", "volume": 0.1})
        with self.assertRaises(TradeError) as cm:
            tr.execute("transfer_funds", buy())
        self.assertEqual(cm.exception.status, 404)

    def test_status_reports_reason(self):
        _, tr = make(enabled=False)
        st = tr.status()
        self.assertFalse(st["canTrade"])
        self.assertIn("disabled", st["reason"])
        _, tr = make(FakeMt5(demo=False))
        self.assertIn("LIVE", tr.status()["reason"])
        _, tr = make()
        self.assertTrue(tr.status()["canTrade"])


class RetcodeTest(unittest.TestCase):
    def test_every_retcode_on_send_maps_to_a_clear_status(self):
        for code, (name, message, kind) in RETCODES.items():
            if code == 10030:
                continue  # covered in FillingTest: it is retried with the next filling mode, by design
            with self.subTest(code=code):
                fake, tr = make()
                fake.send_script = [("result", code)]
                out = tr.execute("open_market", buy())
                self.assertEqual(out["retcode"], code)
                self.assertEqual(out["retcodeName"], name)
                self.assertEqual(out["message"], message)
                self.assertEqual(out["status"], kind)
                self.assertTrue(out["message"])
                self.assertEqual(len(fake.send_calls), 1, "no automatic retry on any retcode")

    def test_every_order_check_failure_blocks_the_send(self):
        for code, (name, _m, _k) in RETCODES.items():
            if code in (10008, 10009, 10025, 10030):
                continue
            with self.subTest(code=code):
                fake, tr = make()
                fake.check_script = [code]
                out = tr.execute("open_market", buy())
                self.assertEqual(out["status"], "rejected")
                self.assertEqual(out["stage"], "check")
                self.assertEqual(out["retcodeName"], name)
                self.assertEqual(fake.send_calls, [])

    def test_unknown_retcode_is_rejected_with_the_number(self):
        fake, tr = make()
        fake.send_script = [("result", 99999)]
        out = tr.execute("open_market", buy())
        self.assertEqual((out["status"], out["retcodeName"]), ("rejected", "RETCODE_99999"))

    def test_partial_fill_is_reported_as_partial(self):
        fake, tr = make()
        fake.send_script = [("result", 10010, True)]
        self.assertEqual(tr.execute("open_market", buy())["status"], "partial")

    def test_no_money_message(self):
        fake, tr = make()
        fake.no_money = True
        out = tr.execute("open_market", buy())
        self.assertEqual((out["status"], out["retcodeName"]), ("rejected", "NO_MONEY"))
        self.assertIn("margin", out["message"])
        self.assertEqual(fake.send_calls, [])

    def test_retcode_info_none_is_unknown(self):
        self.assertEqual(retcode_info(None)[2], "unknown")


class UnknownResultTest(unittest.TestCase):
    def assert_unknown_single_send(self, script, name):
        fake, tr = make()
        fake.send_script = [script]
        out = tr.execute("open_market", buy())
        self.assertEqual(out["status"], "unknown")
        self.assertEqual(out["retcodeName"], name)
        self.assertEqual(len(fake.send_calls), 1)
        # the same command id again must NOT be sent a second time
        again = tr.execute("open_market", buy())
        self.assertEqual(again["status"], "unknown")
        self.assertTrue(again["duplicate"])
        self.assertEqual(len(fake.send_calls), 1)
        return fake, tr

    def test_none_result(self):
        self.assert_unknown_single_send(("none",), "NO_RESULT")

    def test_exception(self):
        self.assert_unknown_single_send(("raise", ConnectionError("pipe broke")), "SEND_EXCEPTION")

    def test_timeout_retcode(self):
        self.assert_unknown_single_send(("result", 10012), "TIMEOUT")

    def test_connection_retcode(self):
        self.assert_unknown_single_send(("result", 10031), "CONNECTION")

    def test_applied_then_timeout_is_found_by_comment_and_never_resent(self):
        fake, tr = self.assert_unknown_single_send(("none", True), "NO_RESULT")
        ev = tr.evidence(CID)
        self.assertEqual(len(ev["positions"]), 1)
        self.assertEqual(ev["positions"][0]["magic"], AURUM_MAGIC)
        self.assertEqual(len(ev["deals"]), 1)
        self.assertEqual(ev["deals"][0]["entry"], "in")

    def test_not_applied_then_timeout_leaves_no_trace(self):
        fake, tr = self.assert_unknown_single_send(("none", False), "NO_RESULT")
        ev = tr.evidence(CID)
        self.assertEqual((ev["positions"], ev["orders"], ev["deals"]), ([], [], []))
        self.assertTrue(all(ev["queried"].values()))

    def test_duplicate_guard_after_bridge_restart_does_not_resend(self):
        fake, tr = make()
        fake.send_script = [("none", True)]
        tr.execute("open_market", buy())
        _, tr2 = make(fake)  # new process: its in-memory result cache is empty
        out = tr2.execute("open_market", buy())
        self.assertEqual((out["status"], out["stage"]), ("done", "duplicate_guard"))
        self.assertEqual(len(fake.send_calls), 1)
        self.assertEqual(len(fake.positions), 1)

    def test_real_timeout_blocks_further_trading_until_mt5_answers(self):
        fake, tr = make(send_timeout=0.15)
        gate = threading.Event()
        fake.send_script = [("block", gate)]
        out = tr.execute("open_market", buy())
        self.assertEqual((out["status"], out["retcodeName"]), ("unknown", "SEND_TIMEOUT"))
        with self.assertRaises(TradeError) as cm:
            tr.execute("open_market", buy(commandId="cmd-0000000002"))
        self.assertEqual(cm.exception.code, "send_pending")
        gate.set()
        tr._pending_send.join(2)
        # MT5 answered; now the evidence shows the order WAS executed, found by comment
        self.assertEqual(len(tr.evidence(CID)["positions"]), 1)
        self.assertEqual(tr.execute("open_market", buy(commandId="cmd-0000000002"))["status"], "done")

    def test_history_query_failure_is_an_error_not_an_empty_answer(self):
        fake, tr = make()
        fake.query_fail = {"deals"}
        with self.assertRaises(TradeError) as cm:
            tr.evidence(CID)
        self.assertEqual(cm.exception.status, 503)
        with self.assertRaises(TradeError):  # an open refuses to send when it cannot check for a previous attempt
            tr.execute("open_market", buy())
        self.assertEqual(fake.send_calls, [])


class FillingTest(unittest.TestCase):
    def test_uses_symbol_flags(self):
        for flags, expected in ((2, FakeMt5.ORDER_FILLING_IOC), (1, FakeMt5.ORDER_FILLING_FOK), (0, FakeMt5.ORDER_FILLING_RETURN)):
            with self.subTest(flags=flags):
                fake, tr = make(FakeMt5(filling_mode=flags))
                self.assertEqual(tr.execute("open_market", buy())["status"], "done")
                self.assertEqual(fake.send_calls[0]["type_filling"], expected)

    def test_prefers_ioc_then_fok(self):
        fake, tr = make(FakeMt5(filling_mode=3))
        tr.execute("open_market", buy())
        self.assertEqual(fake.send_calls[0]["type_filling"], FakeMt5.ORDER_FILLING_IOC)

    def test_check_invalid_fill_tries_next_mode_without_sending(self):
        fake, tr = make(FakeMt5(filling_mode=3))
        fake.check_script = [10030, 0]
        out = tr.execute("open_market", buy())
        self.assertEqual(out["status"], "done")
        self.assertEqual(len(fake.check_calls), 2)
        self.assertEqual(len(fake.send_calls), 1)
        self.assertEqual(fake.send_calls[0]["type_filling"], FakeMt5.ORDER_FILLING_FOK)

    def test_send_invalid_fill_retries_next_mode_because_nothing_executed(self):
        fake, tr = make(FakeMt5(filling_mode=3))
        fake.send_script = [("result", 10030)]
        out = tr.execute("open_market", buy())
        self.assertEqual(out["status"], "done")
        self.assertEqual(len(fake.send_calls), 2)
        self.assertEqual(len(fake.positions), 1)

    def test_all_modes_invalid_is_rejected(self):
        fake, tr = make()
        fake.check_script = [10030, 10030, 10030]
        out = tr.execute("open_market", buy())
        self.assertEqual((out["status"], out["retcodeName"]), ("rejected", "INVALID_FILL"))
        self.assertEqual(fake.send_calls, [])

    def test_pending_prefers_return(self):
        fake, tr = make(FakeMt5(filling_mode=3))
        tr.execute("open_pending", {"commandId": CID, "orderType": "buy_limit", "price": 2600.0, "volume": 0.1})
        self.assertEqual(fake.send_calls[0]["type_filling"], FakeMt5.ORDER_FILLING_RETURN)


class OpenTest(unittest.TestCase):
    def test_market_buy_request_shape(self):
        fake, tr = make()
        out = tr.execute("open_market", buy())
        req = fake.send_calls[0]
        self.assertEqual(req["action"], 1)
        self.assertEqual((req["type"], req["price"]), (0, 2650.30))  # buy at ask
        self.assertEqual((req["magic"], req["comment"]), (AURUM_MAGIC, command_tag(CID)))
        self.assertEqual((req["sl"], req["tp"], req["deviation"], req["volume"]), (2640.0, 2670.0, 30, 0.10))
        self.assertEqual(out["status"], "done")
        self.assertEqual(out["positionTicket"], out["order"])
        self.assertTrue(out["deal"])

    def test_market_sell_uses_bid(self):
        fake, tr = make()
        tr.execute("open_market", {"commandId": CID, "side": "sell", "volume": 0.1, "sl": 2660.0})
        self.assertEqual(fake.send_calls[0]["price"], 2650.10)
        self.assertEqual(fake.send_calls[0]["type"], 1)

    def test_volume_rules(self):
        for bad in (0.0, 0.005, 0.015, 201, float("nan"), float("inf"), "0.1", None, True):
            with self.subTest(volume=bad):
                fake, tr = make()
                with self.assertRaises(TradeError) as cm:
                    tr.execute("open_market", buy(volume=bad))
                self.assertEqual(cm.exception.code, "invalid_volume")
                self.assertEqual(fake.send_calls, [])

    def test_volume_helper_accepts_valid_steps(self):
        for v in (0.01, 0.07, 0.1, 1.0, 12.34):
            self.assertIsNone(volume_is_valid(v, 0.01, 200.0, 0.01), v)
        self.assertIsNotNone(volume_is_valid(0.15, 0.1, 5.0, 0.1))
        self.assertIsNone(volume_is_valid(0.2, 0.1, 5.0, 0.1))

    def test_stops_level_and_wrong_side(self):
        fake, tr = make(FakeMt5(stops_level=50))  # 0.50 price units
        with self.assertRaises(TradeError) as cm:
            tr.execute("open_market", buy(sl=2650.0))  # only 0.10 below bid
        self.assertEqual(cm.exception.code, "invalid_sl")
        with self.assertRaises(TradeError) as cm:
            tr.execute("open_market", buy(sl=2640.0, tp=2650.3))
        self.assertEqual(cm.exception.code, "invalid_tp")
        with self.assertRaises(TradeError):
            tr.execute("open_market", buy(sl=2700.0))  # SL above a buy
        self.assertEqual(fake.send_calls, [])
        self.assertEqual(tr.execute("open_market", buy(sl=2649.0, tp=2652.0))["status"], "done")

    def test_symbol_trade_modes(self):
        for mode, side, code in ((0, "buy", "symbol_trading_disabled"), (3, "buy", "close_only"), (1, "sell", "long_only"), (2, "buy", "short_only")):
            with self.subTest(mode=mode):
                _, tr = make(FakeMt5(trade_mode=mode))
                with self.assertRaises(TradeError) as cm:
                    tr.execute("open_market", {"commandId": CID, "side": side, "volume": 0.1})
                self.assertEqual(cm.exception.code, code)

    def test_no_valid_quote_refuses(self):
        fake, tr = make()
        fake.bid = fake.ask = 0.0
        with self.assertRaises(TradeError) as cm:
            tr.execute("open_market", buy())
        self.assertEqual(cm.exception.code, "no_quotes")

    def test_deviation_bounds(self):
        _, tr = make()
        for bad in (-1, 5000, "x"):
            with self.assertRaises(TradeError):
                tr.execute("open_market", buy(deviationPoints=bad))

    def test_pending_price_side_rules(self):
        _, tr = make()
        cases = {"buy_limit": 2700.0, "buy_stop": 2600.0, "sell_limit": 2600.0, "sell_stop": 2700.0}
        for otype, price in cases.items():
            with self.subTest(otype=otype), self.assertRaises(TradeError) as cm:
                tr.execute("open_pending", {"commandId": CID, "orderType": otype, "price": price, "volume": 0.1})
            self.assertEqual(cm.exception.code, "invalid_price")
        good = {"buy_limit": 2600.0, "buy_stop": 2700.0, "sell_limit": 2700.0, "sell_stop": 2600.0}
        for i, (otype, price) in enumerate(good.items()):
            fake, tr = make()
            out = tr.execute("open_pending", {"commandId": f"cmd-pending-{i:04d}", "orderType": otype, "price": price, "volume": 0.1})
            self.assertEqual(out["status"], "done", otype)
            self.assertEqual(fake.send_calls[0]["action"], 5)
            self.assertEqual(len(fake.orders), 1)

    def test_pending_with_expiration_and_bad_type(self):
        fake, tr = make()
        tr.execute("open_pending", {"commandId": CID, "orderType": "buy_limit", "price": 2600.0, "volume": 0.1, "expiration": 1_700_100_000})
        self.assertEqual(fake.send_calls[0]["type_time"], 2)
        self.assertEqual(fake.send_calls[0]["expiration"], 1_700_100_000)
        with self.assertRaises(TradeError):
            tr.execute("open_pending", {"commandId": "cmd-0000000009", "orderType": "buy_stop_limit", "price": 2600.0, "volume": 0.1})


class ModifyTest(unittest.TestCase):
    def test_sl_only_keeps_existing_tp(self):
        fake, tr = make()
        t = fake.add_position("buy", 0.1, 2640.0, sl=2630.0, tp=2670.0)
        out = tr.execute("modify_sltp", {"commandId": CID, "ticket": t, "sl": 2641.0})
        self.assertEqual(out["status"], "done")
        req = fake.send_calls[0]
        self.assertEqual((req["action"], req["position"], req["sl"], req["tp"]), (6, t, 2641.0, 2670.0))
        self.assertEqual(fake.positions[t].tp, 2670.0)

    def test_null_removes_a_level(self):
        fake, tr = make()
        t = fake.add_position("buy", 0.1, 2640.0, sl=2630.0, tp=2670.0)
        tr.execute("modify_sltp", {"commandId": CID, "ticket": t, "tp": None})
        self.assertEqual((fake.positions[t].sl, fake.positions[t].tp), (2630.0, 0.0))

    def test_unchanged_values_are_a_noop_without_sending(self):
        fake, tr = make()
        t = fake.add_position("buy", 0.1, 2640.0, sl=2630.0, tp=2670.0)
        out = tr.execute("modify_sltp", {"commandId": CID, "ticket": t, "sl": 2630.0, "tp": 2670.0})
        self.assertEqual((out["status"], out["retcodeName"]), ("done", "NO_CHANGES"))
        self.assertEqual(fake.send_calls, [])

    def test_wrong_side_and_stops_level(self):
        fake, tr = make(FakeMt5(stops_level=100))
        t = fake.add_position("buy", 0.1, 2640.0, sl=2630.0)
        with self.assertRaises(TradeError) as cm:
            tr.execute("modify_sltp", {"commandId": CID, "ticket": t, "sl": 2650.0})  # 0.10 below bid, level is 1.00
        self.assertEqual(cm.exception.code, "invalid_sl")
        s = fake.add_position("sell", 0.1, 2660.0, sl=2670.0)
        with self.assertRaises(TradeError):
            tr.execute("modify_sltp", {"commandId": "cmd-0000000002", "ticket": s, "sl": 2640.0})

    def test_freeze_level_blocks_modification(self):
        fake, tr = make(FakeMt5(freeze_level=500))  # 5.00
        t = fake.add_position("buy", 0.1, 2640.0, sl=2647.0)  # SL only 3.10 below bid
        with self.assertRaises(TradeError) as cm:
            tr.execute("modify_sltp", {"commandId": CID, "ticket": t, "sl": 2648.0})
        self.assertEqual(cm.exception.code, "freeze_level")
        self.assertEqual(fake.send_calls, [])

    def test_missing_position_is_404(self):
        _, tr = make()
        with self.assertRaises(TradeError) as cm:
            tr.execute("modify_sltp", {"commandId": CID, "ticket": 999, "sl": 1.0})
        self.assertEqual((cm.exception.status, cm.exception.code), (404, "position_not_found"))

    def test_modify_pending_order(self):
        fake, tr = make()
        o = fake.add_order(2, 0.1, 2600.0)
        out = tr.execute("modify_sltp", {"commandId": CID, "ticket": o, "ticketKind": "order", "sl": 2590.0, "tp": 2630.0})
        self.assertEqual(out["status"], "done")
        self.assertEqual((fake.send_calls[0]["action"], fake.send_calls[0]["order"], fake.send_calls[0]["price"]), (7, o, 2600.0))
        self.assertEqual(fake.orders[o].sl, 2590.0)


class CloseTest(unittest.TestCase):
    def test_full_close_is_opposite_deal_referencing_the_position(self):
        fake, tr = make()
        t = fake.add_position("buy", 0.30, 2640.0)
        out = tr.execute("close_position", {"commandId": CID, "ticket": t, "deviationPoints": 25})
        req = fake.send_calls[0]
        self.assertEqual((req["action"], req["type"], req["position"], req["volume"], req["price"]), (1, 1, t, 0.30, 2650.10))
        self.assertEqual((req["magic"], req["comment"]), (AURUM_MAGIC, command_tag(CID)))
        self.assertEqual(out["status"], "done")
        self.assertNotIn(t, fake.positions)

    def test_close_short_buys_at_ask(self):
        fake, tr = make()
        t = fake.add_position("sell", 0.2, 2660.0, sl=2670.0)
        tr.execute("close_position", {"commandId": CID, "ticket": t})
        self.assertEqual((fake.send_calls[0]["type"], fake.send_calls[0]["price"]), (0, 2650.30))

    def test_partial_close_reduces_volume_and_keeps_position(self):
        fake, tr = make()
        t = fake.add_position("buy", 0.30, 2640.0)
        out = tr.execute("partial_close", {"commandId": CID, "ticket": t, "volume": 0.10})
        self.assertEqual(out["status"], "done")
        self.assertAlmostEqual(fake.positions[t].volume, 0.20)
        self.assertEqual(out["volumeBefore"], 0.30)

    def test_partial_close_volume_rules(self):
        fake, tr = make()
        t = fake.add_position("buy", 0.30, 2640.0)
        for bad, why in ((0.30, "equal"), (0.5, "above"), (0.015, "step"), (0.0, "zero"), (-0.1, "negative")):
            with self.subTest(why=why), self.assertRaises(TradeError) as cm:
                tr.execute("partial_close", {"commandId": f"cmd-{why:>10}", "ticket": t, "volume": bad})
            self.assertEqual(cm.exception.code, "invalid_volume")
        self.assertEqual(fake.send_calls, [])

    def test_partial_close_must_not_leave_dust_below_minimum(self):
        fake, tr = make(FakeMt5())
        fake.volume_min, fake.volume_step = 0.10, 0.01
        t = fake.add_position("buy", 0.15, 2640.0)
        with self.assertRaises(TradeError) as cm:
            tr.execute("partial_close", {"commandId": CID, "ticket": t, "volume": 0.10})  # leaves 0.05 < min 0.10
        self.assertIn("below the broker minimum", cm.exception.message)

    def test_close_position_rejects_a_smaller_volume(self):
        fake, tr = make()
        t = fake.add_position("buy", 0.30, 2640.0)
        with self.assertRaises(TradeError):
            tr.execute("close_position", {"commandId": CID, "ticket": t, "volume": 0.1})

    def test_close_missing_position_never_sends(self):
        fake, tr = make()
        with self.assertRaises(TradeError) as cm:
            tr.execute("close_position", {"commandId": CID, "ticket": 5})
        self.assertEqual(cm.exception.code, "position_not_found")

    def test_closing_is_allowed_in_close_only_mode_but_not_when_disabled(self):
        fake, tr = make(FakeMt5(trade_mode=3))
        t = fake.add_position("buy", 0.1, 2640.0)
        self.assertEqual(tr.execute("close_position", {"commandId": CID, "ticket": t})["status"], "done")
        fake2, tr2 = make(FakeMt5(trade_mode=0))
        t2 = fake2.add_position("buy", 0.1, 2640.0)
        with self.assertRaises(TradeError):
            tr2.execute("close_position", {"commandId": CID, "ticket": t2})

    def test_close_timeout_applied_is_found_via_tagged_deal(self):
        fake, tr = make()
        t = fake.add_position("buy", 0.30, 2640.0)
        fake.send_script = [("none", True)]
        out = tr.execute("partial_close", {"commandId": CID, "ticket": t, "volume": 0.10})
        self.assertEqual(out["status"], "unknown")
        ev = tr.evidence(CID, ticket=t)
        self.assertEqual([d["entry"] for d in ev["deals"]], ["out"])
        self.assertAlmostEqual(ev["target"]["position"]["volume"], 0.20)
        _, tr2 = make(fake)
        again = tr2.execute("partial_close", {"commandId": CID, "ticket": t, "volume": 0.10})
        self.assertEqual(again["stage"], "duplicate_guard")
        self.assertEqual(len(fake.send_calls), 1)

    def test_cancel_pending(self):
        fake, tr = make()
        o = fake.add_order()
        out = tr.execute("cancel_pending", {"commandId": CID, "ticket": o})
        self.assertEqual(out["status"], "done")
        self.assertEqual((fake.send_calls[0]["action"], fake.send_calls[0]["order"]), (8, o))
        self.assertEqual(fake.check_calls, [])
        with self.assertRaises(TradeError):
            tr.execute("cancel_pending", {"commandId": "cmd-0000000002", "ticket": o})


class ReadTest(unittest.TestCase):
    def test_positions_orders_deals(self):
        fake, tr = make()
        fake.add_position("buy", 0.1, 2640.0, sl=2630.0, magic=7, comment="manual")
        fake.add_order()
        tr.execute("open_market", buy())
        pos = tr.positions()
        self.assertEqual(len(pos), 2)
        self.assertEqual({p["magic"] for p in pos}, {7, AURUM_MAGIC})
        self.assertIsNone(pos[0]["tp"])
        self.assertEqual(tr.orders()[0]["type"], "buy_limit")
        self.assertEqual(len(tr.deals()["deals"]), 1)

    def test_none_with_error_raises_none_with_success_is_empty(self):
        fake, tr = make()
        fake.query_fail = {"positions"}
        with self.assertRaises(TradeError):
            tr.positions()
        fake.query_fail = set()
        self.assertEqual(tr.positions(), [])


class HttpTest(unittest.TestCase):
    TOKEN = "t" * 16

    def start(self, **kw):
        fake, tr = make(**kw)
        httpd = serve(tr.feed, self.TOKEN, 0, False, tr)
        th = threading.Thread(target=httpd.serve_forever, daemon=True)
        th.start()
        self.addCleanup(lambda: (httpd.shutdown(), httpd.server_close()))
        return fake, httpd.server_address[1]

    def call(self, port, path, body=None, token=None, headers=None):
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method="POST" if data is not None else "GET")
        req.add_header("X-Aurum-Token", self.TOKEN if token is None else token)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_post_requires_token(self):
        _, port = self.start()
        status, body = self.call(port, "/trade/open_market", buy(), token="wrong")
        self.assertEqual(status, 401)
        self.assertFalse(body["sent"])

    def test_disabled_bridge_answers_403_and_sent_false(self):
        fake, port = self.start(enabled=False)
        status, body = self.call(port, "/trade/open_market", buy())
        self.assertEqual((status, body["code"], body["sent"]), (403, "trading_disabled", False))
        self.assertEqual(fake.send_calls, [])

    def test_live_refused_over_http(self):
        fake = FakeMt5(demo=False)
        feed = Mt5Feed("GOLD", mt5_module=fake)
        httpd = serve(feed, self.TOKEN, 0, False, Mt5Trader(feed, enabled=True))
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (httpd.shutdown(), httpd.server_close()))
        status, body = self.call(httpd.server_address[1], "/trade/open_market", buy())
        self.assertEqual((status, body["code"]), (403, "live_refused"))

    def test_happy_path_and_unknown_over_http(self):
        fake, port = self.start()
        status, body = self.call(port, "/trade/open_market", buy())
        self.assertEqual((status, body["status"]), (200, "done"))
        fake.send_script = [("none", True)]
        status, body = self.call(port, "/trade/open_market", buy(commandId="cmd-0000000002"))
        self.assertEqual((status, body["status"]), (200, "unknown"))
        status, ev = self.call(port, "/trade/find?commandId=cmd-0000000002")
        self.assertEqual((status, len(ev["positions"])), (200, 1))
        status, pos = self.call(port, "/positions")
        self.assertEqual(len(pos["positions"]), 2)

    def test_bad_bodies(self):
        _, port = self.start()
        self.assertEqual(self.call(port, "/trade/open_market", b"not json")[0], 400)
        self.assertEqual(self.call(port, "/trade/open_market", b"[1,2]")[0], 400)
        self.assertEqual(self.call(port, "/trade/open_market", b"x" * 20000)[0], 400)
        self.assertEqual(self.call(port, "/trade/nope", {"a": 1})[0], 404)
        status, body = self.call(port, "/trade/open_market", {"commandId": CID, "side": "up", "volume": 0.1})
        self.assertEqual((status, body["sent"]), (400, False))

    def test_bad_host_header_refused(self):
        _, port = self.start()
        status, _ = self.call(port, "/positions", headers={"Host": "evil.example.com"})
        self.assertEqual(status, 403)
        status, _ = self.call(port, "/trade/open_market", buy(), headers={"Host": "evil.example.com"})
        self.assertEqual(status, 403)

    def test_status_endpoint(self):
        _, port = self.start(enabled=False)
        status, body = self.call(port, "/trade/status")
        self.assertEqual((status, body["enabled"], body["canTrade"]), (200, False, False))


if __name__ == "__main__":
    unittest.main()
