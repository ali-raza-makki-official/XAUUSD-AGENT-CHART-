# First run on Windows: what to check

Everything below was built and tested here against stand-ins (a fake EA, mock AI and WhatsApp servers). None of it has touched a real MT5 account, real AI provider or real WhatsApp yet. Work through this list on an Exness DEMO account before relying on any of it.

1. **EA**: recompile `bridge/mql5/AurumBridge.mq5` (new timeframes, safer candle requests). Attach it to a chart, paste HubPort and AuthToken. Set the broker symbol (Settings > General, "Find gold symbols"), e.g. `XAUUSDm`.
2. **Reconnect**: close MT5, open it again; close Aurum, open it again. Aurum should show "MT5 connected" by itself each time. Turn on Settings > General > "Start Aurum when I sign in to Windows" (installed app only).
3. **Timeframes**: the dropdown beside Indicators lists every MT5 period (M1 ... MN1) plus M13, M45 and Y1, which Aurum builds from real MT5 candles (M13 from M1, M45 from M15, Y1 from MN1; capped by how much history the EA can send).
3b. **Pending orders**: the EA (version 0.11) now places, lists, changes and cancels limit/stop orders. Compile it first (MetaEditor shows any error), then place a far-away pending order on the demo account from Positions > New pending order, and cancel it.
4. **AI**: Settings > AI. Pick provider and model, "Load models", "Test connection". The line under the model shows what it can read (images, PDFs, voice). Correct it there if the guess is wrong.
5. **Zones**: ask the AI for zones. Compare `find_zones` results (FVG, order blocks, liquidity) with your own chart. A zone is valid for 3 touches; the 4th ends it.
6. **Watching levels**: draw a zone with a label and a note, ask the AI to `watch` it. You get an "approaching" and a "reached" alert with your label, note and the zone's validity.
7. **Orders (demo only)**: Settings > Trading > enable. Place a small order from a Long/Short drawing. The review page shows the pre-trade checklist; failed items need a tick before Confirm. Follow `docs/ORDERS.md`.
8. **Journal**: after a few closed trades, Journal shows real statistics, behaviour flags, and which trades went ahead with a failed rule (only trades placed through Aurum have a checklist).
9. **WhatsApp**: link the chat, then try: a question, a photo, a PDF, a voice note, "show me the chart", and an action that needs confirming (reply 1 / 2). Voice needs an OpenAI or Gemini key. Check Urdu/Hindi voice notes yourself; transcription quality is not verified.
10. **Status messages**: close Aurum and look for the "closed" message; stop the EA for a minute and look for "MT5 connection lost" then "connected again". A crash or power cut cannot send anything.
11. **Morning briefing**: Settings > WhatsApp > Morning briefing (time and time zone). Only sent while Aurum is running at that time.
