/* logic.js - pure functions (no DOM). Used by the app and by the node tests. */
(function (root) {
  const PRESETS = {
    tested: { name: 'Tested setup (6 x ATR10 stop, 7 sessions, 5-SMA or RSI2>65)', stopMult: 6, atrKey: 'a10', atrAt: 'signal', maxHold: 7, rsiExit: true, stopIntraday: true },
    mine:   { name: 'Your rules (8 x ATR14 close stop, 10 sessions, 5-SMA)', stopMult: 8, atrKey: 'a14', atrAt: 'entry', maxHold: 10, rsiExit: false, stopIntraday: false }
  };
  const COST_RT = 0.0035;

  const num = (x) => (x === null || x === undefined || isNaN(x) ? null : +x);
  const r2 = (x) => Math.round(x * 100) / 100;
  const round05 = (x) => Math.round(x / 0.05) * 0.05;

  function limitPrice(close, pct) { return r2(round05(close * (1 - (pct == null ? 0.05 : pct)))); }

  // ATR used for the stop of a position/order, given the bars of the stock and the index of the entry day
  function atrFor(preset, b, entryIdx) {
    const i = preset.atrAt === 'entry' ? entryIdx : entryIdx - 1;
    return i >= 0 ? num(b[preset.atrKey][i]) : null;
  }

  // stop shown on the ORDER (before the fill): uses the signal bar = last bar, limit as the assumed entry
  function orderStop(preset, order) {
    const atr = preset.atrKey === 'a10' ? order.atr10 : order.atr14;
    return r2(order.limit - preset.stopMult * atr);
  }

  function qtyFor(capital, slots, price) { return Math.floor((capital / slots) / price); }

  // Track one open position against the published bars. pos: {symbol, entry_date, entry_price, qty}
  function track(pos, bars, preset) {
    const b = bars[pos.symbol];
    const out = { sessions: null, last_close: null, sma5: null, rsi2: null, stop: null, pnl_pct: null, signal: 'NO DATA', reason: 'stock not in data' };
    if (!b) return out;
    const ei = b.d.indexOf(pos.entry_date);
    if (ei < 0) { out.signal = 'CHECK'; out.reason = 'entry date ' + pos.entry_date + ' not in the last ' + b.d.length + ' sessions of data'; return out; }
    const li = b.d.length - 1;
    const atr = atrFor(preset, b, ei);
    if (atr == null) { out.signal = 'CHECK'; out.reason = 'ATR not available'; return out; }
    const stop = pos.entry_price - preset.stopMult * atr;
    const sess = li - ei + 1, c = b.c[li], s5 = num(b.s5[li]), rsi = num(b.r2[li]);
    Object.assign(out, { sessions: sess, last_close: c, sma5: s5, rsi2: rsi, stop: r2(stop), pnl_pct: r2(100 * (c / pos.entry_price - 1)) });
    // does a stop breach exist since entry?
    let hit = null;
    for (let i = ei; i <= li; i++) {
      const px = preset.stopIntraday ? b.l[i] : b.c[i];
      if (px != null && px <= stop) { hit = b.d[i]; break; }
    }
    const target = [];
    if (s5 != null && c > s5) target.push('close ' + c + ' > 5-SMA ' + s5);
    if (preset.rsiExit && rsi != null && rsi > 65) target.push('RSI(2) ' + Math.round(rsi) + ' > 65');
    if (preset.stopIntraday) {                      // stop first (intraday protection), then target, then time
      if (hit) { out.signal = 'STOP HIT'; out.reason = 'low touched stop ' + r2(stop) + ' on ' + hit + ' - exit at the open'; return out; }
      if (target.length) { out.signal = 'SELL NEXT OPEN'; out.reason = target.join('; '); return out; }
    } else {                                        // user priority: target -> stop -> time
      if (target.length) { out.signal = 'SELL NEXT OPEN'; out.reason = target.join('; '); return out; }
      if (hit) { out.signal = 'STOP HIT'; out.reason = 'close at/below stop ' + r2(stop) + ' on ' + hit + ' - sell at next open'; return out; }
    }
    if (sess >= preset.maxHold) { out.signal = 'SELL NEXT OPEN'; out.reason = 'session ' + sess + ': time exit'; return out; }
    out.signal = 'HOLD'; out.reason = 'time exit after session ' + preset.maxHold + ' (now ' + sess + ')';
    return out;
  }

  // Did a limit order placed after the close of `signal_date` fill on the next session? Returns null while the next session is not in the data.
  function resolveOrder(order, bars) {
    const b = bars[order.symbol];
    if (!b) return { status: 'UNKNOWN', note: 'stock not in data' };
    let i = b.d.findIndex((d) => d > order.signal_date);
    if (i < 0) return null;
    const low = b.l[i], open = b.o[i];
    if (low <= order.limit) return { status: 'FILLED', date: b.d[i], price: r2(Math.min(open, order.limit)), note: 'low ' + low + ' <= limit ' + order.limit };
    return { status: 'EXPIRED', date: b.d[i], note: 'low ' + low + ' never reached limit ' + order.limit };
  }

  function basketOrders(orders, tag) {
    return orders.map((o) => ({ variety: 'regular', exchange: 'NSE', tradingsymbol: o.symbol, transaction_type: o.side || 'BUY',
      order_type: o.type || 'LIMIT', quantity: o.qty, product: 'CNC', validity: 'DAY', ...(o.type === 'MARKET' ? {} : { price: o.price }), tag: (tag || 'swing').slice(0, 20) }));
  }

  function tradeStats(closed, cost) {
    cost = cost == null ? COST_RT : cost;
    const t = closed.map((c) => {
      const gross = c.exit_price / c.entry_price - 1, net = gross - cost;
      const val = c.entry_price * c.qty;
      return { ...c, gross_pct: 100 * gross, net_pct: 100 * net, pnl_gross: (c.exit_price - c.entry_price) * c.qty, pnl_net: (c.exit_price - c.entry_price) * c.qty - cost * val };
    });
    const wins = t.filter((x) => x.pnl_net > 0), losses = t.filter((x) => x.pnl_net <= 0);
    const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
    const gw = sum(wins, (x) => x.pnl_net), gl = -sum(losses, (x) => x.pnl_net);
    const sorted = [...t].sort((a, b) => (a.exit_date < b.exit_date ? -1 : 1));
    let cum = 0; const curve = sorted.map((x) => ({ date: x.exit_date, v: (cum += x.pnl_net) }));
    let peak = 0, dd = 0; curve.forEach((p) => { peak = Math.max(peak, p.v); dd = Math.min(dd, p.v - peak); });
    const months = {}; sorted.forEach((x) => { const m = x.exit_date.slice(0, 7); months[m] = (months[m] || 0) + x.pnl_net; });
    return { n: t.length, win: t.length ? 100 * wins.length / t.length : 0, avg_net_pct: t.length ? sum(t, (x) => x.net_pct) / t.length : 0,
      pnl_net: sum(t, (x) => x.pnl_net), pnl_gross: sum(t, (x) => x.pnl_gross), pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : 0),
      best: t.length ? Math.max(...t.map((x) => x.net_pct)) : 0, worst: t.length ? Math.min(...t.map((x) => x.net_pct)) : 0,
      curve, max_dd: dd, months, rows: sorted };
  }

  root.SwingLogic = { PRESETS, COST_RT, limitPrice, atrFor, orderStop, qtyFor, track, resolveOrder, basketOrders, tradeStats, r2 };
})(typeof window !== 'undefined' ? window : module.exports);
