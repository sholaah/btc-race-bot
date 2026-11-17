// Long-with-guardrails bot for the cbBTC 24h race (agent-fun/bars-replay/v1).
//
// What the dev window teaches (and freqtrade-style active strategies confirm on it):
// on one-minute bars a round trip costs roughly 26 bps, so strategies that trade
// often pay the pool more than the day's moves pay them — every active house baseline
// loses money on the dev window while simply holding made some. This bot is built on
// that arithmetic, not on curve-fitting: it is long by default, because a 24-hour race
// ranked by net PnL rewards participating in the day's drift, and it spends its few
// trades only on insurance:
//
//   - Entry: on the first bars, buy with the full weight the caps allow — unless a
//     confirmed downtrend is in progress (EMA(15) below EMA(60) AND the 60-bar log
//     momentum under -30 bps, once enough bars exist to measure them), in which case
//     it waits for the recovery signal below.
//   - Catastrophe stop: if the close falls 3.5% under the highest close since entry,
//     sell everything. The stop is wide on purpose: it exists for crash days, not for
//     intraday noise, and on an ordinary day it never fires.
//   - Re-entry after a stop-out: once 30 bars have passed and the trend has recovered
//     (EMA(15) back above EMA(60) with the 60-bar momentum positive), buy back in —
//     a V-shaped day is ridden again rather than watched from cash.
//   - Orders cap slippage at 100 bps past the deciding close, like the house EMA bot,
//     so a fill the market will not give near the close is refused and re-decided.
//   - Determinism: float64 arithmetic on the closes alone; no clock, no randomness,
//     no environment. The same bars give the same orders, run after run.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 15;
const SLOW_SPAN = 60;
const MOMENTUM_BARS = 60;
const WARMUP_BARS = 5;
/** A downtrend strong enough to veto the default entry: momentum under -30 bps... */
const VETO_MOM_BPS = -30;
/** ...and, after a stop-out, a recovery needs momentum back above 0 bps. */
const RECOVERY_MOM_BPS = 0;
/** Catastrophe stop: sell at 3.5% under the highest close since entry. */
const STOP_DRAWDOWN = 0.035;
/** Bars to sit out after a stop-out before a re-entry is allowed. */
const COOLDOWN_BARS = 30;
const MAX_SLIPPAGE_BPS = 100;

interface Series {
  closes: number[];
  fast: number | null;
  slow: number | null;
  /** Highest close since the current position was entered; null while flat. */
  peak: number | null;
  /** Bars since the last stop-out (Infinity when none has happened yet). */
  sinceExit: number;
  /** True once the first entry has been made (later entries are re-entries). */
  entered: boolean;
}

const series = new Map<string, Series>();
let minNotional = 1_000_000n;
let maxWeightBps = 10_000n;

function emaNext(prev: number | null, span: number, x: number): number {
  if (prev === null) return x;
  const k = 2 / (span + 1);
  return prev + k * (x - prev);
}

function getSeries(symbol: string): Series {
  let s = series.get(symbol);
  if (!s) {
    s = { closes: [], fast: null, slow: null, peak: null, sinceExit: Number.POSITIVE_INFINITY, entered: false };
    series.set(symbol, s);
  }
  return s;
}

function momentumBps(s: Series, close: number): number {
  if (s.closes.length <= MOMENTUM_BARS) return 0;
  return Math.log(close / s.closes[s.closes.length - 1 - MOMENTUM_BARS]) * 10_000;
}

await runBars({
  onHello(state: BarsState) {
    minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    maxWeightBps = BigInt(state.hello.caps.max_weight_bps);
  },

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const account = batch.account;
    const held = new Map(account.positions.map((p) => [p.symbol, p]));

    for (const bar of batch.bars) {
      const s = getSeries(bar.symbol);
      const close = Number(BigInt(bar.c));
      if (!(close > 0)) continue;
      s.closes.push(close);
      if (s.closes.length > 400) s.closes.shift();
      s.fast = emaNext(s.fast, FAST_SPAN, close);
      s.slow = emaNext(s.slow, SLOW_SPAN, close);
      if (s.sinceExit !== Number.POSITIVE_INFINITY) s.sinceExit++;

      const position = held.get(bar.symbol);
      if (position) {
        // Holding: the only decision is the catastrophe stop.
        s.peak = s.peak === null ? close : Math.max(s.peak, close);
        if (s.peak !== null && close < s.peak * (1 - STOP_DRAWDOWN)) {
          orders.push({ side: 'sell', symbol: bar.symbol, qty: position.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          s.peak = null;
          s.sinceExit = 0;
        }
        continue;
      }

      // Flat: enter (or re-enter) when the rules for this kind of entry are met.
      s.peak = null;
      if (s.closes.length < WARMUP_BARS) continue;
      const mom = momentumBps(s, close);
      if (!s.entered) {
        // The veto applies only once the slow EMA exists to measure it with (the
        // warm-up's bars count toward it); before that, the default is to be long.
        const downtrend = s.fast !== null && s.slow !== null && s.fast < s.slow && mom < VETO_MOM_BPS;
        if (downtrend) continue;
      } else {
        if (s.sinceExit < COOLDOWN_BARS) continue;
        const recovered = s.fast > s.slow && mom > RECOVERY_MOM_BPS;
        if (!recovered) continue;
      }
      const equity = BigInt(account.equity_quote_units);
      const cash = BigInt(account.cash_quote_units);
      let notional = (equity * maxWeightBps) / 10_000n;
      if (notional > cash) notional = cash;
      if (notional < minNotional) continue;
      orders.push({ side: 'buy', symbol: bar.symbol, notional_quote_units: notional.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS });
      s.entered = true;
      s.peak = close;
    }
    return orders;
  },
});
