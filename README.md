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

## Exit alerts (push notification every evening, free)
1. Phone: install **ntfy** from the Play Store. Tap **+**, subscribe to a topic with a long random name, e.g. `swing-k7x92qpl-rajesh`. Anyone who knows the name can read it, so make it hard to guess.
2. GitHub repo -> Settings -> Secrets and variables -> Actions -> **New repository secret**: name `NTFY_TOPIC`, value = your topic name.
3. GitHub (profile picture -> Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens -> Generate): repository access = **Only select repositories -> swing**; Repository permissions -> **Variables: Read and write**; expiry 1 year. Copy the token.
4. App -> Settings -> "Exit alerts": fill topic, repo (`yourname/swing`), token -> **Save** -> **Send test alert** (the ntfy app should buzz) -> **Sync positions now**.
5. From then on every change to your portfolio syncs automatically. At ~7:45 pm IST you get a push: "EXIT POCL: SELL NEXT OPEN ..." or "No exits due", plus tonight's new orders.
Notes: the token lives only in this phone's browser; your positions are stored as a private Actions variable (not visible to the public). Alerts use the "tested" exit rules. If the data sync fails you get a "data is N days old" alert instead.

## Liquidity
Only stocks with 60-day average daily turnover of at least Rs25 crore and price of at least Rs100 are scanned (backtest: about 14% a year versus 17% at Rs10 crore, with a slightly smaller drawdown). Change it in the desktop app Settings; for the phone version edit `min_adtv_cr` in `engine/swing_core.py`.

## Limits (be aware)
- Orders are not auto-sent; Zerodha requires you to confirm in Kite (API orders also need a static IP).
- Stop is an alert, not a placed stop order. Alerts arrive once an evening (after the scan), not during market hours.
- Data comes from the free community EOD2 dataset synced from NSE; if the banner says data is stale, don't trade.
- Positions/journal live in the phone's browser storage - back up regularly.
- Backtests are on today's surviving stocks and overstate live results. Not investment advice.
