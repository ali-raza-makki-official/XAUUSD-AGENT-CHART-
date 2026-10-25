//+------------------------------------------------------------------+
//|                                                AurumBridge.mq5   |
//|  Optional EA bridge between a MetaTrader 5 terminal and Aurum.   |
//|  Aurum is the WebSocket SERVER (loopback); this EA connects out. |
//|  Protocol: see docs/MQL5_BRIDGE.md. JSON text frames.            |
//|                                                                  |
//|  STATUS: written to match the Aurum Python bridge, NOT compiled  |
//|  or run anywhere yet (no MetaEditor in the build sandbox).       |
//|  Compile it, fix any compiler message, and test on a DEMO        |
//|  account before relying on it. The Python bridge remains the     |
//|  default and is the tested path.                                 |
//|                                                                  |
//|  SETUP (once per terminal)                                       |
//|   1. Copy to MQL5/Experts and compile in MetaEditor.             |
//|   2. Tools > Options > Expert Advisors: tick "Allow algorithmic  |
//|      trading" and "Allow WebRequest for listed URL"; add         |
//|      http://127.0.0.1 (needed for socket access).                |
//|   3. Attach to ANY chart and paste the token shown in Aurum.     |
//+------------------------------------------------------------------+
#property copyright "Aurum"
#property version   "0.11"
#property strict

#include <Trade\Trade.mqh>

#define PROTOCOL_VERSION 1
#define AURUM_MAGIC      1096041045   // same magic the Python bridge uses

input string HubHost         = "127.0.0.1";   // Aurum host (keep loopback)
input int    HubPort         = 8766;          // Aurum EA hub port (shown in Aurum)
input string InstanceId      = "mt5_01";      // unique per terminal [A-Za-z0-9_.-]
input string AuthToken       = "";            // token shown in Aurum
input int    TimerMs         = 5;             // quote poll period (ms)
input bool   EnableTrading   = false;         // OFF by default: the EA only streams data
input bool   AllowLive       = false;         // refuse trading on live accounts unless true
input string AllowedSymbol   = "GOLD";        // the only symbol orders may use ("" = any)
input bool   AllowNoStopLoss = false;         // refuse market orders without a stop loss
input int    DefaultDeviationPts = 30;        // max slippage (points) if Aurum sends none

CTrade   g_trade;
int      g_sock = INVALID_HANDLE;
bool     g_ready = false;
uchar    g_rx[];
string   g_symbols[];
double   g_lastBid[];
double   g_lastAsk[];
long     g_lastMsc[];
datetime g_nextReconnect = 0;
ulong    g_lastAccountMs = 0;
ulong    g_lastPosMs = 0;
string   g_posSig = "";

void HandleMessage(const string json);
void DoModifyOrder(const string rid, const string json, const ulong ticket);
void Disconnect(const string why);

//+------------------------------------------------------------------+
//| Helpers                                                          |
//+------------------------------------------------------------------+
string Esc(const string s)
  {
   string o = s;
   StringReplace(o, "\\", "\\\\");
   StringReplace(o, "\"", "\\\"");
   return o;
  }

string Num(const double v, const int digits) { return DoubleToString(v, digits); }

string JStr(const string json, const string key)
  {
   string pat = "\"" + key + "\":\"";
   int p = StringFind(json, pat);
   if(p < 0) return "";
   p += StringLen(pat);
   int q = p;
   while(q < StringLen(json))
     {
      ushort c = StringGetCharacter(json, q);
      if(c == '\\') { q += 2; continue; }
      if(c == '"') break;
      q++;
     }
   return StringSubstr(json, p, q - p);
  }

double JNum(const string json, const string key, const double dflt = 0.0)
  {
   string pat = "\"" + key + "\":";
   int p = StringFind(json, pat);
   if(p < 0) return dflt;
   p += StringLen(pat);
   if(StringGetCharacter(json, p) == '"') p++;
   int q = p;
   while(q < StringLen(json))
     {
      ushort c = StringGetCharacter(json, q);
      if(!((c >= '0' && c <= '9') || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E')) break;
      q++;
     }
   if(q == p) return dflt;
   return StringToDouble(StringSubstr(json, p, q - p));
  }

bool JHas(const string json, const string key) { return StringFind(json, "\"" + key + "\":") >= 0; }

int JStrArray(const string json, const string key, string &out[])
  {
   ArrayResize(out, 0);
   string pat = "\"" + key + "\":[";
   int p = StringFind(json, pat);
   if(p < 0) return 0;
   p += StringLen(pat);
   int e = StringFind(json, "]", p);
   if(e < 0) return 0;
   string parts[];
   int n = StringSplit(StringSubstr(json, p, e - p), ',', parts);
   for(int i = 0; i < n; i++)
     {
      string s = parts[i];
      StringReplace(s, "\"", "");
      StringTrimLeft(s);
      StringTrimRight(s);
      if(StringLen(s) == 0) continue;
      int k = ArraySize(out);
      ArrayResize(out, k + 1);
      out[k] = s;
     }
   return ArraySize(out);
  }

// Returns false for a period MT5 does not have; the caller reports an error instead of sending another period's candles.
bool TfFrom(const string s, ENUM_TIMEFRAMES &tf)
  {
   string names[] = {"M1","M2","M3","M4","M5","M6","M10","M12","M15","M20","M30","H1","H2","H3","H4","H6","H8","H12","D1","W1","MN1"};
   ENUM_TIMEFRAMES vals[] = {PERIOD_M1,PERIOD_M2,PERIOD_M3,PERIOD_M4,PERIOD_M5,PERIOD_M6,PERIOD_M10,PERIOD_M12,PERIOD_M15,PERIOD_M20,PERIOD_M30,
                             PERIOD_H1,PERIOD_H2,PERIOD_H3,PERIOD_H4,PERIOD_H6,PERIOD_H8,PERIOD_H12,PERIOD_D1,PERIOD_W1,PERIOD_MN1};
   for(int i = 0; i < ArraySize(names); i++)
      if(names[i] == s) { tf = vals[i]; return true; }
   return false;
  }

// Deterministic 27-char tag for an Aurum commandId, kept in the order comment so a command can be found again
// after a crash or a timeout and is never sent twice. MT5 comments are limited to 31 characters.
string CommandTag(const string commandId)
  {
   uchar src[], key[], hash[];
   StringToCharArray(commandId, src, 0, WHOLE_ARRAY, CP_UTF8);
   if(CryptEncode(CRYPT_HASH_SHA256, src, key, hash) <= 0) return "AU:" + StringSubstr(commandId, 0, 24);
   string hex = "";
   for(int i = 0; i < 12; i++) hex += StringFormat("%02x", hash[i]);
   return "AU:" + hex;
  }

bool TradeAllowed()
  {
   return (bool)TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && (bool)MQLInfoInteger(MQL_TRADE_ALLOWED) &&
          (bool)AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) && (bool)AccountInfoInteger(ACCOUNT_TRADE_EXPERT);
  }

bool IsDemo() { return AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_DEMO; }

double NormVolume(const string sym, double v)
  {
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   if(step > 0) v = MathFloor(v / step + 1e-9) * step;   // never round up: that would exceed the risk
   if(v < vmin) return 0.0;
   if(v > vmax) v = vmax;
   return NormalizeDouble(v, 8);
  }

ENUM_ORDER_TYPE_FILLING FillingFor(const string sym)
  {
   int f = (int)SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);
   if((f & SYMBOL_FILLING_IOC) != 0) return ORDER_FILLING_IOC;
   if((f & SYMBOL_FILLING_FOK) != 0) return ORDER_FILLING_FOK;
   return ORDER_FILLING_RETURN;
  }

//+------------------------------------------------------------------+
//| WebSocket client (client frames must be masked)                  |
//+------------------------------------------------------------------+
bool SockSendAll(const uchar &data[], const int len)
  {
   int sent = 0;
   while(sent < len)
     {
      uchar chunk[];
      ArrayResize(chunk, len - sent);
      ArrayCopy(chunk, data, 0, sent, len - sent);
      int r = SocketSend(g_sock, chunk, len - sent);
      if(r <= 0) return false;
      sent += r;
     }
   return true;
  }

bool WsSend(const string text, const uchar opcode = 0x1)
  {
   if(g_sock == INVALID_HANDLE) return false;
   uchar payload[];
   int plen = StringToCharArray(text, payload, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   if(plen < 0) plen = 0;
   uchar frame[];
   int hdr = (plen < 126) ? 2 : (plen <= 65535 ? 4 : 10);
   ArrayResize(frame, hdr + 4 + plen);
   frame[0] = (uchar)(0x80 | opcode);
   if(plen < 126)
      frame[1] = (uchar)(0x80 | plen);
   else if(plen <= 65535)
     {
      frame[1] = (uchar)(0x80 | 126);
      frame[2] = (uchar)((plen >> 8) & 0xFF);
      frame[3] = (uchar)(plen & 0xFF);
     }
   else
     {
      frame[1] = (uchar)(0x80 | 127);
      for(int i = 0; i < 8; i++)
         frame[2 + i] = (uchar)((((long)plen) >> (8 * (7 - i))) & 0xFF);
     }
   uchar mask[4];
   for(int i = 0; i < 4; i++) { mask[i] = (uchar)(MathRand() & 0xFF); frame[hdr + i] = mask[i]; }
   for(int i = 0; i < plen; i++) frame[hdr + 4 + i] = (uchar)(payload[i] ^ mask[i & 3]);
   return SockSendAll(frame, hdr + 4 + plen);
  }

void WsPump()
  {
   if(g_sock == INVALID_HANDLE) return;
   uint avail = SocketIsReadable(g_sock);
   while(avail > 0)
     {
      uchar tmp[];
      ArrayResize(tmp, (int)avail);
      int r = SocketRead(g_sock, tmp, (int)avail, 1);
      if(r <= 0) break;
      int old = ArraySize(g_rx);
      ArrayResize(g_rx, old + r);
      ArrayCopy(g_rx, tmp, old, 0, r);
      avail = SocketIsReadable(g_sock);
     }
   while(true)
     {
      int n = ArraySize(g_rx);
      if(n < 2) return;
      uchar b0 = g_rx[0], b1 = g_rx[1];
      uchar opcode = (uchar)(b0 & 0x0F);
      bool masked = (b1 & 0x80) != 0;
      long len = b1 & 0x7F;
      int pos = 2;
      if(len == 126)
        {
         if(n < 4) return;
         len = ((long)g_rx[2] << 8) | g_rx[3];
         pos = 4;
        }
      else if(len == 127)
        {
         if(n < 10) return;
         len = 0;
         for(int i = 0; i < 8; i++) len = (len << 8) | g_rx[2 + i];
         pos = 10;
        }
      if(masked) pos += 4;
      if(n < pos + len) return;
      uchar payload[];
      ArrayResize(payload, (int)len);
      if(len > 0) ArrayCopy(payload, g_rx, 0, pos, (int)len);
      if(masked)
         for(int i = 0; i < (int)len; i++) payload[i] = (uchar)(payload[i] ^ g_rx[pos - 4 + (i & 3)]);
      int rest = n - pos - (int)len;
      if(rest > 0) ArrayCopy(g_rx, g_rx, 0, pos + (int)len, rest);
      ArrayResize(g_rx, rest);
      if(opcode == 0x1)
         HandleMessage(CharArrayToString(payload, 0, (int)len, CP_UTF8));
      else if(opcode == 0x9)
         WsSend(CharArrayToString(payload, 0, (int)len, CP_UTF8), 0xA);
      else if(opcode == 0x8)
        {
         Disconnect("server closed");
         return;
        }
     }
  }

void Disconnect(const string why)
  {
   if(g_sock != INVALID_HANDLE) { SocketClose(g_sock); g_sock = INVALID_HANDLE; }
   if(g_ready) Print("AurumBridge: disconnected (", why, ")");
   g_ready = false;
   ArrayResize(g_rx, 0);
   g_nextReconnect = TimeLocal() + 2;
  }

bool Connect()
  {
   g_sock = SocketCreate();
   if(g_sock == INVALID_HANDLE) { Print("AurumBridge: SocketCreate failed ", GetLastError()); return false; }
   if(!SocketConnect(g_sock, HubHost, HubPort, 1500))
     {
      int err = GetLastError();
      SocketClose(g_sock);
      g_sock = INVALID_HANDLE;
      Print("AurumBridge: cannot reach Aurum at ", HubHost, ":", HubPort, " (err ", err, "). Is Aurum running? For err 4014 add http://", HubHost,
            " under Tools > Options > Expert Advisors and tick Allow algorithmic trading, then re-attach.");
      return false;
     }
   uchar keyBytes[16], keyB64[], empty[];
   for(int i = 0; i < 16; i++) keyBytes[i] = (uchar)(MathRand() & 0xFF);
   CryptEncode(CRYPT_BASE64, keyBytes, empty, keyB64);
   string key = CharArrayToString(keyB64);
   string req = "GET / HTTP/1.1\r\nHost: " + HubHost + ":" + IntegerToString(HubPort) +
                "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key +
                "\r\nSec-WebSocket-Version: 13\r\n\r\n";
   uchar rb[];
   int rl = StringToCharArray(req, rb, 0, WHOLE_ARRAY, CP_UTF8) - 1;
   if(!SockSendAll(rb, rl)) { Disconnect("handshake send failed"); return false; }
   string resp = "";
   ulong t0 = GetTickCount64();
   while(GetTickCount64() - t0 < 2000 && StringFind(resp, "\r\n\r\n") < 0)
     {
      uint a = SocketIsReadable(g_sock);
      if(a > 0)
        {
         uchar buf[];
         ArrayResize(buf, (int)a);
         int r = SocketRead(g_sock, buf, (int)a, 100);
         if(r > 0) resp += CharArrayToString(buf, 0, r);
        }
      else Sleep(2);
     }
   if(StringFind(resp, " 101 ") < 0) { Disconnect("handshake rejected"); return false; }
   string reg = "{\"action\":\"register\",\"protocol\":" + IntegerToString(PROTOCOL_VERSION) +
                ",\"instance_id\":\"" + Esc(InstanceId) + "\",\"token\":\"" + Esc(AuthToken) + "\"" +
                ",\"broker_company\":\"" + Esc(AccountInfoString(ACCOUNT_COMPANY)) + "\"" +
                ",\"server\":\"" + Esc(AccountInfoString(ACCOUNT_SERVER)) + "\"" +
                ",\"account_number\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) +
                ",\"currency\":\"" + Esc(AccountInfoString(ACCOUNT_CURRENCY)) + "\"" +
                ",\"demo\":" + (IsDemo() ? "true" : "false") +
                ",\"build\":" + IntegerToString(TerminalInfoInteger(TERMINAL_BUILD)) +
                ",\"trading_enabled\":" + (EnableTrading && TradeAllowed() && (IsDemo() || AllowLive) ? "true" : "false") + "}";
   if(!WsSend(reg)) { Disconnect("register send failed"); return false; }
   g_ready = true;
   Print("AurumBridge: connected to Aurum as ", InstanceId);
   return true;
  }

//+------------------------------------------------------------------+
//| Replies                                                          |
//+------------------------------------------------------------------+
// status: "done" | "rejected" | "unknown". "unknown" means the order may have reached the broker: Aurum must
// look it up (find) and never send it again blindly.
void Result(const string rid, const string status, const string message, const ulong ticket = 0, const double price = 0, const double volume = 0, const uint retcode = 0, const bool duplicate = false)
  {
   string m = "{\"action\":\"order_result\",\"req_id\":\"" + Esc(rid) + "\",\"status\":\"" + status + "\",\"retcode\":" + IntegerToString((int)retcode) +
              ",\"message\":\"" + Esc(message) + "\"";
   if(ticket > 0) m += ",\"ticket\":" + (string)ticket;
   if(price > 0) m += ",\"price\":" + Num(price, 8);
   if(volume > 0) m += ",\"volume\":" + Num(volume, 4);
   if(duplicate) m += ",\"duplicate\":true";
   WsSend(m + "}");
  }

void Err(const string action, const string rid, const string message)
  {
   WsSend("{\"action\":\"" + action + "\",\"req_id\":\"" + Esc(rid) + "\",\"ok\":false,\"error\":\"" + Esc(message) + "\"}");
  }

//+------------------------------------------------------------------+
//| Data                                                             |
//+------------------------------------------------------------------+
void SendAccount()
  {
   WsSend("{\"action\":\"account\",\"balance\":" + Num(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
          ",\"equity\":" + Num(AccountInfoDouble(ACCOUNT_EQUITY), 2) +
          ",\"margin\":" + Num(AccountInfoDouble(ACCOUNT_MARGIN), 2) +
          ",\"free_margin\":" + Num(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) +
          ",\"currency\":\"" + Esc(AccountInfoString(ACCOUNT_CURRENCY)) + "\"" +
          ",\"demo\":" + (IsDemo() ? "true" : "false") + "}");
  }

string PositionJson()
  {
   string list = "";
   int n = 0;
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0) continue;
      string sym = PositionGetString(POSITION_SYMBOL);
      int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      double sl = PositionGetDouble(POSITION_SL), tp = PositionGetDouble(POSITION_TP);
      string item = "{\"ticket\":" + (string)t + ",\"time\":" + (string)PositionGetInteger(POSITION_TIME) +
                    ",\"symbol\":\"" + Esc(sym) + "\",\"type\":\"" + (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "buy" : "sell") +
                    "\",\"volume\":" + Num(PositionGetDouble(POSITION_VOLUME), 4) +
                    ",\"priceOpen\":" + Num(PositionGetDouble(POSITION_PRICE_OPEN), digits) +
                    ",\"priceCurrent\":" + Num(PositionGetDouble(POSITION_PRICE_CURRENT), digits) +
                    ",\"sl\":" + (sl > 0 ? Num(sl, digits) : "null") + ",\"tp\":" + (tp > 0 ? Num(tp, digits) : "null") +
                    ",\"swap\":" + Num(PositionGetDouble(POSITION_SWAP), 2) + ",\"profit\":" + Num(PositionGetDouble(POSITION_PROFIT), 2) +
                    ",\"magic\":" + (string)PositionGetInteger(POSITION_MAGIC) + ",\"comment\":\"" + Esc(PositionGetString(POSITION_COMMENT)) + "\"}";
      list += (n > 0 ? "," : "") + item;
      n++;
     }
   return list;
  }

void SendPositions(const bool force)
  {
   string list = PositionJson();
   if(!force && list == g_posSig) return;
   g_posSig = list;
   WsSend("{\"action\":\"positions\",\"list\":[" + list + "]}");
  }

void DoSubscribe(const string json)
  {
   string syms[];
   int n = JStrArray(json, "symbols", syms);
   ArrayResize(g_symbols, 0);
   ArrayResize(g_lastBid, 0);
   ArrayResize(g_lastAsk, 0);
   ArrayResize(g_lastMsc, 0);
   for(int i = 0; i < n; i++)
     {
      if(!SymbolSelect(syms[i], true))
        {
         Print("AurumBridge: symbol '", syms[i], "' does not exist in this terminal. Use the broker's name (for example XAUUSDm) in Aurum Settings.");
         continue;
        }
      int k = ArraySize(g_symbols);
      ArrayResize(g_symbols, k + 1);
      ArrayResize(g_lastBid, k + 1);
      ArrayResize(g_lastAsk, k + 1);
      ArrayResize(g_lastMsc, k + 1);
      g_symbols[k] = syms[i];
      g_lastBid[k] = 0; g_lastAsk[k] = 0; g_lastMsc[k] = 0;
     }
   Print("AurumBridge: subscribed to ", ArraySize(g_symbols), " symbols");
  }

void DoCandles(const string json)
  {
   string rid = JStr(json, "req_id"), sym = JStr(json, "symbol"), tfs = JStr(json, "tf");
   int count = (int)MathMin(5000.0, MathMax(1.0, JNum(json, "count", 500)));
   if(!SymbolSelect(sym, true)) { Err("candles", rid, "unknown symbol " + sym); return; }
   MqlRates r[];
   ArraySetAsSeries(r, false);
   ENUM_TIMEFRAMES tf;
   if(!TfFrom(tfs, tf)) { Err("candles", rid, "unknown timeframe " + tfs); return; }
   int n = CopyRates(sym, tf, 0, count, r);
   if(n <= 0) { Err("candles", rid, "no candles for " + sym + " " + tfs + " (err " + IntegerToString(GetLastError()) + ")"); return; }
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   string body = "";
   for(int i = 0; i < n; i++)
      StringAdd(body, (i > 0 ? "," : "") + "[" + (string)(long)r[i].time + "," + Num(r[i].open, digits) + "," + Num(r[i].high, digits) + "," +
                      Num(r[i].low, digits) + "," + Num(r[i].close, digits) + "," + (string)r[i].tick_volume + "]");
   WsSend("{\"action\":\"candles\",\"req_id\":\"" + Esc(rid) + "\",\"ok\":true,\"symbol\":\"" + Esc(sym) + "\",\"tf\":\"" + Esc(tfs) + "\",\"data\":[" + body + "]}");
  }

void DoSpec(const string json)
  {
   string rid = JStr(json, "req_id"), sym = JStr(json, "symbol");
   if(!SymbolSelect(sym, true)) { Err("spec", rid, "unknown symbol " + sym); return; }
   WsSend("{\"action\":\"spec\",\"req_id\":\"" + Esc(rid) + "\",\"ok\":true,\"symbol\":\"" + Esc(sym) + "\"" +
          ",\"digits\":" + IntegerToString((int)SymbolInfoInteger(sym, SYMBOL_DIGITS)) +
          ",\"point\":" + Num(SymbolInfoDouble(sym, SYMBOL_POINT), 10) +
          ",\"contractSize\":" + Num(SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 4) +
          ",\"tickSize\":" + Num(SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE), 10) +
          ",\"tickValue\":" + Num(SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), 8) +
          ",\"volumeMin\":" + Num(SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 4) +
          ",\"volumeMax\":" + Num(SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX), 4) +
          ",\"volumeStep\":" + Num(SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 4) +
          ",\"stopsLevel\":" + IntegerToString((int)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL)) +
          ",\"freezeLevel\":" + IntegerToString((int)SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL)) + "}");
  }

void DoQuotes(const string json)
  {
   string rid = JStr(json, "req_id");
   string syms[];
   int n = JStrArray(json, "symbols", syms);
   string list = "";
   for(int i = 0; i < n && i < 20; i++)
     {
      string s = syms[i];
      string item;
      MqlTick t;
      if(!SymbolSelect(s, true))
         item = "{\"symbol\":\"" + Esc(s) + "\",\"ok\":false,\"error\":\"Symbol '" + Esc(s) + "' not found on this broker.\"}";
      else if(!SymbolInfoTick(s, t) || (t.bid == 0 && t.ask == 0))
         item = "{\"symbol\":\"" + Esc(s) + "\",\"ok\":false,\"error\":\"No tick for '" + Esc(s) + "' (market closed or no data).\"}";
      else
        {
         int digits = (int)SymbolInfoInteger(s, SYMBOL_DIGITS);
         MqlRates d[];
         string prev = "null";
         if(CopyRates(s, PERIOD_D1, 0, 2, d) == 2) prev = Num(d[0].close, digits);
         item = "{\"symbol\":\"" + Esc(s) + "\",\"ok\":true,\"bid\":" + Num(t.bid, digits) + ",\"ask\":" + Num(t.ask, digits) +
                ",\"time\":" + DoubleToString((double)t.time_msc / 1000.0, 3) + ",\"prevClose\":" + prev + ",\"error\":null}";
        }
      list += (i > 0 ? "," : "") + item;
     }
   WsSend("{\"action\":\"quotes\",\"req_id\":\"" + Esc(rid) + "\",\"ok\":true,\"list\":[" + list + "]}");
  }

void DoSymbols(const string json)
  {
   string rid = JStr(json, "req_id"), q = JStr(json, "q");
   StringToUpper(q);
   string list = "";
   int n = 0;
   for(int i = 0; i < SymbolsTotal(false) && n < 50; i++)
     {
      string s = SymbolName(i, false);
      string u = s;
      StringToUpper(u);
      if(StringLen(q) > 0 && StringFind(u, q) < 0) continue;
      list += (n > 0 ? "," : "") + "\"" + Esc(s) + "\"";
      n++;
     }
   WsSend("{\"action\":\"symbols\",\"req_id\":\"" + Esc(rid) + "\",\"ok\":true,\"list\":[" + list + "]}");
  }

void DoDeals(const string json)
  {
   string rid = JStr(json, "req_id");
   datetime since = (datetime)(long)JNum(json, "since", (double)(TimeCurrent() - 86400));
   if(!HistorySelect(since, TimeCurrent() + 3600)) { Err("deals", rid, "history unavailable"); return; }
   int total = HistoryDealsTotal();
   int from = MathMax(0, total - 500);
   string list = "";
   int n = 0;
   for(int i = from; i < total; i++)
     {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0) continue;
      long type = HistoryDealGetInteger(d, DEAL_TYPE);
      string tname = (type == DEAL_TYPE_BUY ? "buy" : (type == DEAL_TYPE_SELL ? "sell" : "other"));
      long entry = HistoryDealGetInteger(d, DEAL_ENTRY);
      string ename = (entry == DEAL_ENTRY_IN ? "in" : (entry == DEAL_ENTRY_OUT ? "out" : (entry == DEAL_ENTRY_INOUT ? "inout" : "other")));
      string item = "{\"ticket\":" + (string)d + ",\"order\":" + (string)HistoryDealGetInteger(d, DEAL_ORDER) +
                    ",\"time\":" + (string)HistoryDealGetInteger(d, DEAL_TIME) + ",\"type\":\"" + tname + "\",\"entry\":\"" + ename + "\"" +
                    ",\"positionId\":" + (string)HistoryDealGetInteger(d, DEAL_POSITION_ID) +
                    ",\"volume\":" + Num(HistoryDealGetDouble(d, DEAL_VOLUME), 4) + ",\"price\":" + Num(HistoryDealGetDouble(d, DEAL_PRICE), 8) +
                    ",\"commission\":" + Num(HistoryDealGetDouble(d, DEAL_COMMISSION), 4) + ",\"swap\":" + Num(HistoryDealGetDouble(d, DEAL_SWAP), 4) +
                    ",\"profit\":" + Num(HistoryDealGetDouble(d, DEAL_PROFIT), 4) + ",\"fee\":" + Num(HistoryDealGetDouble(d, DEAL_FEE), 4) +
                    ",\"symbol\":\"" + Esc(HistoryDealGetString(d, DEAL_SYMBOL)) + "\",\"magic\":" + (string)HistoryDealGetInteger(d, DEAL_MAGIC) +
                    ",\"comment\":\"" + Esc(HistoryDealGetString(d, DEAL_COMMENT)) + "\"}";
      list += (n > 0 ? "," : "") + item;
      n++;
     }
   WsSend("{\"action\":\"deals\",\"req_id\":\"" + Esc(rid) + "\",\"ok\":true,\"list\":[" + list + "]}");
  }

// Is there any trace of this command (open position, pending order, or a deal in the last 2 days)?
// Returns the position ticket when found, 0 otherwise.
ulong FindTag(const string tag, string &where)
  {
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong t = PositionGetTicket(i);
      if(t > 0 && PositionGetString(POSITION_COMMENT) == tag) { where = "position"; return t; }
     }
   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong t = OrderGetTicket(i);
      if(t > 0 && OrderGetString(ORDER_COMMENT) == tag) { where = "order"; return t; }
     }
   if(HistorySelect(TimeCurrent() - 172800, TimeCurrent() + 3600))
      for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
        {
         ulong d = HistoryDealGetTicket(i);
         if(d > 0 && HistoryDealGetString(d, DEAL_COMMENT) == tag) { where = "deal"; return (ulong)HistoryDealGetInteger(d, DEAL_POSITION_ID); }
        }
   where = "";
   return 0;
  }

void DoFind(const string json)
  {
   string rid = JStr(json, "req_id"), tag = CommandTag(JStr(json, "command_id"));
   string where;
   ulong t = FindTag(tag, where);
   WsSend("{\"action\":\"find\",\"req_id\":\"" + Esc(rid) + "\",\"ok\":true,\"tag\":\"" + tag + "\",\"found\":" + (t > 0 ? "true" : "false") +
          ",\"where\":\"" + where + "\",\"ticket\":" + (string)t + "}");
  }

//+------------------------------------------------------------------+
//| Trading. Everything here is OFF unless EnableTrading = true.     |
//+------------------------------------------------------------------+
bool TradingGate(const string rid, const string symbol)
  {
   if(!EnableTrading) { Result(rid, "rejected", "Trading is disabled in the EA inputs (EnableTrading=false)."); return false; }
   if(!IsDemo() && !AllowLive) { Result(rid, "rejected", "This is a LIVE account and AllowLive=false. Refusing."); return false; }
   if(!TradeAllowed()) { Result(rid, "rejected", "Trading is not allowed in the terminal (Algo Trading button / account)."); return false; }
   if(StringLen(AllowedSymbol) > 0 && symbol != AllowedSymbol) { Result(rid, "rejected", "Symbol " + symbol + " is not the allowed symbol " + AllowedSymbol + "."); return false; }
   return true;
  }

// Classify a CTrade outcome. Timeouts and "no answer" results are UNKNOWN, never retried by the EA or by Aurum.
void Report(const string rid, const bool ok, const ulong positionTicket)
  {
   uint rc = g_trade.ResultRetcode();
   bool success = ok && (rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED || rc == TRADE_RETCODE_DONE_PARTIAL);
   if(success)
     { Result(rid, rc == TRADE_RETCODE_DONE_PARTIAL ? "done" : "done", g_trade.ResultRetcodeDescription(), positionTicket, g_trade.ResultPrice(), g_trade.ResultVolume(), rc); return; }
   if(rc == TRADE_RETCODE_TIMEOUT || rc == 0 || rc == TRADE_RETCODE_CONNECTION)
     { Result(rid, "unknown", "No answer from the broker (" + g_trade.ResultRetcodeDescription() + "). Check MT5 before doing anything else.", positionTicket, 0, 0, rc); return; }
   Result(rid, "rejected", "retcode " + IntegerToString((int)rc) + " " + g_trade.ResultRetcodeDescription(), 0, 0, 0, rc);
  }

void DoOpen(const string json)
  {
   string rid = JStr(json, "req_id"), cid = JStr(json, "command_id"), sym = JStr(json, "symbol"), side = JStr(json, "side");
   if(!TradingGate(rid, sym)) return;
   double sl = JNum(json, "sl"), tp = JNum(json, "tp");
   double vol = NormVolume(sym, JNum(json, "volume"));
   if(vol <= 0.0) { Result(rid, "rejected", "Volume is below the broker minimum or invalid."); return; }
   if(sl <= 0.0 && !AllowNoStopLoss) { Result(rid, "rejected", "A stop loss is required."); return; }
   // Idempotency: if this command already left a trace, report it instead of sending again.
   string tag = CommandTag(cid), where;
   ulong existing = FindTag(tag, where);
   if(existing > 0) { Result(rid, "done", "Already executed earlier (" + where + ").", existing, 0, 0, 0, true); return; }
   MqlTick tk;
   if(!SymbolInfoTick(sym, tk)) { Result(rid, "rejected", "No quote for " + sym + "."); return; }
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   bool buy = (side == "buy");
   double ref = buy ? tk.ask : tk.bid;
   if(sl > 0 && ((buy && sl >= ref) || (!buy && sl <= ref))) { Result(rid, "rejected", "Stop loss is on the wrong side of the market (price moved)."); return; }
   if(tp > 0 && ((buy && tp <= ref) || (!buy && tp >= ref))) { Result(rid, "rejected", "Take profit is already reached (price moved)."); return; }
   double devPrice = JNum(json, "deviation", 0.0);
   long devPts = (devPrice > 0 && point > 0) ? (long)MathMax(1.0, MathRound(devPrice / point)) : DefaultDeviationPts;
   g_trade.SetExpertMagicNumber(AURUM_MAGIC);
   g_trade.SetDeviationInPoints((ulong)devPts);
   g_trade.SetTypeFilling(FillingFor(sym));
   bool ok = buy ? g_trade.Buy(vol, sym, 0.0, NormalizeDouble(sl, digits), NormalizeDouble(tp, digits), tag)
                 : g_trade.Sell(vol, sym, 0.0, NormalizeDouble(sl, digits), NormalizeDouble(tp, digits), tag);
   ulong posTicket = 0;
   ulong deal = g_trade.ResultDeal();
   if(deal > 0 && HistoryDealSelect(deal)) posTicket = (ulong)HistoryDealGetInteger(deal, DEAL_POSITION_ID);
   if(posTicket == 0) posTicket = g_trade.ResultOrder();
   Report(rid, ok, posTicket);
   SendPositions(true);
  }

void DoModify(const string json)
  {
   string rid = JStr(json, "req_id");
   ulong ticket = (ulong)JNum(json, "ticket");
   if(JStr(json, "kind") == "order") { DoModifyOrder(rid, json, ticket); return; }
   if(!PositionSelectByTicket(ticket)) { Result(rid, "rejected", "Position not found."); return; }
   string sym = PositionGetString(POSITION_SYMBOL);
   if(!TradingGate(rid, sym)) return;
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   // Absent field = keep the current value (never silently remove a stop loss).
   double sl = JHas(json, "sl") ? JNum(json, "sl") : PositionGetDouble(POSITION_SL);
   double tp = JHas(json, "tp") ? JNum(json, "tp") : PositionGetDouble(POSITION_TP);
   g_trade.SetExpertMagicNumber(AURUM_MAGIC);
   bool ok = g_trade.PositionModify(ticket, NormalizeDouble(sl, digits), NormalizeDouble(tp, digits));
   Report(rid, ok, ticket);
   SendPositions(true);
  }

void DoClose(const string json)
  {
   string rid = JStr(json, "req_id"), cid = JStr(json, "command_id");
   ulong ticket = (ulong)JNum(json, "ticket");
   double vol = JNum(json, "volume", 0.0);   // 0 or absent = close the whole position
   if(!PositionSelectByTicket(ticket)) { Result(rid, "rejected", "Position not found."); return; }
   string sym = PositionGetString(POSITION_SYMBOL);
   if(!TradingGate(rid, sym)) return;
   double full = PositionGetDouble(POSITION_VOLUME);
   g_trade.SetExpertMagicNumber(AURUM_MAGIC);
   g_trade.SetDeviationInPoints(100);
   g_trade.SetTypeFilling(FillingFor(sym));
   bool ok;
   if(vol > 0.0 && vol < full)
     {
      double v = NormVolume(sym, vol);
      double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
      if(v <= 0.0 || full - v < vmin - 1e-9) { Result(rid, "rejected", "That partial volume is invalid or would leave less than the minimum volume."); return; }
      ok = g_trade.PositionClosePartial(ticket, v);
     }
   else
      ok = g_trade.PositionClose(ticket);
   Report(rid, ok, ticket);
   SendPositions(true);
  }


//+------------------------------------------------------------------+
//| Pending orders                                                   |
//+------------------------------------------------------------------+
bool PendingTypeFrom(const string s, ENUM_ORDER_TYPE &t)
  {
   if(s == "buy_limit")  { t = ORDER_TYPE_BUY_LIMIT;  return true; }
   if(s == "sell_limit") { t = ORDER_TYPE_SELL_LIMIT; return true; }
   if(s == "buy_stop")   { t = ORDER_TYPE_BUY_STOP;   return true; }
   if(s == "sell_stop")  { t = ORDER_TYPE_SELL_STOP;  return true; }
   return false;
  }

string PendingName(const long t)
  {
   if(t == ORDER_TYPE_BUY_LIMIT)  return "buy_limit";
   if(t == ORDER_TYPE_SELL_LIMIT) return "sell_limit";
   if(t == ORDER_TYPE_BUY_STOP)   return "buy_stop";
   if(t == ORDER_TYPE_SELL_STOP)  return "sell_stop";
   if(t == ORDER_TYPE_BUY_STOP_LIMIT)  return "buy_stop_limit";
   if(t == ORDER_TYPE_SELL_STOP_LIMIT) return "sell_stop_limit";
   return "other";
  }

void DoOrders(const string json)
  {
   string rid = JStr(json, "req_id");
   string list = "";
   int n = 0;
   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong t = OrderGetTicket(i);
      if(t == 0) continue;
      string sym = OrderGetString(ORDER_SYMBOL);
      int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      double sl = OrderGetDouble(ORDER_SL), tp = OrderGetDouble(ORDER_TP);
      long exp = (long)OrderGetInteger(ORDER_TIME_EXPIRATION);
      string item = "{\"ticket\":" + (string)t + ",\"time\":" + (string)OrderGetInteger(ORDER_TIME_SETUP) +
                    ",\"symbol\":\"" + Esc(sym) + "\",\"type\":\"" + PendingName(OrderGetInteger(ORDER_TYPE)) +
                    "\",\"volume\":" + Num(OrderGetDouble(ORDER_VOLUME_CURRENT), 4) +
                    ",\"priceOpen\":" + Num(OrderGetDouble(ORDER_PRICE_OPEN), digits) +
                    ",\"priceCurrent\":" + Num(OrderGetDouble(ORDER_PRICE_CURRENT), digits) +
                    ",\"sl\":" + (sl > 0 ? Num(sl, digits) : "null") + ",\"tp\":" + (tp > 0 ? Num(tp, digits) : "null") +
                    ",\"state\":" + (string)OrderGetInteger(ORDER_STATE) +
                    ",\"magic\":" + (string)OrderGetInteger(ORDER_MAGIC) + ",\"comment\":\"" + Esc(OrderGetString(ORDER_COMMENT)) +
                    "\",\"expiration\":" + (exp > 0 ? (string)exp : "null") + ",\"positionId\":null}";
      list += (n > 0 ? "," : "") + item;
      n++;
     }
   WsSend("{\"action\":\"orders\",\"req_id\":\"" + Esc(rid) + "\",\"ok\":true,\"list\":[" + list + "]}");
  }

void DoPending(const string json)
  {
   string rid = JStr(json, "req_id"), cid = JStr(json, "command_id"), sym = JStr(json, "symbol"), ot = JStr(json, "order_type");
   if(!TradingGate(rid, sym)) return;
   ENUM_ORDER_TYPE type;
   if(!PendingTypeFrom(ot, type)) { Result(rid, "rejected", "Unknown pending order type " + ot + "."); return; }
   double price = JNum(json, "price"), sl = JNum(json, "sl"), tp = JNum(json, "tp");
   double vol = NormVolume(sym, JNum(json, "volume"));
   long exp = (long)JNum(json, "expiration", 0);
   if(vol <= 0.0) { Result(rid, "rejected", "Volume is below the broker minimum or invalid."); return; }
   if(price <= 0.0) { Result(rid, "rejected", "A pending order needs a price."); return; }
   if(sl <= 0.0 && !AllowNoStopLoss) { Result(rid, "rejected", "A stop loss is required."); return; }
   if(exp > 0 && exp <= (long)TimeCurrent()) { Result(rid, "rejected", "The expiration time is already in the past."); return; }
   string tag = CommandTag(cid), where;
   ulong existing = FindTag(tag, where);
   if(existing > 0) { Result(rid, "done", "Already placed earlier (" + where + ").", existing, 0, 0, 0, true); return; }
   MqlTick tk;
   if(!SymbolInfoTick(sym, tk)) { Result(rid, "rejected", "No quote for " + sym + "."); return; }
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   bool buy = (type == ORDER_TYPE_BUY_LIMIT || type == ORDER_TYPE_BUY_STOP);
   // The entry must be on the correct side of the market for the order type.
   if(type == ORDER_TYPE_BUY_LIMIT && price >= tk.ask)  { Result(rid, "rejected", "A buy limit must be below the current ask."); return; }
   if(type == ORDER_TYPE_BUY_STOP && price <= tk.ask)   { Result(rid, "rejected", "A buy stop must be above the current ask."); return; }
   if(type == ORDER_TYPE_SELL_LIMIT && price <= tk.bid) { Result(rid, "rejected", "A sell limit must be above the current bid."); return; }
   if(type == ORDER_TYPE_SELL_STOP && price >= tk.bid)  { Result(rid, "rejected", "A sell stop must be below the current bid."); return; }
   if(sl > 0 && ((buy && sl >= price) || (!buy && sl <= price))) { Result(rid, "rejected", "Stop loss is on the wrong side of the entry price."); return; }
   if(tp > 0 && ((buy && tp <= price) || (!buy && tp >= price))) { Result(rid, "rejected", "Take profit is on the wrong side of the entry price."); return; }
   g_trade.SetExpertMagicNumber(AURUM_MAGIC);
   g_trade.SetTypeFilling(FillingFor(sym));
   bool ok = g_trade.OrderOpen(sym, type, vol, 0.0, NormalizeDouble(price, digits), NormalizeDouble(sl, digits), NormalizeDouble(tp, digits),
                               exp > 0 ? ORDER_TIME_SPECIFIED : ORDER_TIME_GTC, (datetime)exp, tag);
   Report(rid, ok, g_trade.ResultOrder());
  }

void DoCancel(const string json)
  {
   string rid = JStr(json, "req_id");
   ulong ticket = (ulong)JNum(json, "ticket");
   if(!OrderSelect(ticket)) { Result(rid, "rejected", "Pending order not found (it may have been filled or removed)."); return; }
   string sym = OrderGetString(ORDER_SYMBOL);
   if(!TradingGate(rid, sym)) return;
   g_trade.SetExpertMagicNumber(AURUM_MAGIC);
   bool ok = g_trade.OrderDelete(ticket);
   Report(rid, ok, ticket);
  }

void DoModifyOrder(const string rid, const string json, const ulong ticket)
  {
   if(!OrderSelect(ticket)) { Result(rid, "rejected", "Pending order not found."); return; }
   string sym = OrderGetString(ORDER_SYMBOL);
   if(!TradingGate(rid, sym)) return;
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double price = OrderGetDouble(ORDER_PRICE_OPEN);
   double sl = JHas(json, "sl") ? JNum(json, "sl") : OrderGetDouble(ORDER_SL);
   double tp = JHas(json, "tp") ? JNum(json, "tp") : OrderGetDouble(ORDER_TP);
   ENUM_ORDER_TYPE_TIME tt = (ENUM_ORDER_TYPE_TIME)OrderGetInteger(ORDER_TYPE_TIME);
   datetime exp = (datetime)OrderGetInteger(ORDER_TIME_EXPIRATION);
   g_trade.SetExpertMagicNumber(AURUM_MAGIC);
   bool ok = g_trade.OrderModify(ticket, NormalizeDouble(price, digits), NormalizeDouble(sl, digits), NormalizeDouble(tp, digits), tt, exp);
   Report(rid, ok, ticket);
  }

void HandleMessage(const string json)
  {
   string action = JStr(json, "action");
   if(action == "ping")
      WsSend("{\"action\":\"pong\",\"t\":" + StringFormat("%I64d", (long)JNum(json, "t")) + "}");
   else if(action == "subscribe") DoSubscribe(json);
   else if(action == "candles")   DoCandles(json);
   else if(action == "spec")      DoSpec(json);
   else if(action == "symbols")   DoSymbols(json);
   else if(action == "quotes")    DoQuotes(json);
   else if(action == "deals")     DoDeals(json);
   else if(action == "find")      DoFind(json);
   else if(action == "positions") SendPositions(true);
   else if(action == "open")      DoOpen(json);
   else if(action == "modify")    DoModify(json);
   else if(action == "close")     DoClose(json);
   else if(action == "pending")   DoPending(json);
   else if(action == "cancel")    DoCancel(json);
   else if(action == "orders")    DoOrders(json);
   else if(action == "registered")
     {
      if(StringFind(json, "\"ok\":false") >= 0)
        {
         Print("AurumBridge: registration REJECTED: ", JStr(json, "error"));
         Disconnect("rejected");
         g_nextReconnect = TimeLocal() + 10;
        }
     }
  }

void StreamTicks()
  {
   int n = ArraySize(g_symbols);
   if(n == 0) return;
   string batch = "";
   int cnt = 0;
   MqlTick tk;
   for(int i = 0; i < n; i++)
     {
      if(!SymbolInfoTick(g_symbols[i], tk)) continue;
      if(tk.bid <= 0 || tk.ask <= 0) continue;
      if(tk.time_msc == g_lastMsc[i] && tk.bid == g_lastBid[i] && tk.ask == g_lastAsk[i]) continue;
      g_lastMsc[i] = tk.time_msc; g_lastBid[i] = tk.bid; g_lastAsk[i] = tk.ask;
      int digits = (int)SymbolInfoInteger(g_symbols[i], SYMBOL_DIGITS);
      batch += (cnt > 0 ? "," : "") + "[\"" + Esc(g_symbols[i]) + "\"," + Num(tk.bid, digits) + "," + Num(tk.ask, digits) + "," + (string)tk.time_msc + "]";
      cnt++;
     }
   if(cnt > 0 && !WsSend("{\"action\":\"ticks\",\"t\":[" + batch + "]}")) Disconnect("send failed");
  }

//+------------------------------------------------------------------+
//| Lifecycle                                                        |
//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringLen(AuthToken) == 0) Print("AurumBridge: AuthToken is empty - copy it from Aurum.");
   if(EnableTrading && !IsDemo() && !AllowLive) Print("AurumBridge: LIVE account detected; trading stays refused (AllowLive=false).");
   MathSrand((int)(GetTickCount64() & 0x7FFFFFFF) ^ (int)AccountInfoInteger(ACCOUNT_LOGIN));
   EventSetMillisecondTimer(MathMax(1, TimerMs));
   Connect();
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   if(g_sock != INVALID_HANDLE) { SocketClose(g_sock); g_sock = INVALID_HANDLE; }
  }

void OnTimer()
  {
   if(!g_ready)
     {
      if(TimeLocal() >= g_nextReconnect && !Connect()) g_nextReconnect = TimeLocal() + 3;
      return;
     }
   WsPump();
   if(!g_ready) return;
   StreamTicks();
   ulong now = GetTickCount64();
   if(now - g_lastAccountMs >= 1000) { g_lastAccountMs = now; SendAccount(); }
   if(now - g_lastPosMs >= 500) { g_lastPosMs = now; SendPositions(false); }
  }

void OnTick() {}
