# Aurum — Product Profile (v0.1, working name)

AI-controlled XAUUSD trading workspace. Pehle personal use, phir SaaS.
Visual tokens: `design/tokens.json`, preview: `design/brand-board.html`, logo: `design/logo.svg`.

## 1. Positioning
- **Kya hai:** chart + AI + MT5 ek jagah. AI chart padhta hai, levels banata/edit karta hai, alerts lagata hai, aur (permission ke saath) trades manage karta hai.
- **Kis ke liye:** discretionary gold traders jo apne broker ke feed par kaam karte hain.
- **Brand personality:** calm, precise, professional. Terminal jaisa, casino jaisa nahi. Bright colours sirf buy/sell ke liye.
- **Naam:** "Aurum" sirf working name hai (trademark check nahi hua). SaaS se pehle naam, domain aur trademark verify karna hoga.
- **Claims:** "guaranteed profit" ya fixed accuracy % kabhi nahi. "Not financial advice" disclaimer aur risk warnings product ka hissa hain.

## 2. Design system
| Cheez | Faisla |
|---|---|
| Theme | Dark charcoal default, light theme tokens ke saath |
| Colour roles | Gold = brand + manual objects + primary button. Blue = AI-created objects/AI badge. Green/red = sirf buy/sell, candles. Orange = warning/stale feed |
| Accessibility | Saare text tokens WCAG 2.2 AA pass (text-muted 4.8:1, baqi 5.7–14.8:1 dark panel par). Colour ke saath icon/label bhi, sirf colour par nirbhar nahi |
| Typography | Inter (UI), JetBrains Mono tabular numerals (prices, lots, tickets) |
| Spacing/radius | 4px grid. Radius 4 chip, 6 control, 10 panel, 14 modal |
| Layout | Top bar 40px, left toolbar 44px, centre chart, right AI chat 320–560px resizable, bottom collapsible panel. Chart ko maximum space |
| Density | Compact by default (trading screens), comfortable option |
| Motion | 120–180ms, `prefers-reduced-motion` ka ehtram |
| Logo | Teen candles, beech wali gold ("Au" signal). 16px tak readable, monochrome version bhi |
| i18n | English + Roman Urdu/Urdu (RTL-ready layout), ISO 8601 aur UTC internally, user timezone display |
| Standards | WCAG 2.2 AA, keyboard-first (command palette `Ctrl+K`), OWASP ASVS, GDPR-ready data export/delete |

**Functional design rules**
1. Har object par origin badge: manual ya AI.
2. Har AI change preview ho sakta hai aur undoable ho.
3. Feed ki halat hamesha nazar aaye: feed name, bid/ask, spread, last-tick age, stale warning.
4. Trade actions ka rang aur tarteeb alag ho (confirm dialog mein lot, price, SL/TP, estimated risk saaf likha ho).

## 3. Architecture — sab kuch connector
Core UI-agnostic rahega (`packages/core`), taake desktop se SaaS tak ja sake.

```
UI (React)  ──►  Command bus (undo/redo, audit log, origin)  ◄──  AI orchestrator
                      │                                              │
                      ▼                                              ▼
              Connector registry  ◄── manifest + permissions ──►  Tool catalog (Zod schemas)
   ┌───────────┬───────────┬──────────┬───────────┬─────────────┬─────────────┐
 Market data  Broker      News /     Sentiment   Sessions /    Messaging     LLM providers
 (MT5, API)   (MT5)       Calendar   Indexes     Clock         (WhatsApp)    (adapter)
```

**Connector manifest** (har connector ke liye): `id`, `kind`, `capabilities`, `requiredSecrets`, `permissions`, `rateLimits`, `healthCheck`, `tools[]`. Secrets OS credential store mein; connector sirf apni capabilities dekhta hai. Naya connector = naya module, core change nahi.

**Connector kinds aur pehle candidates**
| Kind | Examples (provider final karne se pehle licence/pricing verify) |
|---|---|
| Market data + broker | MT5 bridge (Python sidecar, Windows) |
| Indexes/DXY/yields/oil | provider API ya MT5 symbols (DXY, US10Y jo broker de) |
| News + economic calendar | koi licensed news/calendar API |
| Forex sentiment | broker/third-party positioning feeds |
| Market sessions/clock | local, koi API nahi (Sydney/Tokyo/London/NY, holidays) |
| Messaging | WhatsApp Agent Platform (section 5) |
| LLM | Anthropic, OpenAI, Google Gemini, DeepSeek, local (Ollama) |

**LLM adapter:** ek normalized interface `chat(messages, tools) → text | toolCalls`. DeepSeek OpenAI-compatible hai, isliye OpenAI adapter ka config variant. Provider per task chuna ja sake (sasta model alerts summary ke liye, bara model analysis ke liye). Har request mein model, data timestamp aur token cost log.

**AI control:** AI sirf registered tools call kare, har call Zod se validate, command bus se guzre. Permission modes: Read only → Suggest → Chart control → Monitoring → Execution. Execution alag toggle, limits ke saath (max lot, daily loss, sirf XAUUSD).

## 4. MT5 (EA ke baghair)
Official `MetaTrader5` Python package chalte terminal se baat karta hai: candles, ticks, positions, SL/TP modify, close, partial close (opposite deal, kam volume). Terminal Windows par khula, broker mein logged-in aur Algo Trading on hona chahiye. Pehle demo account.

## 5. WhatsApp Agent Platform — PDF se nikli hui cheezein
Source: `WhatsApp Agent Platform — Developer manual v1 (Aug 25, 2026)`.

| PDF ki baat | Product par asar |
|---|---|
| Agent sirf apne **creator** ko message kar sakta hai (403 / 131005) | Ye personal channel hai. Customers ko broadcast ya support bot nahi ban sakta. SaaS mein **har customer apna agent bana kar token deta hai** (BYO agent) |
| Receive = long-poll `GET /updates`, 15 polls/min, naya poll purane ko replace karta hai (409) | **Ek hi poller** per agent (desktop app ya server, dono nahi). Webhook nahi hai |
| Updates 30 din tak retain, `offset` se replay | App band thi to wapas on hone par backlog milega. **Backlog ke trade commands kabhi execute nahi honge**: message age limit (jaise 60s) aur handled-id dedupe |
| Send limit 12/min, text 4096 chars, concurrent sends ordering guarantee nahi | Outbound queue, chat-per-recipient serial sends, lambi analysis split ya document ke taur par |
| Image 5 MB (jpeg/png), document 16 MB, voice notes `audio/ogg` Opus | Chart screenshot bhej sakte hain. Voice note aaye to transcribe kar ke command banao |
| Identifier `user:<id>` opaque aur badal sakta hai | Identifier ko conversation key maano, user record ka primary key nahi |
| Read receipt + typing indicator (25s) | AI soch rahi ho to typing dikhao |
| Error codes (131009, 131016, 429...) | Retry policy: 429/503 backoff, 500 par duplicate ka risk — trade se related message dobara na bhejo |

**WhatsApp par trading safety (ye default hai):**
- WhatsApp se default **read-only**: price, analysis, alerts, position status.
- Trade action (close/partial/SL-TP) ka request aaye to app preview bheje aur ek **one-time code** maange (`CONFIRM 4821`, 2 min validity). Reaction emoji ya "yes" kaafi nahi.
- Allow-list: sirf creator ka account (platform ye khud enforce karta hai), phir bhi app mein alag toggle.
- Token OS secure storage mein, kabhi chat ya log mein nahi.

### 5b. WhatsApp ko proper Gateway banana
WhatsApp ek **Gateway connector** hoga (`kind: messaging`), jo do kaam karta hai: notifications out, AI chat in/out. Desktop UI aur WhatsApp ek hi AI orchestrator aur ek hi command bus use karte hain, is liye dono jagah same tools, same permissions, same undo/audit.

```
WhatsApp  ⇄  Gateway (poller + sender queue)  ⇄  Session router  ⇄  AI orchestrator ⇄ tools
                                  ▲                                     ▲
                      Notification router  ◄── alerts / setup triggers / position events
```

**1. Notifications (out)**
- Events: alert hit, setup triggered/invalidated, SL/TP hit, partial booked, feed disconnected/stale, session open (London/NY), high-impact news ka reminder, daily summary.
- Har event type par priority, quiet hours, aur per-event on/off. Duplicate ya flood se bachne ke liye throttling (platform limit 12 msgs/min, is liye critical pehle, baqi batch mein).
- Rich message: text + chart screenshot (PNG, 5 MB tak) + chhota "entry/SL/TP/RR" summary.

**2. AI chat (in/out)**
- Aap WhatsApp par likhein: "gold ka H1 analysis do", "mere open trades ka status", "NY session tak alert lagao". Message AI orchestrator ko jata hai, jawab text ya chart image ke taur par wapas.
- Voice note (`audio/ogg`) aaye to transcribe ho kar command bane.
- Aap ki bheji image (screenshot) AI ko supporting context mile.
- WhatsApp conversation ka alag session context, lekin chart state aur drawings desktop wale hi.
- Lambe jawab 4096 chars par split, ya PDF/document ke taur par.

**3. Slash-style shortcuts** (AI ke baghair, fast, sasta): `/price`, `/positions`, `/alerts`, `/pause`, `/status`.

**4. Permission levels WhatsApp par**
| Level | Kya ho sakta hai |
|---|---|
| Notify only | Sirf alerts aayen |
| Ask AI (default) | AI analysis, price, status, alert/level suggestions |
| Chart control | AI drawings/alerts bana sakti hai (undoable) |
| Trade actions | SL/TP modify, close, partial, sirf one-time code `CONFIRM 4821` ke baad, 2 min validity, aur desktop par bhi log |

**5. Reliability**
- Single poller (409 se bachne ke liye), `next_offset` SQLite mein save.
- App restart par backlog padhna lekin purane messages par jawab ya trade action nahi (age limit + handled-id dedupe). Backlog ka sirf summary: "app band thi, ye 3 messages aaye the".
- App band ho to WhatsApp gateway bhi band. 24/7 ke liye baad mein always-on server.
- Outbound queue per recipient serial, retry/backoff PDF ke mutabiq. Trade-related message ka 500 par blind retry nahi.

**Limit jo yaad rakhni hai:** platform agent ko sirf apne creator se baat karne deta hai, is liye ye aap ka personal gateway hai. SaaS mein har customer apna agent aur token connect karega.

## 6. SaaS ke liye abhi se rakhne wali baatein
- **MT5 local hai.** SaaS mein ya to customer ke PC par chalne wala chhota "bridge agent" install hoga jo cloud se secure connection banaye, ya har tenant ke liye Windows VPS. Ye bara architecture faisla hai, abhi sirf design mein jagah rakhi hai.
- **Storage abstraction:** SQLite abhi, baad mein Postgres. Tenant ID har table mein shuru se.
- **API keys:** BYOK (customer apni LLM key) pehle, managed keys baad mein.
- **Data licensing:** broker/vendor ka data resell ya redistribute nahi ho sakta, har provider ki shartein SaaS se pehle check karni hongi. Chart library ka licence (Lightweight Charts attribution) bhi.
- **Regulation:** trade execution aur "signals" kai mulkon mein regulated hain. SaaS se pehle legal advice zaroori hai. Is liye product tool hai, advice nahi.
- **Security/compliance:** Electron isolation, restricted IPC, audit log, export/delete, baad mein SOC 2 jaisi roadmap.
- **Licence/plans:** Free (read-only AI), Pro (chart control, alerts), Trader (execution + WhatsApp). Pricing baad mein.

## 7. Revised phases
1. Foundation: Electron shell, design tokens, layout, SQLite, simulated feed, command bus.
2. Manual tools + undo/redo + saved workspaces.
3. LLM adapter (Anthropic pehle, phir OpenAI/Gemini/DeepSeek) + read-only AI.
4. AI chart control + preview/apply + action log.
5. MT5 bridge: feed, positions, SL/TP, close, partial (demo).
6. Connector SDK + sessions/news/calendar/sentiment/indexes.
7. WhatsApp connector (alerts out, status/analysis in, confirmed actions).
8. Setups/rules engine, journal, replay, paper trading, installer.
9. SaaS foundations (multi-tenant, bridge agent, billing).

## 8. Abhi ke open faisle
1. Naam: "Aurum" theek hai ya aur options chahiye?
2. News/sentiment/calendar ke liye koi paid provider already hai? (warna pehle free/sample adapters)
3. Broker ka naam aur XAUUSD symbol (`XAUUSD`, `XAUUSDm`, `GOLD`).
