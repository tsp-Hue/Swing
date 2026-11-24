# Swing Tracker (phone) - RSI(2) pullback system

Nightly scan runs free on GitHub; your phone shows orders, tracks the portfolio, alerts exits, keeps a P&L journal.

## One-time setup (~15 min, all free)
1. Create a free GitHub account -> New repository (name e.g. `swing`, **Public**) -> upload everything from this zip (keep folder structure, incl. `.github`).
2. Repo Settings -> Pages -> Source: **GitHub Actions**.
3. Actions tab -> "Nightly scan" -> Run workflow. First run takes ~10 min. When green, your app is at `https://<username>.github.io/swing/`. It refreshes automatically every weekday ~7:45 pm IST.
4. On the phone open that URL in Chrome -> menu -> **Install app**. (Optional real APK: Actions -> "Build Android APK" -> Run -> download artifact `SwingTracker-debug-apk`, install it, allow unknown sources. Note: the APK loads its pages from inside the app, so it needs the Data URL set to your full `https://<username>.github.io/swing/data/signals.json` in Settings.)
5. Kite: go to developers.kite.trade -> create a free **Personal** app. Set Redirect URL to your app URL. Copy the API key into app Settings.

## Daily routine
- Evening (after ~8 pm): open app -> Orders -> **Open in Kite (basket)** -> confirm in Kite. Orders are one-day LIMIT buys 5% below the signal close.
- Next evenings: app detects fills from prices and adds them to Portfolio as *estimates* - correct via Edit with your real fill.
- Portfolio shows HOLD / SELL NEXT OPEN / STOP HIT. Banner + notification when you open the app. Sell at next open in Kite, then tap Sell... and record price.
- Journal: win rate, profit factor, drawdown, monthly P&L, CSV export, JSON backup.

## Limits (be aware)
- Orders are not auto-sent; Zerodha requires you to confirm in Kite (API orders also need a static IP).
- Alerts show when you open the app; no background push per position. Stop is an alert, not a placed stop order.
- Data comes from the free community EOD2 dataset synced from NSE; if the banner says data is stale, don't trade.
- Positions/journal live in the phone's browser storage - back up regularly.
- Backtests are on today's surviving stocks and overstate live results. Not investment advice.
