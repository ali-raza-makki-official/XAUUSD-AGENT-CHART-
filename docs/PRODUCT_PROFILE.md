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
| Icons | lucide-react (UI) + custom chart-tool icons, same 24px grid aur 1.75 stroke, taake ek family lage |
| Fonts | Inter aur JetBrains Mono app ke andar bundled (offline, install nahi karni parti) |
| Components | Button (primary/secondary/ghost/danger), IconButton + tooltip, Switch, Segmented, Chip, Section, EmptyState, Dialog |
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

## 7. Central command system (sab se zaroori)
Desktop chat, WhatsApp, aur future mobile/web, sab ek hi pipeline se guzrein. Trading logic sirf ek jagah hogi.

```
Command → identity/permission check → validation → risk engine → action → broker result → activity log
```
- Har command ki **unique `commandId` (idempotency key)**. Retry, double click ya WhatsApp ka duplicate message dobara execute nahi hoga, wahi purana result wapas milega.
- Har command mein: `origin` (desktop/whatsapp/ai/rule), `actor`, `createdAt`, `expiresAt`, `payload`, `status`.
- Expired command execute nahi hoti (trade ke liye chhota TTL).
- Sab commands activity log mein, aur replay/audit ke liye immutable.

## 8. AI ki boundaries (capability matrix)
"Totally AI controlled" ka matlab uncontrolled access nahi. Settings mein har capability alag allow/block hogi:

| Capability | Control |
|---|---|
| Chart read aur analysis | Allow / block |
| Drawings aur indicators edit | Allow / block |
| Alerts aur setups create | Allow / block |
| Orders place | Suggest / confirmation / automatic |
| SL/TP modify aur partial close | Alag permission |
| Bulk close | Alag permission |
| Connectors aur credentials | Protected settings (AI ko kabhi nahi milti, passcode ke baghair change nahi) |

**Emergency "Stop AI actions"** button hamesha visible (top bar). Ye sirf naye AI actions roke. Existing positions band karna alag, saaf label wala action ("Close all positions"), confirmation ke saath.

## 9. Broker state final authority hai
AI chat mein "order executed" tabhi likha jaye jab broker result verify ho chuka ho.

States: `requested` → `validation_failed` | `sent_to_broker` → `confirmed` | `rejected` | `unknown_reconcile`

- Connection tootne ya timeout par order **blindly dobara send nahi hoga**. Pehle positions, pending orders aur deal history check hogi (command par comment/magic number lagta hai taake match ho sake).
- `unknown_reconcile` mein naye orders us symbol par rukte hain jab tak reconciliation na ho.
- Periodic sync: MT5 mein hath se kiye gaye changes (manual close, SL move) app mein reflect hon, "external change" ke label ke saath.

## 10. XAUUSD risk engine (deterministic code, LLM nahi)
Lot size aur risk calculation sirf code karega. AI sirf result dekhta aur explain karta hai.
- Inputs: account currency, broker contract spec (contract size, tick size/value, min/max/step volume), commission, spread, estimated slippage.
- Controls: per-trade max risk, total open risk, max daily loss (aur reset timezone), max spread, allowed slippage, max simultaneous positions, **missing-SL policy** (block / auto-suggest).
- **Demo/Live badge** bara aur hamesha visible, live par rang aur label alag.
- Daily limit hit: naye orders block. Existing positions ke liye alag policy (sirf manage/close allowed, ya freeze), settings mein define.
- Har order ke saath risk snapshot save ho (lot, risk %, SL distance, spread at entry).

## 11. Multi-timeframe workspace
- Layouts: single, two-chart, four-chart (H4/H1/M15/M5 linked).
- Synced crosshair, optional synced scrolling, higher-timeframe levels lower timeframe par dikhna.
- **Drawing layers**: manual aur AI alag, har layer show/hide/lock.
- Selected drawings **lock** ho sakein, AI unhein edit nahi karegi.
- Workspace autosave aur crash recovery (command log se rebuild).

## 12. AI analysis ka fixed card
Har analysis structured card, sirf lamba paragraph nahi:

| Field | Kya dikhaye |
|---|---|
| Data reference | Feed, timeframe, analysis ka time |
| Market structure | Bullish / bearish / ranging / unclear |
| Relevant levels | Level aur wajah |
| Scenario | Kis condition par setup valid |
| Invalidation | Kis condition par idea khatam |
| Missing information | Kya data available nahi |
| Actions | Chart par kya create/edit hua |

**"No setup" valid jawab hai.** AI ko har bar buy/sell idea dene par majboor nahi kiya jayega. Card ka schema Zod se validate hota hai, to desktop aur WhatsApp dono par same format.

## 13. Strategy builder aur version history
- Aap chat mein strategy samjhayen, AI usay editable rule JSON mein badle, **activation se pehle preview**.
- Har strategy ka **immutable version**. Purane trades/setups usi version se link rahen, baad ki edit historical performance nahi badalti.
- Replay/backtest mein **future candles AI ko nahi milte** (time-gated data access).
- Report mein spread, commission, slippage assumptions saaf likhe hon.
- Rule-based conditions code evaluate kare, AI sirf interpretation aur explanation.

## 14. Universal connector hub
Common contract har connector ke liye: `testConnection()`, `permissions`, `lastSuccessfulSync`, `errorStatus`, `rateLimit` handling, aur har data point ke saath `source` + `timestamp`.

| Category | Purpose |
|---|---|
| Broker | Prices, account, positions, orders |
| AI provider | Chat, vision, tool calling |
| News/calendar | Events, releases, news |
| Related markets | Indexes, yields, instruments |
| Sentiment | Source-specific sentiment |
| Messaging | WhatsApp, future channels |
| Export/storage | Reports, backups |

**"Koi bhi provider" ka matlab:** sirf base URL + API key se tools aur vision automatically kaam nahi karte. Is liye har provider ka **adapter** hoga jo capabilities declare kare (`tools`, `vision`, `streaming`, `json_mode`, context size), aur app unhi features ko enable kare jo adapter support karta ho. OpenAI-compatible providers (jaise DeepSeek) ke liye generic adapter, capability flags manual set ho sakte hain.

## 15. WhatsApp remote gateway (controls)
Section 5b ke upar ye controls:
- Verified account linking (app mein pairing code WhatsApp se bhej kar).
- Allowed numbers aur device/session management, session revoke.
- Read-only aur trading permissions alag.
- Sensitive action par short-lived confirmation code.
- Duplicate messages ignore (message id), expired commands reject.
- Delivery status aur command history UI mein.
- WhatsApp commands bhi section 7 ki central pipeline se guzarti hain, koi alag trading logic nahi.

**Availability ki haqiqat:** "sab kuch PC par" aur "WhatsApp hamesha available" ek saath guarantee nahi ho sakte. PC band ya app band to local agent jawab nahi dega (messages 30 din buffer rahenge, par expired trade commands execute nahi hongi). Hamesha-on ke liye future architecture:
`WhatsApp ⇄ cloud messaging gateway ⇄ secure connection ⇄ local desktop agent`.
Cloud gateway sirf message relay aur status cache kare, trade execution local agent par hi ho. Cloud LLM use karne par chunda hua context PC se bahar provider tak jata hai, ye settings mein clearly likha ho aur account details bhejne se pehle hata di jayen.

## 16. SaaS foundation (abhi sirf data model)
Data model mein shuru se: **User → Workspace → Broker account → Strategy (version) → Setup → Action**. Har table mein `workspaceId`.
Baad mein: tenant isolation, subscriptions/entitlements, AI usage aur spending limits, BYOK, device activation aur session revoke, data export/delete, DB migrations, signed application updates.
Abhi billing aur cloud platform **nahi** banana. Maqsad sirf ye ke personal version ko baad mein rewrite na karna pare.

## 17. UI/UX specification (colors se aage)
Design spec mein ye sab define hoga (`design/` mein component spec alag file mein):
- Typography scale, spacing, component states (default, hover, focus, active, disabled, loading, error).
- Keyboard shortcuts (command palette `Ctrl+K`, timeframe switch, tool select, undo/redo) aur **visible focus ring**.
- Screens: loading, empty, disconnected, stale-data, error, first-run onboarding.
- High-DPI aur multi-monitor (chart ko alag window mein pop-out).
- Resizable panels, chart labels jo har scale par parhne layak hon.
- Destructive actions ki saaf wording ("Close all 3 XAUUSD positions at market", "Cancel" default focus).
- Status sirf colour par nahi: icon + text bhi.

## 18. Revised phases
1. **Foundation:** Electron shell, tokens, layout, SQLite, data model (section 16), simulated feed, **central command bus** (idempotency, activity log).
2. **Manual workspace:** drawing tools, layers, lock, undo/redo, autosave/recovery, multi-timeframe layouts.
3. **AI read-only:** LLM adapter (capability flags), analysis card, data reference.
4. **AI chart control:** capability matrix, preview/apply, Stop AI button, action log.
5. **Risk engine + MT5 bridge (demo):** feed, positions, order state machine, reconciliation, SL/TP, partial, close.
6. **Connector hub:** common contract, sessions, news/calendar, indexes, sentiment.
7. **WhatsApp gateway:** notifications, AI chat, linking, confirmation codes, command history.
8. **Strategy builder, setups, alerts, journal, replay/backtest** (future-candle gating).
9. **Release:** Windows installer (CI), signed updates, backups, security review, live-account hardening.
10. **SaaS foundations** (cloud gateway, local agent link, entitlements) jab personal version stable ho.

## 19. Faisle ho chuke (user se)
| Sawal | Jawab | Asar |
|---|---|---|
| Naam | **Aurum** (working name, trademark baad mein check) | Branding ab isi par |
| Symbol | **`GOLD`** (broker ka naam abhi nahi bataya) | Symbol mapping config mein: app ka `XAUUSD` ↔ broker ka `GOLD`. Contract specs MT5 se padhi jayengi |
| News/sentiment provider | Abhi koi paid nahi, baad mein ho sakta hai | Phase 6 mein free/sample adapters, connector contract pehle se taake baad mein paid provider bina rewrite ke lag sake |
| Daily limit par existing positions | Trader 50 se 100 pips SL rakhta hai | **Manage-only** (neeche) |

### Daily loss limit policy (default)
Aap ke wide SL (50 se 100 pips) ki wajah se "freeze" ya limit hit par auto-close ghalat hoga: SL ko jaldi mein market par band karna aap ke trade plan ko tod deta hai.
- Limit hit hone par **naye orders block**, AI ke naye entries bhi block.
- Existing positions par **manage-only**: SL/TP move, partial close, close allowed. Auto-close kabhi nahi, jab tak aap alag se "force flat" option on na karein.
- SL ko position ka risk **barhane** wali taraf move karna (SL door karna) limit hit hone ke baad block.
- Limit mein sirf realised loss ginein ya floating bhi, ye setting ho (default: realised + open risk dono dikhayen, block realised + worst-case open risk par).
- Reset timezone aur reset time settings mein (default broker server time).

### Pips ki definition (gold par confusion se bachne ke liye)
Gold par "pip" brokers mein ek jaisa nahi. Aam taur par `GOLD` 2 decimals par hota hai (point = 0.01) aur 1 pip = 0.10, to 50 se 100 pips = **5 se 10 dollar** price move. App hamesha price distance aur pips dono dikhaye, aur pip size setting broker spec se auto-detect ho kar aap se confirm karwaye.

### Risk engine ka asar (examples broker spec se confirm honge)
Aam contract mein 1 lot = 100 oz, yani 1 lot par 1 dollar move = 100 dollar. To 5 se 10 dollar SL par 1 lot ka risk 500 se 1000 dollar banta hai. Isi liye lot hamesha risk % aur SL distance se nikalta hai (code), kabhi "andaze" se nahi, aur order se pehle dollar risk saaf dikhaya jata hai.

## 20. Abhi ke open faisle
1. Broker ka naam (symbol `GOLD` pata hai, broker nahi), aur account currency (USD?).
2. Per-trade max risk % aur daily loss limit ki default values (main conservative defaults rakh sakta hoon, aap baad mein badal lein).
3. Account type: pehle demo se shuru, theek?

## 21. Parity rule: har kaam manual bhi aur AI se bhi
Jo cheez aap haath se kar sakein, AI bhi wahi kar sake, aur jo AI kare aap usay dekh, badal aur undo kar sakein.
- Ek hi drawing model aur ek hi `DrawingStore`/command bus. Manual tool aur AI tool dono usi se guzarte hain.
- Har feature ke do raste: UI control aur AI tool (validated schema). Naya feature tab tak complete nahi jab dono maujood hon.
- AI ke paas data: candles, indicators, drawings, selected object, account/spec, aur (baad mein) news/sentiment/sessions connectors.
- Har setting customisable: tool defaults, har drawing ki style, timeframe visibility, fib levels, TP ladder, risk %.

## 22. Build status (kya bana hai, kya baqi)
| Hissa | Halat |
|---|---|
| Electron app, layout, tokens | Bana, asli Electron mein chala kar check kiya |
| MT5 bridge (candles, tick, account, symbol spec) | Bana. Asli MT5 par abhi test nahi hua (yahan Linux hai). Test-only stand-in se pipeline check hui |
| Drawing tools (10 kinds), inspector, objects/layers, undo/redo, SQLite save | Bana, e2e check hua (draw, select, undo, restart) |
| Risk maths (lots from risk %) | Bana, unit tests |
| AI tool layer + permissions | Bana, unit tests. LLM se abhi connected nahi |
| LLM provider adapters + chat | Baqi (agla) |
| Indicators, multi-timeframe layouts | Baqi |
| Alerts, schedules, notifications, WhatsApp gateway | Baqi |
| News/calendar/sentiment/sessions connectors | Baqi |
| Order placement, SL/TP modify, partial/close (MT5) | Baqi, risk engine aur state machine ke baad |
| Windows installer | Baqi |

