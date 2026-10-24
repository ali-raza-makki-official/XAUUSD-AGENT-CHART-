import os
import sys

from .mt5_feed import Mt5Feed
from .server import serve


def main() -> int:
    token = os.environ.get("AURUM_TOKEN", "")
    if len(token) < 8:
        print("AURUM_TOKEN (min 8 chars) is required", file=sys.stderr)
        return 2
    symbol = os.environ.get("AURUM_SYMBOL", "GOLD")
    port = int(os.environ.get("AURUM_PORT", "8765"))
    dev = os.environ.get("AURUM_DEV") == "1"
    feed = Mt5Feed(symbol, terminal_path=os.environ.get("AURUM_MT5_PATH") or None)
    httpd = serve(feed, token, port, dev)
    print(f"aurum-bridge listening on 127.0.0.1:{port} symbol={symbol}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
