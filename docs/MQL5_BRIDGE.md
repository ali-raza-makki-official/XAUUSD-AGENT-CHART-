# AurumBridge.mq5: optional EA bridge

`bridge/mql5/AurumBridge.mq5` is an Expert Advisor modelled on the "Arbitrage Bridge" example: it runs inside MT5, connects out to
a loopback WebSocket server and streams data / executes commands. It is an ALTERNATIVE to the Python bridge, not a replacement.

## Status: read this first
- The EA file is written, **never compiled and never run**. There is no MetaEditor in the build environment. Expect to fix a compiler
  message or two on first compile, then test on a DEMO account.
- **The Aurum side is not built.** The app does not yet contain the WebSocket hub (server on `HubPort`), the token pairing UI, or a
  "feed provider" switch between the Python bridge and the EA. Until that exists, the EA has nothing to talk to.
- The Python bridge (`bridge/aurum_bridge`) stays the default and is what has been tested.

## Why have it
| | Python bridge (today) | EA bridge |
|---|---|---|
| Python on the PC | needed (or the frozen exe) | not needed |
| Ticks | polled every 500 ms | pushed on every tick |
| Needs an EA on a chart + Algo Trading on | no | yes |
| Candle history, spec, deals, order lookup | yes | yes (same data, see protocol) |

## Safety defaults in the EA
- `EnableTrading=false`: it only streams data until you switch it on.
- Live accounts refused unless `AllowLive=true` (leave it false).
- Orders only on `AllowedSymbol` (default `GOLD`). A stop loss is required unless `AllowNoStopLoss=true`.
- Idempotent orders: the command id is hashed into the order comment (`AU:` + 24 hex = 27 chars, MT5 limit is 31). Before sending, the
  EA looks for that tag in positions, pending orders and the last 2 days of deals, and reports the earlier result instead of
  sending again. The same magic number as the Python bridge (`1096041045`) is used.
- Results are `done`, `rejected` or `unknown`. A timeout or no answer is `unknown`: nothing is retried; Aurum must look it up with `find`.
- Partial close rounds the volume DOWN to the broker step and refuses if the remainder would be below the minimum.
- `modify` keeps the existing SL/TP when a field is absent (it never silently removes a stop loss).

## Protocol v1 (JSON text frames, loopback, token auth)
EA to Aurum:
- `register` {protocol, instance_id, token, broker_company, server, account_number, currency, demo, build, trading_enabled}; Aurum answers `{"action":"registered","ok":true|false,"error":"..."}`.
- `ticks` {t:[[symbol,bid,ask,time_msc],...]}, `account` {balance,equity,margin,free_margin,currency,demo}, `positions` {list:[{ticket,time,symbol,type,volume,priceOpen,priceCurrent,sl,tp,swap,profit,magic,comment}]}.
- Replies carry the request's `req_id`: `candles` {data:[[time,o,h,l,c,tick_volume],...]}, `spec`, `symbols`, `deals`, `find` {found,where,ticket}, `order_result` {status,retcode,message,ticket,price,volume,duplicate}.

Aurum to EA: `ping`, `subscribe` {symbols}, `candles` {req_id,symbol,tf,count<=5000}, `spec` {req_id,symbol}, `symbols` {req_id,q},
`deals` {req_id,since}, `find` {req_id,command_id}, `positions`, `open` {req_id,command_id,symbol,side,volume,sl,tp,deviation},
`modify` {req_id,ticket,sl?,tp?}, `close` {req_id,command_id,ticket,volume?}.

Times are the broker server clock (unix seconds), same as the Python bridge and the MT5 chart.

## What is left to make it usable
1. Compile the EA and fix compiler messages; test on a demo account with a throwaway WebSocket echo server first.
2. In `apps/desktop/src/main`: a loopback WebSocket hub (needs the `ws` package), a per-install token shown in Settings, and a
   `BrokerPort` / feed adapter that maps the messages above onto the same interfaces the Python bridge uses (`BridgeManager.http`,
   `OrderService` `bridgePort`). Keep one active provider at a time.
3. Settings switch "MT5 connection: Python bridge | EA bridge", the same risk gate and confirm dialogs (nothing changes there).
4. Real MT5 test: filling modes, retcodes, comment on closing deals, hedging vs netting.
