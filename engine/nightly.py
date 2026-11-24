#!/usr/bin/env python3
"""
nightly.py - runs on GitHub Actions every evening (after EOD2 has synced the NSE data).
Scans the market and writes web/data/signals.json for the phone app:
  orders : ranked candidates for tomorrow (RS rank first), with the buy-limit 5% below the close
  bars   : last 18 daily bars (+ SMA5, RSI2, ATR10, ATR14) for every reasonably liquid stock, so the phone can track
           your own positions and compute the exit signals locally (your portfolio never leaves your phone).
Usage: python nightly.py --data <eod2_data folder> --out ../web/data [--asof YYYY-MM-DD]
"""
import os, sys, json, argparse, datetime as dt
import numpy as np, pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import swing_core as core

ap = argparse.ArgumentParser()
ap.add_argument("--data", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--asof", default=None)
ap.add_argument("--max-orders", type=int, default=30)
ap.add_argument("--bars", type=int, default=18)
a = ap.parse_args()

cfg = dict(core.DEFAULTS); cfg["data_dir"] = a.data
asof = pd.Timestamp(a.asof) if a.asof else None
dfs = core.load_universe(a.data, asof)
last = max(d.index[-1] for d in dfs.values())
age = (pd.Timestamp(dt.date.today()) - last).days if asof is None else 0
print(f"data date {last.date()} | {len(dfs)} symbols | age {age} d")

cand = core.scan(dfs, last, cfg)
orders = []
for i, r in enumerate(cand.head(a.max_orders).itertuples(), 1):
    d = dfs[r.symbol]; ind = core.indicators(d)
    pc = d.Close.shift(1)
    tr = pd.concat([d.High - d.Low, (d.High - pc).abs(), (d.Low - pc).abs()], axis=1).max(axis=1)
    atr14 = core.wil(tr, 14).iloc[-1]
    orders.append(dict(rank=i, symbol=r.symbol.upper(), close=round(float(r.close), 2), limit=float(r.limit), atr10=round(float(r.atr), 3),
                       atr14=round(float(atr14), 3), rs_rank=round(float(r.rs_rank), 1), cum_rsi2=round(float(r.cum_rsi2), 1),
                       pct_above_200dma=round(float(r.pct_above_200dma), 1), adtv_cr=round(float(r.adtv_cr), 1)))

bars = {}
for s, d in dfs.items():
    if d.index[-1] < last - pd.Timedelta(days=10) or len(d) < 40:
        continue
    adtv = (d.Close * d.Volume).iloc[-61:-1].mean()
    if adtv < 5e7 or d.Close.iloc[-1] < 50:
        continue
    ind = core.indicators(d)
    pc = d.Close.shift(1)
    tr = pd.concat([d.High - d.Low, (d.High - pc).abs(), (d.Low - pc).abs()], axis=1).max(axis=1)
    a14 = core.wil(tr, 14)
    t = d.tail(a.bars)
    r2 = lambda x: [None if pd.isna(v) else round(float(v), 2) for v in x]
    bars[s.upper()] = dict(d=[x.strftime("%Y-%m-%d") for x in t.index], o=r2(t.Open), h=r2(t.High), l=r2(t.Low), c=r2(t.Close),
                           s5=r2(ind.sma5.loc[t.index]), r2=r2(ind.rsi2.loc[t.index]), a10=r2(ind.atr.loc[t.index]), a14=r2(a14.loc[t.index]))

cal = sorted({x for b in bars.values() for x in b["d"]})[-a.bars:]
out = dict(meta=dict(version=1, data_date=str(last.date()), generated_at=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                     stale=bool(age > 4), age_days=int(age), symbols=len(dfs), tracked=len(bars), candidates=int(len(cand)),
                     nifty_above_200=core.nifty_status(a.data, last), calendar=cal),
           orders=orders, bars=bars)
os.makedirs(a.out, exist_ok=True)
p = os.path.join(a.out, "signals.json")
json.dump(out, open(p, "w"), separators=(",", ":"))
print(f"wrote {p}  ({os.path.getsize(p)/1e6:.2f} MB): {len(orders)} orders of {len(cand)} candidates, {len(bars)} stocks tracked")
if age > 4:
    print("WARNING: data is stale - NSE sync probably failed", file=sys.stderr)
