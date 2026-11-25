/* Swing Tracker - phone app. All personal data (positions, trades, settings) stays in this browser's storage. */
(function () {
  const L = window.SwingLogic;
  const KEY = 'swing.v1', SIGKEY = 'swing.signals';
  const DEF = { settings: { capital: 100000, slots: 8, orders: 8, preset: 'tested', apiKey: '', dataUrl: 'data/signals.json', costPct: 0.35, ghRepo: '', ghToken: '', ntfyTopic: '' }, positions: [], closed: [], orderLog: [] };
  let S = load(), DATA = null, TRACK = [];
  const $ = (id) => document.getElementById(id);
  const inr = (x) => (x < 0 ? '-' : '') + '₹' + Math.abs(Math.round(x)).toLocaleString('en-IN');
  const pct = (x) => (x > 0 ? '+' : '') + x.toFixed(1) + '%';
  const cls = (x) => (x > 0 ? 'good' : x < 0 ? 'bad' : '');
  const today = () => new Date().toISOString().slice(0, 10);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const preset = () => L.PRESETS[S.settings.preset] || L.PRESETS.tested;

  function load() {
    try { const j = JSON.parse(localStorage.getItem(KEY)); if (j) return { ...DEF, ...j, settings: { ...DEF.settings, ...(j.settings || {}) } }; } catch (e) {}
    return JSON.parse(JSON.stringify(DEF));
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { alert('Could not save: ' + e.message); } scheduleSync(); }

  // ---------- exit-alert sync: open positions -> private GitHub Actions variable, read by the nightly job which sends the ntfy push
  let syncT = null, syncMsg = '';
  function scheduleSync() { clearTimeout(syncT); syncT = setTimeout(() => syncAlerts(true), 1500); }
  async function syncAlerts(quiet) {
    const st = S.settings;
    if (!st.ghRepo || !st.ghToken) { syncMsg = 'not set up'; return; }
    const payload = JSON.stringify({ updated: new Date().toISOString(), positions: S.positions.map((p) => ({ symbol: p.symbol, entry_date: p.entry_date, entry_price: p.entry_price, qty: p.qty })) });
    const base = 'https://api.github.com/repos/' + st.ghRepo.replace(/^\/+|\/+$/g, '') + '/actions/variables';
    const hdr = { Authorization: 'Bearer ' + st.ghToken, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
    try {
      let r = await fetch(base + '/POSITIONS', { method: 'PATCH', headers: hdr, body: JSON.stringify({ name: 'POSITIONS', value: payload }) });
      if (r.status === 404) r = await fetch(base, { method: 'POST', headers: hdr, body: JSON.stringify({ name: 'POSITIONS', value: payload }) });
      if (!r.ok) throw new Error('GitHub said ' + r.status + (r.status === 401 || r.status === 403 ? ' (check the token and its "Variables: read and write" permission)' : ''));
      syncMsg = 'synced ' + new Date().toLocaleTimeString();
      if (!quiet) alert('Alerts synced: ' + S.positions.length + ' open position(s) sent.');
    } catch (e) { syncMsg = 'failed: ' + e.message; if (!quiet) alert('Sync failed: ' + e.message); }
    const el = document.getElementById('syncStatus'); if (el) el.textContent = syncMsg;
  }

  // ---------- dialog helper
  function ask(title, fields, okText) {
    return new Promise((res) => {
      $('dlgTitle').textContent = title; $('dlgOk').textContent = okText || 'OK';
      $('dlgFields').innerHTML = fields.map((f) => `<label>${esc(f.label)}</label><input id="f_${f.key}" type="${f.type || 'text'}" ${f.step ? 'step="' + f.step + '"' : ''} value="${esc(f.value == null ? '' : f.value)}">`).join('');
      const d = $('dlg');
      d.onclose = () => { if (d.returnValue !== 'ok') return res(null); const o = {}; fields.forEach((f) => (o[f.key] = $('f_' + f.key).value.trim())); res(o); };
      d.showModal();
    });
  }
  function confirmBox(msg) { return ask(msg, [], 'Yes'); }

  // ---------- data
  async function loadData() {
    let src = 'network';
    try {
      const r = await fetch(S.settings.dataUrl + (S.settings.dataUrl.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      DATA = await r.json();
      try { localStorage.setItem(SIGKEY, JSON.stringify(DATA)); } catch (e) {}
    } catch (e) {
      try { DATA = JSON.parse(localStorage.getItem(SIGKEY)); src = 'saved copy (offline)'; } catch (e2) { DATA = null; }
    }
    return src;
  }

  // ---------- derived state
  function latestDate() { return DATA ? DATA.meta.data_date : null; }
  function resolveOrders() {
    if (!DATA) return;
    let changed = false;
    S.orderLog.forEach((o) => {
      if (o.status !== 'PLACED') return;
      const r = L.resolveOrder(o, DATA.bars);
      if (!r) return;
      if (r.status === 'FILLED') {
        if (S.positions.some((p) => p.symbol === o.symbol && p.entry_date === r.date)) { o.status = 'FILLED'; o.note = 'in portfolio'; }
        else {
          S.positions.push({ symbol: o.symbol, entry_date: r.date, entry_price: r.price, qty: o.qty, source: 'estimated', id: Date.now() + Math.random() });
          o.status = 'FILLED (est.)'; o.note = r.note + ' - added to Portfolio as an ESTIMATE, confirm with your Kite order book';
        }
      } else { o.status = 'EXPIRED'; o.note = r.note; }
      changed = true;
    });
    if (changed) save();
  }
  function trackAll() { TRACK = DATA ? S.positions.map((p) => ({ p, t: L.track(p, DATA.bars, preset()) })) : S.positions.map((p) => ({ p, t: { signal: 'NO DATA', reason: 'no data loaded' } })); }
  const freeSlots = () => Math.max(0, S.settings.slots - TRACK.filter((x) => x.t.signal === 'HOLD' || x.t.signal === 'CHECK' || x.t.signal === 'NO DATA').length);

  // ---------- render: header / banner
  function renderHeader(src) {
    $('rules').textContent = S.settings.preset === 'mine' ? 'your rules' : 'tested rules';
    if (!DATA) { $('status').textContent = 'No data yet - check Settings > Data URL'; return; }
    const m = DATA.meta;
    $('status').textContent = `Data as of ${m.data_date}  |  ${src}  |  free slots ${freeSlots()}/${S.settings.slots}` + (m.nifty_above_200 === true ? '  |  Nifty above 200-DMA' : m.nifty_above_200 === false ? '  |  Nifty below 200-DMA' : '');
    const urgent = TRACK.filter((x) => x.t.signal === 'SELL NEXT OPEN' || x.t.signal === 'STOP HIT');
    const b = $('banner');
    if (m.stale) { b.hidden = false; b.className = 'banner warn'; b.textContent = `Data is ${m.age_days} days old (${m.data_date}). The nightly update may have failed - do not trade these signals.`; }
    else if (urgent.length) { b.hidden = false; b.className = 'banner'; b.textContent = 'EXIT at tomorrow\'s open: ' + urgent.map((x) => x.p.symbol + (x.t.signal === 'STOP HIT' ? ' (STOP)' : '')).join(', '); notify(urgent); }
    else b.hidden = true;
  }
  function notify(urgent) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const k = 'swing.notified.' + latestDate(); if (localStorage.getItem(k)) return; localStorage.setItem(k, '1');
      const body = urgent.map((x) => x.p.symbol + ': ' + x.t.signal).join('\n');
      navigator.serviceWorker.ready.then((reg) => reg.showNotification('Swing Tracker - exit signals', { body, icon: 'icons/icon-192.png' }));
    } catch (e) {}
  }

  // ---------- render: orders
  function candidates() {
    if (!DATA) return [];
    const held = new Set(S.positions.map((p) => p.symbol)), pend = new Set(S.orderLog.filter((o) => o.status === 'PLACED').map((o) => o.symbol));
    const pr = preset(), per = S.settings.capital / S.settings.slots;
    return DATA.orders.filter((o) => !held.has(o.symbol) && !pend.has(o.symbol) && o.limit <= per).map((o) => ({ ...o, qty: L.qtyFor(S.settings.capital, S.settings.slots, o.limit), stop: L.orderStop(pr, o) }));
  }
  function renderOrders() {
    const el = $('tab-orders');
    if (!DATA) { el.innerHTML = '<div class="empty">No signals loaded yet.<br>Open Settings and check the Data URL.</div>'; return; }
    const free = freeSlots(), n = free > 0 ? Math.min(S.settings.orders, free > 0 ? S.settings.orders : 0) : 0;
    const c = candidates().slice(0, n);
    let h = `<h2>Orders for the next session after ${DATA.meta.data_date}</h2><div class="mute">${DATA.meta.candidates} stocks qualified tonight · ranked by relative strength · one-day LIMIT buys 5% below the close</div>`;
    if (!c.length) h += `<div class="empty">${free === 0 ? 'All slots are full - no new orders.' : 'No new orders tonight.'}</div>`;
    c.forEach((o, i) => {
      h += `<div class="card"><div class="row"><label class="row" style="margin:0;gap:10px;align-items:center"><input type="checkbox" class="pick" data-i="${i}" checked><span class="sym">${esc(o.symbol)}</span></label><span class="mute">RS ${o.rs_rank} · RSI ${o.cum_rsi2}</span></div>
      <div class="kv"><div>BUY LIMIT<b>${o.limit}</b></div><div>STOP LOSS<b>${o.stop}</b></div><div>QTY<b>${o.qty}</b></div><div>Signal close<b>${o.close}</b></div><div>Amount<b>${inr(o.qty * o.limit)}</b></div><div>vs 200-DMA<b>+${o.pct_above_200dma}%</b></div><div>Avg turnover<b>₹${o.adtv_cr} cr/day</b></div></div></div>`;
    });
    if (c.length) h += `<div class="actions"><button class="primary" id="kiteBtn">Open in Kite (basket)</button><button class="ghost" id="copyBtn">Copy list</button></div>
      <div class="small">Kite opens with these as one-day LIMIT orders - you review and confirm there. Most won't fill (about 1 in 14) - that is normal; never chase the stock next day. After you confirm in Kite, come back here: the app will detect fills from the next day's prices.</div>`;
    el.innerHTML = h;
    const picks = () => [...el.querySelectorAll('.pick')].filter((x) => x.checked).map((x) => c[+x.dataset.i]);
    if (c.length) {
      $('copyBtn').onclick = async () => { const t = picks().map((o) => `${o.symbol} BUY ${o.qty} LIMIT ${o.limit} (stop ${o.stop})`).join('\n'); try { await navigator.clipboard.writeText(t); alert('Copied'); } catch (e) { prompt('Copy:', t); } };
      $('kiteBtn').onclick = () => {
        const sel = picks(); if (!sel.length) return alert('Select at least one order.');
        if (!S.settings.apiKey) { alert('Add your Kite Connect API key in Settings first (free "Personal" app at developers.kite.trade). Meanwhile you can use "Copy list".'); return; }
        sel.forEach((o) => S.orderLog.push({ id: Date.now() + Math.random(), signal_date: DATA.meta.data_date, symbol: o.symbol, limit: o.limit, qty: o.qty, stop: o.stop, status: 'PLACED', note: 'sent to Kite basket - confirm in Kite' }));
        save(); submitBasket(L.basketOrders(sel.map((o) => ({ symbol: o.symbol, qty: o.qty, price: o.limit })), 'swing'));
      };
    }
    // order history
    const log = S.orderLog.slice().reverse().slice(0, 40);
    if (log.length) h = '<h2>Order history</h2><div class="card"><table><tr><th>Signal</th><th>Stock</th><th>Limit</th><th>Status</th></tr>' + log.map((o) => `<tr><td>${o.signal_date.slice(5)}</td><td>${esc(o.symbol)}</td><td>${o.limit}</td><td>${esc(o.status)}</td></tr>`).join('') + '</table></div>', el.insertAdjacentHTML('beforeend', h);
  }
  function submitBasket(orders) {
    const f = document.createElement('form'); f.method = 'POST'; f.action = 'https://kite.zerodha.com/connect/basket';
    [['api_key', S.settings.apiKey], ['data', JSON.stringify(orders)]].forEach(([k, v]) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); });
    document.body.appendChild(f); f.submit();
  }

  // ---------- render: portfolio
  function renderPortfolio() {
    const el = $('tab-portfolio'); let inv = 0, val = 0;
    let h = '';
    TRACK.forEach(({ p, t }) => { inv += p.entry_price * p.qty; val += (t.last_close || p.entry_price) * p.qty; });
    h += `<div class="grid"><div class="stat"><b>${S.positions.length} / ${S.settings.slots}</b><span>open positions</span></div><div class="stat"><b class="${cls(val - inv)}">${inr(val - inv)}</b><span>unrealised P&L on ${inr(inv)}</span></div></div>`;
    if (!TRACK.length) h += '<div class="empty">No open positions.<br>After your orders fill they appear here automatically (as estimates - confirm them).</div>';
    TRACK.forEach(({ p, t }, i) => {
      const k = t.signal === 'SELL NEXT OPEN' ? 'SELL' : t.signal === 'STOP HIT' ? 'STOP' : t.signal === 'HOLD' ? 'HOLD' : 'CHECK';
      h += `<div class="card"><div class="row"><span class="sym">${esc(p.symbol)}</span><span class="chip ${k}">${esc(t.signal)}</span></div>
      <div class="mute">${esc(t.reason || '')}${p.source === 'estimated' ? ' · <b>estimated fill - confirm</b>' : ''}</div>
      <div class="kv"><div>Entry<b>${p.entry_price}</b></div><div>Last close<b>${t.last_close ?? '-'}</b></div><div>P&L<b class="${cls(t.pnl_pct)}">${t.pnl_pct == null ? '-' : pct(t.pnl_pct)}</b></div>
      <div>Qty<b>${p.qty}</b></div><div>Stop<b>${t.stop ?? '-'}</b></div><div>Session<b>${t.sessions ?? '-'} / ${preset().maxHold}</b></div></div>
      <div class="actions"><button class="primary sell" data-i="${i}">Sell…</button><button class="ghost edit" data-i="${i}">Edit</button><button class="ghost del" data-i="${i}">Not filled</button></div></div>`;
    });
    h += '<div class="actions"><button class="ghost" id="addPos">+ Add a position I bought</button></div>';
    el.innerHTML = h;
    el.querySelectorAll('.sell').forEach((b) => (b.onclick = () => sellFlow(+b.dataset.i)));
    el.querySelectorAll('.edit').forEach((b) => (b.onclick = () => editPos(+b.dataset.i)));
    el.querySelectorAll('.del').forEach((b) => (b.onclick = async () => { const p = TRACK[+b.dataset.i].p; if (await confirmBox('Remove ' + p.symbol + '? (use when the order was not filled)')) { S.positions = S.positions.filter((x) => x !== p); save(); refresh(); } }));
    $('addPos').onclick = addPos;
  }
  async function sellFlow(i) {
    const { p, t } = TRACK[i];
    const r = await ask('Sell ' + p.symbol, [{ key: 'px', label: 'Exit price (actual fill; leave blank to open Kite first)', type: 'number', step: '0.05', value: '' }, { key: 'd', label: 'Exit date', type: 'date', value: today() }], 'Record sale');
    if (!r) return;
    if (!r.px) {                                      // open Kite with a SELL (market) basket for tomorrow's open
      if (!S.settings.apiKey) return alert('Add your Kite API key in Settings, or sell directly in Kite and come back to record it.');
      return submitBasket(L.basketOrders([{ symbol: p.symbol, qty: p.qty, side: 'SELL', type: 'MARKET' }], 'swing'));
    }
    S.closed.push({ id: Date.now(), symbol: p.symbol, entry_date: p.entry_date, entry_price: p.entry_price, qty: p.qty, exit_date: r.d, exit_price: +r.px, why: t.signal });
    S.positions = S.positions.filter((x) => x !== p); save(); refresh();
  }
  async function editPos(i) {
    const p = TRACK[i].p;
    const r = await ask('Edit ' + p.symbol + ' (use your real fill)', [{ key: 'd', label: 'Entry date', type: 'date', value: p.entry_date }, { key: 'px', label: 'Entry price', type: 'number', step: '0.05', value: p.entry_price }, { key: 'q', label: 'Quantity', type: 'number', value: p.qty }]);
    if (!r) return; p.entry_date = r.d; p.entry_price = +r.px; p.qty = +r.q; p.source = 'confirmed'; save(); refresh();
  }
  async function addPos() {
    const r = await ask('Add a position', [{ key: 's', label: 'NSE symbol (e.g. TCS)', value: '' }, { key: 'd', label: 'Entry date', type: 'date', value: today() }, { key: 'px', label: 'Entry price', type: 'number', step: '0.05', value: '' }, { key: 'q', label: 'Quantity', type: 'number', value: '' }]);
    if (!r || !r.s || !r.px || !r.q) return; S.positions.push({ symbol: r.s.toUpperCase(), entry_date: r.d, entry_price: +r.px, qty: +r.q, source: 'manual', id: Date.now() }); save(); refresh();
  }

  // ---------- render: journal
  function renderJournal() {
    const el = $('tab-journal'); const st = L.tradeStats(S.closed, S.settings.costPct / 100);
    let h = `<div class="grid"><div class="stat"><b class="${cls(st.pnl_net)}">${inr(st.pnl_net)}</b><span>net P&L (after ~${S.settings.costPct}% costs)</span></div><div class="stat"><b>${st.n}</b><span>closed trades</span></div>
    <div class="stat"><b>${st.n ? st.win.toFixed(0) + '%' : '-'}</b><span>win rate</span></div><div class="stat"><b>${st.n ? (st.pf === Infinity ? '∞' : st.pf.toFixed(2)) : '-'}</b><span>profit factor</span></div>
    <div class="stat"><b class="${cls(st.avg_net_pct)}">${st.n ? pct(st.avg_net_pct) : '-'}</b><span>avg trade (net)</span></div><div class="stat"><b class="bad">${st.n ? inr(st.max_dd) : '-'}</b><span>max drawdown of P&L</span></div>
    <div class="stat"><b class="good">${st.n ? pct(st.best) : '-'}</b><span>best trade</span></div><div class="stat"><b class="bad">${st.n ? pct(st.worst) : '-'}</b><span>worst trade</span></div></div>`;
    h += '<h2>Cumulative P&L</h2><canvas id="cv" width="640" height="300"></canvas>';
    const ms = Object.keys(st.months).sort().reverse();
    if (ms.length) h += '<h2>By month</h2><div class="card"><table>' + ms.map((m) => `<tr><td>${m}</td><td class="${cls(st.months[m])}">${inr(st.months[m])}</td></tr>`).join('') + '</table></div>';
    if (st.n) h += '<h2>Trades</h2><div class="card"><table><tr><th>Stock</th><th>Exit</th><th>Net %</th><th>Net ₹</th></tr>' + st.rows.slice().reverse().map((t) => `<tr><td>${esc(t.symbol)}</td><td>${t.exit_date.slice(5)}</td><td class="${cls(t.net_pct)}">${pct(t.net_pct)}</td><td class="${cls(t.pnl_net)}">${inr(t.pnl_net)}</td></tr>`).join('') + '</table></div>';
    else h += '<div class="empty">No closed trades yet.</div>';
    h += '<div class="actions"><button class="ghost" id="csv">Export trades (CSV)</button><button class="ghost" id="bk">Backup (JSON)</button><button class="ghost" id="rs">Restore backup</button></div><div class="small">Your data lives only in this phone\'s browser storage. Take a backup now and then (and before clearing browser data).</div>';
    el.innerHTML = h;
    drawCurve($('cv'), st.curve);
    $('csv').onclick = () => download('swing-trades.csv', 'symbol,entry_date,entry_price,qty,exit_date,exit_price,gross_pct,net_pct,pnl_net\n' + st.rows.map((t) => [t.symbol, t.entry_date, t.entry_price, t.qty, t.exit_date, t.exit_price, t.gross_pct.toFixed(2), t.net_pct.toFixed(2), t.pnl_net.toFixed(0)].join(',')).join('\n'), 'text/csv');
    $('bk').onclick = () => download('swing-backup-' + today() + '.json', JSON.stringify(S, null, 1), 'application/json');
    $('rs').onclick = () => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.json'; i.onchange = async () => { try { const j = JSON.parse(await i.files[0].text()); if (!j.settings || !j.positions) throw new Error('not a backup'); S = { ...DEF, ...j }; save(); refresh(); alert('Restored'); } catch (e) { alert('Could not restore: ' + e.message); } }; i.click(); };
  }
  function drawCurve(cv, curve) {
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, css = getComputedStyle(document.body);
    g.clearRect(0, 0, W, H); g.font = '20px system-ui'; g.fillStyle = css.getPropertyValue('--mute');
    if (curve.length < 1) { g.fillText('Closed trades will plot here', 20, H / 2); return; }
    const pts = [{ v: 0 }, ...curve], mx = Math.max(...pts.map((p) => p.v), 1), mn = Math.min(...pts.map((p) => p.v), 0), pad = 24;
    const X = (i) => pad + (i / Math.max(pts.length - 1, 1)) * (W - 2 * pad), Y = (v) => H - pad - ((v - mn) / (mx - mn || 1)) * (H - 2 * pad);
    g.strokeStyle = css.getPropertyValue('--line'); g.beginPath(); g.moveTo(pad, Y(0)); g.lineTo(W - pad, Y(0)); g.stroke();
    g.strokeStyle = css.getPropertyValue('--acc'); g.lineWidth = 3; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(i), Y(p.v)) : g.moveTo(X(i), Y(p.v)))); g.stroke();
    g.fillStyle = css.getPropertyValue('--ink'); g.fillText(inr(pts[pts.length - 1].v), pad, 22);
  }
  function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }

  // ---------- render: settings
  function renderSettings() {
    const s = S.settings, el = $('tab-settings');
    el.innerHTML = `<h2>Capital & rules</h2>
    <label>Capital for this system (₹)</label><input id="s_capital" type="number" value="${s.capital}">
    <label>Max open positions (slots)</label><input id="s_slots" type="number" value="${s.slots}">
    <label>Orders to place per day</label><input id="s_orders" type="number" value="${s.orders}">
    <label>Exit rules</label><select id="s_preset">${Object.entries(L.PRESETS).map(([k, v]) => `<option value="${k}" ${s.preset === k ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>
    <label>Round-trip cost used for P&L (%)</label><input id="s_cost" type="number" step="0.05" value="${s.costPct}">
    <h2>Zerodha Kite</h2>
    <label>Kite Connect API key (free "Personal" app)</label><input id="s_key" value="${esc(s.apiKey)}" autocomplete="off">
    <div class="small">Only the public API key is needed (never your secret or password). Create the app at developers.kite.trade and set its redirect URL to this app's address.</div>
    <h2>Exit alerts on your phone (free)</h2>
    <div class="small">Each evening GitHub sends a push (through the free ntfy app) listing stocks to sell at tomorrow's open and the new orders. Setup steps are in README section "Exit alerts".</div>
    <label>ntfy topic (same name you subscribed to in the ntfy app)</label><input id="s_ntfy" value="${esc(s.ntfyTopic)}" autocomplete="off">
    <label>GitHub repository (username/repo)</label><input id="s_repo" value="${esc(s.ghRepo)}" placeholder="yourname/swing" autocomplete="off">
    <label>GitHub token (fine-grained, this repo only, Variables: read and write)</label><input id="s_tok" type="password" value="${esc(s.ghToken)}" autocomplete="off">
    <div class="actions"><button class="ghost" id="s_sync">Sync positions now</button><button class="ghost" id="s_test">Send test alert</button></div>
    <div class="small">Status: <span id="syncStatus">${esc(syncMsg || 'not synced yet')}</span></div>
    <h2>Data</h2><label>Signals URL</label><input id="s_url" value="${esc(s.dataUrl)}">
    <div class="actions"><button class="primary" id="s_save">Save</button><button class="ghost" id="s_notif">Enable exit notifications</button></div>
    <div class="small">Notifications appear when you open the app and an exit is due (this app cannot run in the background). Disclaimer: not financial advice. Results come from a backtest on today's surviving stocks and overstate live performance.</div>
    <div class="actions"><button class="danger" id="s_reset">Erase all app data</button></div>`;
    $('s_save').onclick = () => { Object.assign(S.settings, { capital: +$('s_capital').value, slots: +$('s_slots').value, orders: +$('s_orders').value, preset: $('s_preset').value, costPct: +$('s_cost').value, apiKey: $('s_key').value.trim(), ntfyTopic: $('s_ntfy').value.trim(), ghRepo: $('s_repo').value.trim(), ghToken: $('s_tok').value.trim(), dataUrl: $('s_url').value.trim() || 'data/signals.json' }); save(); init(true); };
    $('s_sync').onclick = () => { Object.assign(S.settings, { ghRepo: $('s_repo').value.trim(), ghToken: $('s_tok').value.trim() }); save(); syncAlerts(false); };
    $('s_test').onclick = async () => { const t = $('s_ntfy').value.trim(); if (!t) return alert('Enter your ntfy topic first.'); try { const r = await fetch('https://ntfy.sh/' + encodeURIComponent(t), { method: 'POST', body: 'Test alert from Swing Tracker - your phone is set up.', headers: { Title: 'Swing Tracker test' } }); alert(r.ok ? 'Sent - check the ntfy app.' : 'ntfy said ' + r.status); } catch (e) { alert('Could not send: ' + e.message); } };
    $('s_notif').onclick = async () => { try { alert((await Notification.requestPermission()) === 'granted' ? 'Notifications enabled' : 'Permission not granted'); } catch (e) { alert('Not supported on this browser'); } };
    $('s_reset').onclick = async () => { if (await confirmBox('Erase ALL positions, trades and settings from this phone?')) { localStorage.removeItem(KEY); S = JSON.parse(JSON.stringify(DEF)); refresh(); } };
  }

  function refresh(src) { resolveOrders(); trackAll(); renderHeader(src || 'saved'); renderOrders(); renderPortfolio(); renderJournal(); renderSettings(); }
  async function init(force) { const src = await loadData(); refresh(src); }

  document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'journal') renderJournal();
  }));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  init();
})();
