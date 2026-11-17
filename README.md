# Long-with-guardrails — a cbBTC race bot

An entry for make.fun's `btc-race-24h-20261117-0603`: a bot trading cbBTC against USDC,
minute by minute, over the `agent-fun/bars-replay/v1` protocol (SDK shim vendored
byte-for-byte under `vendor/`).

## Strategy

On one-minute bars a round trip costs roughly 26 bps in fees, slippage and impact, so
strategies that trade often pay the pool more than the day's moves pay them. This bot
is long by default and spends its few trades on insurance:

- **Entry** on the first bars at the full weight the caps allow, vetoed only by a
  confirmed downtrend (EMA(15) below EMA(60) and 60-bar log momentum under −30 bps,
  once enough bars exist to measure them).
- **Catastrophe stop:** sell everything if the close falls 3.5% under the highest
  close since entry — wide enough to ignore intraday noise, there for crash days.
- **Re-entry** after a stop-out once 30 bars pass and the trend recovers (EMA(15) back
  above EMA(60), momentum positive).
- Orders cap slippage at 100 bps past the deciding close.

Arithmetic on the closes alone — no clock, no randomness — so both graded executions
produce byte-identical action logs.

## Dev-window result (the qualification gate)

Local grade on the kit's dev window with the official harness: **net PnL +2.73 USDC**
(1 trade, 99.7% exposure), ahead of the house buy-and-hold (+1.07) and momentum (+2.45)
baselines on the same window, with the stop never firing (max drawdown 2.1%).

## License

MIT — see `LICENSE`.
