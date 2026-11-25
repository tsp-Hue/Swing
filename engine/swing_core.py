"""
swing_core.py - engine of the RSI(2) pullback swing app (no GUI code here).

Rules (all on DAILY data; signal at the close, orders for the NEXT session)
  Universe : NSE equities, 60-day avg traded value >= Rs10 crore, price >= Rs100
  Signal   : close > 200-DMA AND 2-day cumulative RSI(2) < 35   (no Nifty filter)
  Ranking  : highest RS rank first (3/6/9/12-month composite), top N orders
  Entry    : LIMIT BUY 5% below the signal close, valid ONE session
  Stop     : fill - 6 x ATR(10)   (intraday)
  Exit     : at the next open after close > 5-day SMA OR RSI(2) > 65, or after the 7th session
"""
import os, json, datetime as dt
import numpy as np, pandas as pd

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(APP_DIR, "swing_state.json")
SETTINGS_FILE = os.path.join(APP_DIR, "settings.json")
EXCEL_FILE = os.path.join(APP_DIR, "swing_tracker.xlsx")
EOD2_DIR = os.path.join(APP_DIR, "eod2")
DEFAULT_DATA = os.path.join(EOD2_DIR, "src", "eod2_data")

DEFAULTS = dict(capital=100000.0, slots=8, orders=8, stop_atr=6.0, limit_pct=0.05, max_hold=7,
                min_adtv_cr=25.0, min_price=100.0, auto_run=True, data_dir=DEFAULT_DATA)

RULES_TEXT = [
    "UNIVERSE : NSE equities, 60-day avg traded value >= Rs25 crore (setting), price >= Rs100",
    "SIGNAL   : close > 200-DMA  AND  2-day cumulative RSI(2) < 35   (no Nifty filter)",
    "RANKING  : highest RS rank first (3/6/9/12-month composite); top N orders per day",
    "ENTRY    : LIMIT BUY 5% below the signal close, valid ONE session only (Day order). Most orders will not fill - normal.",
    "STOP     : fill price - 6 x ATR(10), intraday",
    "EXIT     : sell at the NEXT OPEN after (close > 5-day SMA) or (RSI(2) > 65), or after the 7th session (entry day = session 1)",
    "SIZING   : capital / slots per position. If more orders fill than free slots keep the highest ranks, sell the extras at open.",
]


# ----------------------------------------------------------------------------- settings / state
def load_settings():
    s = dict(DEFAULTS)
    if os.path.exists(SETTINGS_FILE):
        try:
            s.update(json.load(open(SETTINGS_FILE)))
        except Exception:
            pass
    return s


def save_settings(s):
    json.dump(s, open(SETTINGS_FILE, "w"), indent=2)


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            st = json.load(open(STATE_FILE))
            for k in ("positions", "closed", "orders"):
                st.setdefault(k, [])
            return st
        except Exception:
            pass
    return {"positions": [], "closed": [], "orders": []}


def save_state(st):
    tmp = STATE_FILE + ".tmp"
    json.dump(st, open(tmp, "w"), indent=1, default=str)
    os.replace(tmp, STATE_FILE)


# ----------------------------------------------------------------------------- data + indicators
def wil(s, n):
    return s.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()


def load_universe(data_dir, asof=None, log=print):
    daily = os.path.join(data_dir, "daily")
    if not os.path.isdir(daily):
        raise RuntimeError(f"Data folder not found: {daily}\nRun the data sync first (or check Settings > data folder).")
    mp = os.path.join(data_dir, "isin_symbol_map.json")
    ok = None
    if os.path.exists(mp):
        m = json.load(open(mp)).get("sym2isin", {})
        ok = {s.lower() for s, i in m.items() if str(i).startswith("INE")}
    else:
        log("WARNING: isin_symbol_map.json not found - indices/ETFs may slip in.")
    dfs = {}
    for f in os.listdir(daily):
        if not f.endswith(".csv"):
            continue
        s = f[:-4].lower()
        if ok is not None and s not in ok:
            continue
        if ok is None and (s.startswith("nifty") or "bees" in s or s.endswith("etf") or s.startswith("sect")):
            continue
        try:
            d = pd.read_csv(os.path.join(daily, f), usecols=["Date", "Open", "High", "Low", "Close", "Volume"], parse_dates=["Date"])
        except Exception:
            continue
        d = d.dropna().set_index("Date")
        d = d[(d.Close > 0) & (d.High >= d.Low)]
        d = d[~d.index.duplicated()].sort_index()
        if asof is not None:
            d = d[d.index <= asof]
        d = d.tail(420)
        if len(d) >= 30:
            dfs[s] = d
    return dfs


def indicators(d):
    c, h, l = d.Close, d.High, d.Low
    pc = c.shift(1)
    tr = pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)
    d1 = c.diff()
    au, ad = wil(d1.clip(lower=0), 2), wil((-d1).clip(lower=0), 2)
    rsi2 = (100 - 100 / (1 + au / ad)).where(ad != 0, 100.0)
    return pd.DataFrame({"atr": wil(tr, 10), "rsi2": rsi2, "sma5": c.rolling(5).mean(), "sma200": c.rolling(200).mean()})


def nifty_status(data_dir, last):
    f = os.path.join(data_dir, "daily", "niftybees.csv")
    try:
        nb = pd.read_csv(f, usecols=["Date", "Close"], parse_dates=["Date"]).set_index("Date").Close
        nb = nb[nb.index <= last]
        return bool(nb.iloc[-1] > nb.rolling(200).mean().iloc[-1])
    except Exception:
        return None


# ----------------------------------------------------------------------------- scan
def scan(dfs, last, cfg):
    comp = {}
    for s, d in dfs.items():
        if d.index[-1] != last or len(d) < 253:
            continue
        c = d.Close
        comp[s] = (0.4 * (c.iloc[-1] / c.iloc[-64] - 1) + 0.2 * (c.iloc[-1] / c.iloc[-127] - 1)
                   + 0.2 * (c.iloc[-1] / c.iloc[-190] - 1) + 0.2 * (c.iloc[-1] / c.iloc[-253] - 1))
    rs = pd.Series(comp).rank(pct=True)
    rows = []
    for s, d in dfs.items():
        if d.index[-1] != last or len(d) < 253:
            continue
        c, v = d.Close, d.Volume
        px = c.iloc[-1]
        adtv = (c * v).iloc[-61:-1].mean()
        if adtv < cfg.get("min_adtv_cr", 25.0) * 1e7 or px < cfg.get("min_price", 100.0):
            continue
        if (c.pct_change().abs().iloc[-60:] > 0.40).any():       # probable unadjusted corporate action
            continue
        ind = indicators(d)
        crsi = ind.rsi2.iloc[-1] + ind.rsi2.iloc[-2]
        if not (px > ind.sma200.iloc[-1] and crsi < 35):
            continue
        lim = round(px * (1 - cfg["limit_pct"]) / 0.05) * 0.05
        atr = ind.atr.iloc[-1]
        rows.append(dict(symbol=s, close=px, limit=round(lim, 2), atr=atr, stop=round(lim - cfg["stop_atr"] * atr, 2),
                         cum_rsi2=crsi, rs_rank=100 * rs.get(s, np.nan), pct_above_200dma=100 * (px / ind.sma200.iloc[-1] - 1),
                         adtv_cr=adtv / 1e7))
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    out = out.sort_values(["rs_rank", "cum_rsi2"], ascending=[False, True]).reset_index(drop=True)
    return out


# ----------------------------------------------------------------------------- position tracking
def track(pos, dfs, cfg):
    """pos: dict(symbol, entry_date 'YYYY-MM-DD', entry_price, qty). Returns tracking fields."""
    base = dict(sessions=None, last_close=None, sma5=None, rsi2=None, stop=None, pnl_pct=None, signal="", reason="")
    s = str(pos["symbol"]).strip().lower()
    if s not in dfs:
        base.update(signal="NO DATA", reason="symbol not found in data"); return base
    d = dfs[s]
    ed = pd.Timestamp(pos["entry_date"])
    if ed not in d.index:
        base.update(signal="CHECK", reason=f"entry date {ed.date()} is not a trading day in the data"); return base
    ind = indicators(d)
    i_e = d.index.get_loc(ed); last = len(d) - 1
    atr_sig = ind.atr.iloc[max(i_e - 1, 0)]
    ep = float(pos["entry_price"])
    stop = ep - cfg["stop_atr"] * atr_sig
    sess = last - i_e + 1
    c = float(d.Close.iloc[last])
    base.update(sessions=int(sess), last_close=round(c, 2), sma5=round(float(ind.sma5.iloc[last]), 2), rsi2=round(float(ind.rsi2.iloc[last]), 1),
                stop=round(float(stop), 2), pnl_pct=round(100 * (c / ep - 1), 1))
    lows = d.Low.iloc[i_e:]
    if (lows <= stop).any():
        base.update(signal="STOP HIT", reason=f"low touched stop {stop:.2f} on {lows[lows <= stop].index[0].date()} - exit now / at open")
        return base
    why = []
    if c > ind.sma5.iloc[last]: why.append(f"close {c:.2f} > 5-SMA {ind.sma5.iloc[last]:.2f}")
    if ind.rsi2.iloc[last] > 65: why.append(f"RSI(2) {ind.rsi2.iloc[last]:.0f} > 65")
    if sess >= cfg["max_hold"]: why.append(f"session {sess}: time stop")
    if why:
        base.update(signal="SELL NEXT OPEN", reason="; ".join(why))
    else:
        base.update(signal="HOLD", reason=f"time stop after session {cfg['max_hold']} (now {sess})")
    return base


# ----------------------------------------------------------------------------- pipeline
def run_scan_track(state, cfg, asof=None, log=print):
    """Load data, resolve yesterday's orders, track positions, scan tonight. Mutates and returns state; returns result dict."""
    asof_ts = pd.Timestamp(asof) if asof else None
    dfs = load_universe(cfg["data_dir"], asof_ts, log)
    if not dfs:
        raise RuntimeError("No stock data loaded.")
    last = max(d.index[-1] for d in dfs.values())
    age = (pd.Timestamp(dt.date.today()) - last).days if asof_ts is None else 0
    log(f"Data date (last close): {last.date()}   symbols loaded: {len(dfs)}")
    warn = None
    if age > 4:
        warn = f"Data is {age} days old (last close {last.date()}). The data sync did not bring in recent days - do NOT trade these signals until the sync works."
        log("*** WARNING: " + warn)
    msgs = []

    # 1) resolve pending orders from earlier signal dates (estimate fills from the data)
    slots = int(cfg["slots"])
    n_open = len(state["positions"])
    pend = [o for o in state["orders"] if o["status"] == "PENDING" and pd.Timestamp(o["signal_date"]) < last]
    pend.sort(key=lambda o: (o["signal_date"], o["rank"]))
    for o in pend:
        s = o["symbol"].lower()
        if s not in dfs:
            o["status"], o["note"] = "UNKNOWN", "no data"; continue
        d = dfs[s]
        nxt = d.index[d.index > pd.Timestamp(o["signal_date"])]
        if len(nxt) == 0:
            continue
        nd = nxt[0]; bar = d.loc[nd]
        if bar.Low <= o["limit"]:
            fill = min(float(bar.Open), float(o["limit"]))
            if n_open < slots:
                qty = int((cfg["capital"] / slots) // fill)
                state["positions"].append(dict(symbol=o["symbol"], entry_date=str(nd.date()), entry_price=round(fill, 2), qty=qty,
                                               source="auto (estimated fill)"))
                n_open += 1
                o["status"], o["note"] = "FILLED (est.)", f"low {bar.Low:.2f} <= limit; est. fill {fill:.2f} on {nd.date()} - confirm with your broker"
                msgs.append(f"{o['symbol']}: order probably FILLED on {nd.date()} at ~{fill:.2f}. Added to Positions - please confirm with your broker.")
            else:
                o["status"], o["note"] = "FILLED but slots full", f"low {bar.Low:.2f} <= limit on {nd.date()}; if filled, sell at next open"
                msgs.append(f"{o['symbol']}: may have FILLED but all {slots} slots are full - if your broker filled it, sell at the next open.")
        else:
            o["status"], o["note"] = "EXPIRED", f"low {bar.Low:.2f} never reached limit {o['limit']} on {nd.date()}"

    # 2) track positions
    tracked = []
    for p in state["positions"]:
        t = track(p, dfs, cfg)
        tracked.append({**p, **t})
    n_hold = sum(1 for t in tracked if t["signal"] == "HOLD")
    free = max(slots - n_hold, 0)

    # 3) tonight's scan
    cand = scan(dfs, last, cfg)
    per = cfg["capital"] / slots
    held = {t["symbol"].lower() for t in tracked}
    n_total = len(cand)
    if len(cand):
        cand = cand[~cand.symbol.isin(held) & (cand["limit"] <= per)].reset_index(drop=True)
    n_ord = min(int(cfg["orders"]), len(cand)) if free > 0 else 0
    orders = cand.head(n_ord).copy()
    rows = []
    if len(orders):
        state["orders"] = [o for o in state["orders"] if not (o["signal_date"] == str(last.date()) and o["status"] == "PENDING")]
        for i, r in enumerate(orders.itertuples(), 1):
            qty = int(per // r.limit)
            rows.append(dict(rank=i, symbol=r.symbol.upper(), signal_close=round(r.close, 2), buy_limit=r.limit, stop_loss=r.stop, qty=qty,
                             amount_rs=round(qty * r.limit), cum_rsi2=round(r.cum_rsi2, 1), rs_rank=round(r.rs_rank, 1),
                             pct_above_200dma=round(r.pct_above_200dma, 1), adtv_cr=round(r.adtv_cr, 1)))
            state["orders"].append(dict(signal_date=str(last.date()), symbol=r.symbol.upper(), rank=i, limit=r.limit, stop=r.stop,
                                        atr=round(float(r.atr), 3), status="PENDING", note=""))
    nif = nifty_status(cfg["data_dir"], last)
    state["last_run"] = dict(data_date=str(last.date()), run_at=dt.datetime.now().strftime("%Y-%m-%d %H:%M"), free=free,
                             candidates=n_total, nifty_above_200=nif)
    res = dict(last=last, free=free, slots=slots, candidates=n_total, orders=rows, positions=tracked, msgs=msgs, warn=warn, nifty=nif)
    return res


# ----------------------------------------------------------------------------- excel export
def export_excel(state, res, path=EXCEL_FILE):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    hdr_fill = PatternFill("solid", fgColor="1F3864")

    def hdr(ws, row=1):
        for c in ws[row]:
            c.font = Font(bold=True, color="FFFFFF"); c.fill = hdr_fill
            c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)

    def widths(ws, mn=10, mx=60):
        for i, col in enumerate(ws.columns, 1):
            w = max((len(str(c.value)) if c.value is not None else 0) for c in col[:60])
            ws.column_dimensions[get_column_letter(i)].width = min(max(mn, w + 2), mx)

    wb = Workbook(); ws = wb.active; ws.title = "Orders"
    last = res["last"].date()
    ws.append([f"ORDERS for the next session after {last}  |  free slots: {res['free']} of {res['slots']}  |  candidates today: {res['candidates']}"])
    ws["A1"].font = Font(bold=True, size=12); ws.append([])
    cols = ["rank", "symbol", "signal_close", "buy_limit", "stop_loss", "qty", "amount_rs", "cum_rsi2", "rs_rank", "pct_above_200dma", "adtv_cr"]
    if res["orders"]:
        ws.append(cols)
        for r in res["orders"]:
            ws.append([r[c] for c in cols])
        hdr(ws, 3)
        for i in range(1, len(cols) + 1):
            ws.column_dimensions[get_column_letter(i)].width = 17
        ws.freeze_panes = "A4"
    else:
        ws.append(["No new orders tonight" + (" (all slots full)" if res["free"] == 0 else " (no stock passed the scan)")])
    ws.append([])
    ws.append(["Place one-day LIMIT BUY orders (validity: Day) at buy_limit. Most will not fill - that is normal. Do not chase the next day."])
    ws.append(["stop_loss = buy_limit - ATR multiple x ATR(10); recomputed from your actual fill in Positions."])
    ws.append(["Check results / ex-dates / block deals / news before placing orders."])
    for m in res["msgs"]:
        ws.append([m])

    ws2 = wb.create_sheet("Positions")
    pc = ["symbol", "entry_date", "entry_price", "qty", "source", "sessions", "last_close", "sma5", "rsi2", "stop", "pnl_pct", "signal", "reason"]
    ws2.append(pc)
    fills = {"SELL NEXT OPEN": "F8CBAD", "STOP HIT": "FF7C80", "HOLD": "E2EFDA", "NO DATA": "FFE699", "CHECK": "FFE699"}
    for p in res["positions"]:
        ws2.append([p.get(c) for c in pc])
    hdr(ws2); widths(ws2); ws2.freeze_panes = "A2"
    si = pc.index("signal") + 1
    for row in ws2.iter_rows(min_row=2):
        v = row[si - 1].value
        if v in fills:
            row[si - 1].fill = PatternFill("solid", fgColor=fills[v]); row[si - 1].font = Font(bold=True)

    ws3 = wb.create_sheet("Closed")
    cc = ["symbol", "entry_date", "entry_price", "qty", "exit_date", "exit_price", "gross_pct", "pnl_rs", "sessions_held"]
    ws3.append(cc)
    for r in state["closed"]:
        ws3.append([r.get(c) for c in cc])
    hdr(ws3); widths(ws3); ws3.freeze_panes = "A2"

    ws4 = wb.create_sheet("OrderLog")
    oc = ["signal_date", "symbol", "rank", "limit", "stop", "atr", "status", "note"]
    ws4.append(oc)
    for r in state["orders"]:
        ws4.append([r.get(c) for c in oc])
    hdr(ws4); widths(ws4); ws4.freeze_panes = "A2"

    ws5 = wb.create_sheet("Rules")
    for line in RULES_TEXT:
        ws5.append([line])
    ws5.column_dimensions["A"].width = 140
    try:
        tmp = path + ".tmp"; wb.save(tmp); os.replace(tmp, path)
        return path
    except PermissionError:
        alt = os.path.splitext(path)[0] + "_" + dt.datetime.now().strftime("%H%M%S") + ".xlsx"
        wb.save(alt)
        return alt


# ----------------------------------------------------------------------------- manual position edits
def mark_sold(state, idx, exit_date, exit_price, dfs_hint=None):
    p = state["positions"].pop(idx)
    g = 100 * (float(exit_price) / float(p["entry_price"]) - 1)
    held = None
    try:
        held = int(np.busday_count(p["entry_date"], exit_date))
    except Exception:
        pass
    state["closed"].append(dict(symbol=p["symbol"], entry_date=p["entry_date"], entry_price=p["entry_price"], qty=p.get("qty"),
                                exit_date=str(exit_date), exit_price=float(exit_price), gross_pct=round(g, 2),
                                pnl_rs=round((float(exit_price) - float(p["entry_price"])) * float(p.get("qty") or 0)), sessions_held=held))
    return state
