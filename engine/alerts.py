#!/usr/bin/env python3
"""
alerts.py - evening push notification (free, via ntfy.sh) for exits and new orders.
Runs on GitHub Actions right after the nightly scan.
Inputs (environment, never printed):
  POSITIONS  JSON saved by the phone app: {"positions":[{symbol,entry_date,entry_price,qty}...]}
  NTFY_TOPIC your private ntfy topic name (a GitHub Actions *secret*)
Usage: python alerts.py --data <eod2_data> [--signals web/data/signals.json] [--dry-run] [--asof YYYY-MM-DD]
"""
import os, sys, json, argparse, urllib.request
import pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swing_core as core

ap = argparse.ArgumentParser()
ap.add_argument("--data", required=True)
ap.add_argument("--signals", default=None)
ap.add_argument("--asof", default=None)
ap.add_argument("--dry-run", action="store_true")
a = ap.parse_args()

topic = os.environ.get("NTFY_TOPIC", "").strip()
raw = os.environ.get("POSITIONS", "").strip()
if not topic and not a.dry_run:
    sys.exit("NTFY_TOPIC secret not set - no alert sent.")
pos = []
if raw:
    try:
        pos = json.loads(raw).get("positions", [])
    except Exception as e:
        print("POSITIONS could not be read:", type(e).__name__)

cfg = dict(core.DEFAULTS)
dfs = core.load_universe(a.data, pd.Timestamp(a.asof) if a.asof else None)
last = max(d.index[-1] for d in dfs.values())
age = 0 if a.asof else (pd.Timestamp.today().normalize() - last).days

lines, urgent = [], False
if age > 4:
    lines.append(f"DATA IS {age} DAYS OLD (last close {last.date()}) - NSE sync failed, do not trade on signals.")
    urgent = True
for p in pos:
    t = core.track(p, dfs, cfg)
    sym = str(p["symbol"]).upper()
    if t["signal"] in ("SELL NEXT OPEN", "STOP HIT"):
        urgent = True
        lines.append(f"EXIT {sym}: {t['signal']} - {t['reason']} (P&L {t['pnl_pct']}%)")
    elif t["signal"] in ("CHECK", "NO DATA"):
        lines.append(f"CHECK {sym}: {t['reason']}")
holds = sum(1 for p in pos if core.track(p, dfs, cfg)["signal"] == "HOLD")
msg_head = f"Data {last.date()} | holding {holds}/{cfg['slots']}"
n_orders = 0
if a.signals and os.path.exists(a.signals):
    o = json.load(open(a.signals)).get("orders", [])
    held = {str(p["symbol"]).upper() for p in pos}
    new = [x for x in o if x["symbol"] not in held][: max(0, cfg["slots"] - holds)][: cfg["orders"]]
    n_orders = len(new)
    if new:
        lines.append(f"{n_orders} new limit orders ready: " + ", ".join(f"{x['symbol']} {x['limit']}" for x in new[:6]) + (" ..." if n_orders > 6 else ""))
if not lines:
    lines.append("No exits due. Nothing to sell tomorrow.")
body = msg_head + "\n" + "\n".join(lines)
title = "SELL tomorrow's open" if urgent and any(l.startswith("EXIT") for l in lines) else "Swing Tracker"
print(title, "\n" + body)
if a.dry_run:
    sys.exit(0)
req = urllib.request.Request("https://ntfy.sh/" + topic, data=body.encode("utf-8"), method="POST",
                             headers={"Title": title, "Priority": "high" if urgent else "default", "Tags": "chart_with_downwards_trend" if urgent else "bar_chart"})
with urllib.request.urlopen(req, timeout=30) as r:
    print("ntfy status", r.status)
