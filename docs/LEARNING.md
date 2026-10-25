# Learning, paper trading and memory

What Aurum does with your history, and what it does not do.

**It does not** retrain any AI model (Anthropic, OpenAI, Gemini and DeepSeek models are not fine-tuned from your data) and it does not rewrite its own code. "Learning" here means: measuring results on real prices, remembering what you told it, and suggesting better defaults from evidence.

## Tick recorder
Every changed bid/ask is stored locally (table `ticks`, about 24 bytes each, purged after `retentionDays`, default 90). Settings > Trading > Learning.

## Paper trades
Every trade plan (approved or not), every AI analysis that carries a `tradeIdea`, and every idea you add in the Learning tab becomes a paper trade. It is judged on the recorded ticks: entry on the ask/bid, exit on the opposite side (spread is paid), stop wins a tie. Live trades are marked "Traded", the rest "Paper only", so you can see what would have happened if you had taken it.

## Findings and tuning
Findings (win rate and pips per trade by side, session, source...) start at 8 finished trades. The default stop/target suggestion replays the stored ticks of finished trades over a grid of stops and targets, picks the best on the older 70% and checks it on the newer 30%. It is called confident only with 30+ trades and a clear win on the unseen 30%. With **Auto tune** on it may change only the *default* stop/target for new plans; risk limits are never touched, each change is logged and can be undone in the Learning tab.

## Memory
With **Remember my chats and notes** on, every chat turn (app and WhatsApp) is archived locally. The AI can `remember` short notes, `recall_memory` by keywords across all days, and read `get_learning_stats`. A short digest (your notes plus measured findings, at most about 1200 characters) is added to each AI request, so it is sent to your AI provider. Turn memory off to stop saving and sharing. "Forget everything" deletes notes and the chat archive; paper trades and ticks are market data and stay.

## System health
The Health tab audits market data, trading, AI, WhatsApp, connectors and learning in one list, with the fix for each problem.
