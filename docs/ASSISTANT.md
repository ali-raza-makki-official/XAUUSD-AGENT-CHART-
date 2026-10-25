# Trade Assistant (plans and management, in pips)

Everything is measured in **pips** (1 pip = 0.10 in price on gold, so 50 pips = 5.00). Stops, targets, breakeven, trailing and partials are set in pips, never dollars. Lot size comes from your risk % and the stop in pips.

## What it does
1. **Plans.** A plan says: BUY or SELL, wait for price to reach a zone, stop X pips, target Y pips, risk Z%. You create it in the Plans tab, or the AI proposes one (`propose_trade_plan`, needs Settings > AI > "Trade plans"). Nothing happens until **you approve that plan**: in the app, or by replying 1 / 2 on WhatsApp (WhatsApp level "Trade actions").
2. **At the zone.** When price reaches the zone:
   - *Ask me* (default): a dialog in the app and a WhatsApp message ask "Take the trade?" with the plan in pips. Answer 1 to take it, 2 to skip. Whichever you answer first wins.
   - *Place it automatically*: chosen when you approve that plan. The assistant places the order itself, once.
   - *Pending limit*: the pending order is placed at the zone edge as soon as you approve.
3. **Management of open trades** (Settings > Trading > Assistant, "Manage my open gold trades automatically"): breakeven (+ cushion), trailing stop in steps, one partial close. Each action is announced in pips on the desktop and WhatsApp.
4. **Pips everywhere.** Positions tab shows floating pips and the stop/target in pips (stop shown as "risk N" or "locked +N"); `/positions` on WhatsApp and the AI's `get_positions` do the same.

## Safety
- Master switch **off by default**. Demo accounts only. Trading must be enabled. "Stop AI" pauses it.
- Every order goes through the same OrderEngine and RiskGate as a manual order (spread, risk per trade, open risk, daily limit, max positions, SL required, idempotent command id, never resent when the result is unknown).
- The gate's `rule` actor can only: open an order that belongs to a plan you approved; move a stop toward profit (never back, never remove it, never touch the take profit); partially close or close. It cannot cancel orders, bulk close, or widen risk.
- A plan expires (default 24 h), is stopped if price slices through the zone, and fills at most once.
- No AI call is made while watching: the checks are arithmetic on live ticks. The AI proposes; you approve.

## Not verified
Tested in a real Electron run against a fake EA, and with unit tests. Not run against a real broker. Check on a demo account: place a plan with a far zone first, let price reach it with a small risk %, and watch that breakeven moves the stop in MT5 exactly as announced.
