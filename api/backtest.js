/**
 * NZR Backtest Engine v2
 * Supports: day trading (15-min bars), swing trading (daily bars), or both simultaneously.
 * Slippage: 0.10% per side. Commission: $5 per leg ($10 round trip).
 */

const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];
const SLIPPAGE    = 0.001;  // 0.10% per side
const COMMISSION  = 5;      // $5 per leg
const MAX_HOLD_DAYS = 30;   // swing: force exit after 30 days

// ─── RATE LIMITING ────────────────────────────────────────────────────────────

const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 10;
  const e = rateLimit.get(ip);
  if (!e || now - e.start > w) { rateLimit.set(ip, { count: 1, start: now }); return true; }
  if (e.count >= max) return false;
  e.count++;
  return true;
}

// ─── HTTP HELPER ──────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Invalid JSON from Polygon')); }
      });
    }).on('error', reject);
  });
}

async function fetchBars(symbol, multiplier, timespan, from, to, key) {
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=5000&apiKey=${key}`;
  console.log(`[backtest] Fetching ${timespan} bars: ${url.replace(key, 'KEY')}`);
  const data = await httpsGet(url);
  console.log(`[backtest] ${timespan} response: status=${data.status} count=${data.resultsCount ?? 0}`);
  if (data.status === 'NOT_AUTHORIZED') throw new Error('API key invalid or expired.');
  if (data.status === 'NOT_FOUND')      throw new Error(`Symbol "${symbol}" not found on Polygon.`);
  if (!data.results || data.results.length === 0) return [];
  return data.results.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

// ─── ET TIMEZONE HELPERS ──────────────────────────────────────────────────────

function isDST(ts) {
  const d = new Date(ts);
  const yr = d.getUTCFullYear();
  const marchFirst = new Date(Date.UTC(yr, 2, 1));
  const dstStart   = new Date(Date.UTC(yr, 2, 8  + (7 - marchFirst.getUTCDay()) % 7, 7));
  const novFirst   = new Date(Date.UTC(yr, 10, 1));
  const dstEnd     = new Date(Date.UTC(yr, 10, 1  + (7 - novFirst.getUTCDay())  % 7, 6));
  return ts >= dstStart.getTime() && ts < dstEnd.getTime();
}

function getETOffsetMs(ts) {
  return isDST(ts) ? -4 * 3600000 : -5 * 3600000;
}

function getETMinuteOfDay(ts) {
  const et = new Date(ts + getETOffsetMs(ts));
  return et.getUTCHours() * 60 + et.getUTCMinutes();
}

function getETDateStr(ts) {
  const et = new Date(ts + getETOffsetMs(ts));
  return et.toISOString().slice(0, 10);
}

// ─── SLIPPAGE HELPER ──────────────────────────────────────────────────────────

function applySlippage(price, side) {
  return side === 'buy' ? price * (1 + SLIPPAGE) : price * (1 - SLIPPAGE);
}

// ─── INDICATOR MATH ───────────────────────────────────────────────────────────

/**
 * EMA seeded from first close. All bars have values (no null warmup).
 * Only meaningful from bar >= period, but usable from bar 0.
 */
function calcEMA(closes, period) {
  if (!closes.length) return [];
  const k   = 2 / (period + 1);
  const ema = new Array(closes.length);
  ema[0]    = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

/** Wilder-smoothed RSI. Returns null for first `period` indices. */
function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }
  let ag = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let al = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  rsi[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    ag = (ag * (period - 1) + gains[i - 1])  / period;
    al = (al * (period - 1) + losses[i - 1]) / period;
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return rsi;
}

/** MACD = EMA12 − EMA26, Signal = EMA9(MACD), Histogram = MACD − Signal. */
function calcMACD(closes) {
  const ema12    = calcEMA(closes, 12);
  const ema26    = calcEMA(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const sigK     = 2 / 10;
  const signalLine = new Array(closes.length);
  signalLine[0]    = macdLine[0];
  for (let i = 1; i < closes.length; i++) {
    signalLine[i] = macdLine[i] * sigK + signalLine[i - 1] * (1 - sigK);
  }
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

// ─── TRADE FACTORY ────────────────────────────────────────────────────────────

/**
 * Builds a trade object with dollar P&L and compounding support.
 * @param {number} exitTs    - exit bar timestamp (ms)
 * @param {number} entryTs   - entry bar timestamp (ms)
 * @param {number} entryPrice - after slippage
 * @param {number} exitPrice  - after slippage
 * @param {number} capital   - deployed capital for this trade
 * @param {string} mode      - 'day' | 'swing'
 * @param {string} strategy
 * @param {string} symbol
 */
function makeTrade(exitTs, entryTs, entryPrice, exitPrice, capital, mode, strategy, symbol) {
  const shares    = Math.max(1, Math.floor(capital / entryPrice));
  const grossPnl  = shares * (exitPrice - entryPrice);
  const totalComm = COMMISSION * 2;                   // entry + exit
  const pnl       = grossPnl - totalComm;
  const pnlPct    = (pnl / capital) * 100;
  const holdMs    = exitTs - entryTs;
  const holdMins  = Math.round(holdMs / 60000);
  const holdDays  = Math.max(0, Math.round(holdMs / 86400000));

  return {
    symbol,
    mode,
    strategy,
    entryDate:  getETDateStr(entryTs),
    exitDate:   getETDateStr(exitTs),
    entryPrice: parseFloat(entryPrice.toFixed(4)),
    exitPrice:  parseFloat(exitPrice.toFixed(4)),
    shares,
    pnl:        parseFloat(pnl.toFixed(2)),
    pnlPct:     parseFloat(pnlPct.toFixed(3)),
    result:     pnl >= 0 ? 'WIN' : 'LOSS',
    direction:  'LONG',
    holdingDays: mode === 'day' ? 0 : holdDays,
    holdingMins: mode === 'day' ? holdMins : undefined,
  };
}

// ─── DAY TRADING STRATEGIES (15-min bars) ────────────────────────────────────

const DAY_STOP_PCT     = 0.015;  // 1.5% stop loss
const DAY_NO_ENTRY_MIN = 900;    // no new entries after 3:00 PM ET
const DAY_FORCE_MIN    = 930;    // force close at 3:30 PM ET bar (closes at 3:45)
const MARKET_OPEN_MIN  = 570;    // 9:30 AM ET
const MARKET_CLOSE_MIN = 960;    // 4:00 PM ET

/**
 * Day MACD Crossover — 15-min bars.
 * Entry: MACD histogram flips from ≤0 to >0.
 * Exit:  histogram flips negative | stop 1.5% | EOD (3:30 PM bar).
 * No new entries after 3:00 PM ET.
 */
function simulateDayMacdCrossover(bars, capital, symbol) {
  if (bars.length < 50) return [];
  const closes = bars.map(b => b.c);
  const { histogram } = calcMACD(closes);
  const trades = [];
  let inTrade = false, entry = null;

  for (let i = 26; i < bars.length; i++) {
    const min  = getETMinuteOfDay(bars[i].t);
    const date = getETDateStr(bars[i].t);

    // Outside market hours: skip
    if (min < MARKET_OPEN_MIN || min >= MARKET_CLOSE_MIN) continue;

    // New day while in trade: close at open of today (missed EOD exit)
    if (inTrade && date !== entry.date) {
      const exitPrice = applySlippage(bars[i].o || bars[i].c, 'sell');
      trades.push(makeTrade(bars[i].t, entry.ts, entry.price, exitPrice, capital, 'day', 'macd_crossover', symbol));
      inTrade = false; entry = null;
    }

    if (!inTrade) {
      if (min >= DAY_NO_ENTRY_MIN) continue;
      if (histogram[i] > 0 && histogram[i - 1] <= 0) {
        const ep = applySlippage(bars[i].c, 'buy');
        inTrade = true;
        entry   = { date, ts: bars[i].t, price: ep, stopPrice: ep * (1 - DAY_STOP_PCT) };
      }
    } else {
      const stopHit   = bars[i].l <= entry.stopPrice;
      const crossDown = histogram[i] < 0 && histogram[i - 1] >= 0;
      const eodClose  = min >= DAY_FORCE_MIN;

      if (stopHit || crossDown || eodClose) {
        const rawExit   = stopHit ? entry.stopPrice : bars[i].c;
        const exitPrice = applySlippage(rawExit, 'sell');
        trades.push(makeTrade(bars[i].t, entry.ts, entry.price, exitPrice, capital, 'day', 'macd_crossover', symbol));
        inTrade = false; entry = null;
      }
    }
  }
  // Lingering open trade
  if (inTrade && entry) {
    const exitPrice = applySlippage(bars[bars.length - 1].c, 'sell');
    trades.push(makeTrade(bars[bars.length - 1].t, entry.ts, entry.price, exitPrice, capital, 'day', 'macd_crossover', symbol));
  }
  return trades;
}

/**
 * Day RSI Mean Reversion — 15-min bars.
 * Entry: RSI(14) < 30 AND MACD histogram ≤ 0 turning positive (bounce from oversold).
 * Exit:  RSI > 65 | MACD histogram turns negative | stop 1.5% | EOD.
 * No new entries after 3:00 PM ET.
 */
function simulateDayRsiMeanReversion(bars, capital, symbol) {
  if (bars.length < 50) return [];
  const closes        = bars.map(b => b.c);
  const rsi           = calcRSI(closes, 14);
  const { histogram } = calcMACD(closes);
  const trades        = [];
  let inTrade = false, entry = null;

  for (let i = 26; i < bars.length; i++) {
    if (rsi[i] === null) continue;
    const min  = getETMinuteOfDay(bars[i].t);
    const date = getETDateStr(bars[i].t);

    if (min < MARKET_OPEN_MIN || min >= MARKET_CLOSE_MIN) continue;

    if (inTrade && date !== entry.date) {
      const exitPrice = applySlippage(bars[i].o || bars[i].c, 'sell');
      trades.push(makeTrade(bars[i].t, entry.ts, entry.price, exitPrice, capital, 'day', 'rsi_mean_reversion', symbol));
      inTrade = false; entry = null;
    }

    if (!inTrade) {
      if (min >= DAY_NO_ENTRY_MIN) continue;
      // RSI oversold AND MACD histogram turning up
      if (rsi[i] < 30 && histogram[i] > 0 && histogram[i - 1] <= 0) {
        const ep = applySlippage(bars[i].c, 'buy');
        inTrade  = true;
        entry    = { date, ts: bars[i].t, price: ep, stopPrice: ep * (1 - DAY_STOP_PCT) };
      }
    } else {
      const stopHit   = bars[i].l <= entry.stopPrice;
      const rsiExit   = rsi[i] > 65;
      const macdExit  = histogram[i] < 0 && histogram[i - 1] >= 0;
      const eodClose  = min >= DAY_FORCE_MIN;

      if (stopHit || rsiExit || macdExit || eodClose) {
        const rawExit   = stopHit ? entry.stopPrice : bars[i].c;
        const exitPrice = applySlippage(rawExit, 'sell');
        trades.push(makeTrade(bars[i].t, entry.ts, entry.price, exitPrice, capital, 'day', 'rsi_mean_reversion', symbol));
        inTrade = false; entry = null;
      }
    }
  }
  if (inTrade && entry) {
    const exitPrice = applySlippage(bars[bars.length - 1].c, 'sell');
    trades.push(makeTrade(bars[bars.length - 1].t, entry.ts, entry.price, exitPrice, capital, 'day', 'rsi_mean_reversion', symbol));
  }
  return trades;
}

// ─── SWING TRADING STRATEGIES (daily bars) ───────────────────────────────────

const SWING_STOP_PCT = 0.05; // 5% hard stop

/**
 * Swing EMA 20/50 Cross — daily bars.
 * Entry: EMA20 crosses above EMA50 (golden cross).
 * Exit:  EMA20 crosses below EMA50 | 5% stop | 30-day max hold.
 */
function simulateSwingEmaCross(bars, capital, symbol) {
  if (bars.length < 55) return [];
  const closes = bars.map(b => b.c);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const trades = [];
  let inTrade = false, entry = null;
  const startBar = Math.min(50, bars.length - 1);

  for (let i = startBar; i < bars.length; i++) {
    if (!inTrade) {
      const cross = ema20[i] > ema50[i] && ema20[i - 1] <= ema50[i - 1];
      if (cross) {
        const ep = applySlippage(bars[i].c, 'buy');
        inTrade  = true;
        entry    = { ts: bars[i].t, price: ep, stopPrice: ep * (1 - SWING_STOP_PCT) };
      }
    } else {
      const stopHit   = bars[i].l <= entry.stopPrice;
      const deathCros = ema20[i] < ema50[i] && ema20[i - 1] >= ema50[i - 1];
      const maxHold   = (bars[i].t - entry.ts) >= MAX_HOLD_DAYS * 86400000;

      if (stopHit || deathCros || maxHold) {
        const rawExit   = stopHit ? entry.stopPrice : bars[i].c;
        const exitPrice = applySlippage(rawExit, 'sell');
        trades.push(makeTrade(bars[i].t, entry.ts, entry.price, exitPrice, capital, 'swing', 'ema_cross', symbol));
        inTrade = false; entry = null;
      }
    }
  }
  if (inTrade && entry) {
    const exitPrice = applySlippage(bars[bars.length - 1].c, 'sell');
    trades.push(makeTrade(bars[bars.length - 1].t, entry.ts, entry.price, exitPrice, capital, 'swing', 'ema_cross', symbol));
  }
  return trades;
}

/**
 * Swing Combined (EMA60/200 + RSI/MACD) — daily bars.
 * Entry: EMA60 > EMA200 AND (RSI < 35 OR (RSI < 50 AND histogram > 0)).
 * Exit:  EMA60 < EMA200 | RSI > 70 | histogram turns negative | 5% stop | 30-day max hold.
 */
function simulateSwingCombined(bars, capital, symbol) {
  if (bars.length < 201) return [];
  const closes        = bars.map(b => b.c);
  const ema60         = calcEMA(closes, 60);
  const ema200        = calcEMA(closes, 200);
  const rsi           = calcRSI(closes, 14);
  const { histogram } = calcMACD(closes);
  const trades        = [];
  let inTrade = false, entry = null;
  const startBar = Math.min(200, bars.length - 1);

  for (let i = startBar; i < bars.length; i++) {
    if (rsi[i] === null) continue;
    if (!inTrade) {
      const inUptrend   = ema60[i] > ema200[i];
      const entrySignal = rsi[i] < 35 || (rsi[i] < 50 && histogram[i] > 0);
      if (inUptrend && entrySignal) {
        const ep = applySlippage(bars[i].c, 'buy');
        inTrade  = true;
        entry    = { ts: bars[i].t, price: ep, stopPrice: ep * (1 - SWING_STOP_PCT) };
      }
    } else {
      const stopHit  = bars[i].l <= entry.stopPrice;
      const bearish  = ema60[i] < ema200[i];
      const rsiOB    = rsi[i] > 70;
      const macdExit = histogram[i] < 0 && histogram[i - 1] >= 0;
      const maxHold  = (bars[i].t - entry.ts) >= MAX_HOLD_DAYS * 86400000;

      if (stopHit || bearish || rsiOB || macdExit || maxHold) {
        const rawExit   = stopHit ? entry.stopPrice : bars[i].c;
        const exitPrice = applySlippage(rawExit, 'sell');
        trades.push(makeTrade(bars[i].t, entry.ts, entry.price, exitPrice, capital, 'swing', 'combined', symbol));
        inTrade = false; entry = null;
      }
    }
  }
  if (inTrade && entry) {
    const exitPrice = applySlippage(bars[bars.length - 1].c, 'sell');
    trades.push(makeTrade(bars[bars.length - 1].t, entry.ts, entry.price, exitPrice, capital, 'swing', 'combined', symbol));
  }
  return trades;
}

// ─── LEGACY SWING STRATEGIES (backward compat) ───────────────────────────────

function simulateGoldenCross(bars, capital, symbol) {
  if (bars.length < 201) return [];
  const closes = bars.map(b => b.c);
  const ema60  = calcEMA(closes, 60);
  const ema200 = calcEMA(closes, 200);
  const trades = [];
  let inTrade = false, entry = null;
  const startBar = Math.min(200, bars.length - 1);

  for (let i = startBar; i < bars.length; i++) {
    const golden = ema60[i] > ema200[i] && ema60[i - 1] <= ema200[i - 1];
    const death  = ema60[i] < ema200[i] && ema60[i - 1] >= ema200[i - 1];
    if (!inTrade) {
      if (golden) {
        const ep = applySlippage(bars[i].c, 'buy');
        inTrade  = true;
        entry    = { ts: bars[i].t, price: ep, stopPrice: ep * (1 - SWING_STOP_PCT) };
      }
    } else {
      const stopHit = bars[i].l <= entry.stopPrice;
      if (stopHit || death) {
        const rawExit   = stopHit ? entry.stopPrice : bars[i].c;
        const exitPrice = applySlippage(rawExit, 'sell');
        trades.push(makeTrade(bars[i].t, entry.ts, entry.price, exitPrice, capital, 'swing', 'golden_cross', symbol));
        inTrade = false; entry = null;
      }
    }
  }
  if (inTrade && entry) {
    const exitPrice = applySlippage(bars[bars.length - 1].c, 'sell');
    trades.push(makeTrade(bars[bars.length - 1].t, entry.ts, entry.price, exitPrice, capital, 'swing', 'golden_cross', symbol));
  }
  return trades;
}

function simulateRsiMacd(bars, capital, symbol) {
  if (bars.length < 36) return [];
  const closes        = bars.map(b => b.c);
  const rsi           = calcRSI(closes, 14);
  const { histogram } = calcMACD(closes);
  const trades        = [];
  let inTrade = false, entry = null;

  for (let i = 35; i < bars.length; i++) {
    if (rsi[i] === null) continue;
    if (!inTrade) {
      if (rsi[i] < 35 && histogram[i] > 0 && histogram[i - 1] <= 0) {
        const ep = applySlippage(bars[i].c, 'buy');
        inTrade  = true;
        entry    = { ts: bars[i].t, price: ep, stopPrice: ep * (1 - SWING_STOP_PCT) };
      }
    } else {
      const stopHit  = bars[i].l <= entry.stopPrice;
      const rsiExit  = rsi[i] > 70;
      const macdExit = histogram[i] < 0 && histogram[i - 1] >= 0;
      if (stopHit || rsiExit || macdExit) {
        const rawExit   = stopHit ? entry.stopPrice : bars[i].c;
        const exitPrice = applySlippage(rawExit, 'sell');
        trades.push(makeTrade(bars[i].t, entry.ts, entry.price, exitPrice, capital, 'swing', 'rsi_macd', symbol));
        inTrade = false; entry = null;
      }
    }
  }
  if (inTrade && entry) {
    const exitPrice = applySlippage(bars[bars.length - 1].c, 'sell');
    trades.push(makeTrade(bars[bars.length - 1].t, entry.ts, entry.price, exitPrice, capital, 'swing', 'rsi_macd', symbol));
  }
  return trades;
}

// ─── SUMMARY STATS ────────────────────────────────────────────────────────────

function calcSummary(trades, symbol, startCapital) {
  if (!trades.length) {
    return {
      symbol, totalTrades: 0, wins: 0, losses: 0,
      winRate: 0, totalPnl: 0, totalPnlPct: 0,
      maxDrawdown: 0, avgWin: 0, avgLoss: 0, profitFactor: 0,
      startCapital, finalEquity: startCapital, equityCurve: [],
    };
  }

  const wins    = trades.filter(t => t.result === 'WIN');
  const losses  = trades.filter(t => t.result === 'LOSS');
  const avgWin  = wins.length   ? wins.reduce((s, t) => s + t.pnlPct, 0)   / wins.length   : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const totalGain = wins.reduce((s, t) => s + t.pnlPct, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const pf        = totalLoss === 0 ? (totalGain > 0 ? 999 : 0) : totalGain / totalLoss;

  // Equity curve — compounding on full capital
  let equity = startCapital;
  const equityCurve = [{ date: trades[0].entryDate, equity: startCapital }];
  let peak = startCapital, maxDrawdown = 0;

  for (const t of trades) {
    equity *= (1 + t.pnlPct / 100);
    equityCurve.push({ date: t.exitDate, equity: parseFloat(equity.toFixed(2)) });
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const totalPnlPct = ((equity - startCapital) / startCapital) * 100;

  return {
    symbol,
    totalTrades:  trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      parseFloat(((wins.length / trades.length) * 100).toFixed(1)),
    totalPnl:     parseFloat((equity - startCapital).toFixed(2)),
    totalPnlPct:  parseFloat(totalPnlPct.toFixed(2)),
    maxDrawdown:  parseFloat(maxDrawdown.toFixed(2)),
    avgWin:       parseFloat(avgWin.toFixed(2)),
    avgLoss:      parseFloat(avgLoss.toFixed(2)),
    profitFactor: parseFloat(pf.toFixed(2)),
    startCapital,
    finalEquity:  parseFloat(equity.toFixed(2)),
    equityCurve,
  };
}

// ─── ZERO-TRADE MESSAGES ──────────────────────────────────────────────────────

const ZERO_MESSAGES = {
  macd_crossover:      s => `No MACD histogram crossovers found for ${s} in this period on 15-min bars. Try a longer date range or a more volatile symbol.`,
  rsi_mean_reversion:  s => `No RSI<30 + MACD bounce found for ${s} in this period. This stock may not have had intraday oversold conditions — try a wider date range.`,
  ema_cross:           s => `No EMA20/50 golden cross found for ${s} in this period. Try a longer date range (at least 6 months recommended).`,
  combined:            s => `No combined EMA60/200 + RSI signals found for ${s} in this period. Try a wider date range or use the EMA Cross strategy instead.`,
  golden_cross:        s => `No EMA60/200 crossover found for ${s} in this period. Try at least 2 years of data for this strategy.`,
  rsi_macd:            s => `No RSI<35 + MACD flip found for ${s} in this period. Try a different symbol or wider date range.`,
};

// ─── HANDLER ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'Rate limit reached. Please wait.' });

  const key = process.env.POLYGON_API_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_API_KEY not configured on server.' });

  const src = req.method === 'POST' ? (req.body || {}) : req.query;

  const rawSym = String(src.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
  if (!rawSym) return res.status(400).json({ error: 'symbol is required' });

  const startDate = String(src.startDate || '').replace(/[^0-9\-]/g, '').slice(0, 10);
  const endDate   = String(src.endDate   || '').replace(/[^0-9\-]/g, '').slice(0, 10);
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });

  // mode: 'day' | 'swing' | 'both'
  const mode = String(src.mode || 'swing').toLowerCase();
  if (!['day', 'swing', 'both'].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'day', 'swing', or 'both'" });
  }

  // strategy validation per mode
  const DAY_STRATEGIES   = ['macd_crossover', 'rsi_mean_reversion'];
  const SWING_STRATEGIES = ['ema_cross', 'combined', 'golden_cross', 'rsi_macd'];

  let dayStrategy   = String(src.dayStrategy   || src.strategy || 'macd_crossover').toLowerCase();
  let swingStrategy = String(src.swingStrategy || src.strategy || 'combined').toLowerCase();

  if (mode === 'day'   && !DAY_STRATEGIES.includes(dayStrategy)) {
    return res.status(400).json({ error: `Day strategy must be one of: ${DAY_STRATEGIES.join(', ')}` });
  }
  if (mode === 'swing' && !SWING_STRATEGIES.includes(swingStrategy)) {
    return res.status(400).json({ error: `Swing strategy must be one of: ${SWING_STRATEGIES.join(', ')}` });
  }
  if (mode === 'both') {
    if (!DAY_STRATEGIES.includes(dayStrategy))     dayStrategy   = 'macd_crossover';
    if (!SWING_STRATEGIES.includes(swingStrategy)) swingStrategy = 'combined';
  }

  const totalCapital = Math.max(100, parseFloat(src.capital || '10000') || 10000);
  const dayCapital   = parseFloat((totalCapital * 0.40).toFixed(2));
  const swingCapital = parseFloat((totalCapital * 0.60).toFixed(2));

  console.log(`[backtest] ${rawSym} ${startDate}→${endDate} mode=${mode} cap=$${totalCapital}`);

  try {
    // ── SWING / BOTH — fetch daily bars ──────────────────────────────────────
    let dailyBars = [];
    if (mode === 'swing' || mode === 'both') {
      dailyBars = await fetchBars(rawSym, 1, 'day', startDate, endDate, key);
      if (!dailyBars.length) {
        return res.status(422).json({
          error: `No daily data returned for ${rawSym} from ${startDate} to ${endDate}. Check the ticker and date range.`,
        });
      }
    }

    // ── DAY / BOTH — fetch 15-min bars ────────────────────────────────────────
    let minBars = [];
    if (mode === 'day' || mode === 'both') {
      minBars = await fetchBars(rawSym, 15, 'minute', startDate, endDate, key);
      if (!minBars.length) {
        return res.status(422).json({
          error: `No 15-min data returned for ${rawSym} in this range. ` +
                 `Note: free Polygon plans may have limited intraday history.`,
        });
      }
    }

    // ── SINGLE MODE: day ─────────────────────────────────────────────────────
    if (mode === 'day') {
      if (minBars.length < 50) {
        return res.status(422).json({ error: `Only ${minBars.length} 15-min bars found — need at least 50. Widen the date range.` });
      }

      const capUsed = dayCapital; // use full day allocation
      let trades;
      if (dayStrategy === 'macd_crossover')     trades = simulateDayMacdCrossover(minBars, capUsed, rawSym);
      else                                       trades = simulateDayRsiMeanReversion(minBars, capUsed, rawSym);

      const summary = calcSummary(trades, rawSym, capUsed);
      const message = trades.length === 0 ? (ZERO_MESSAGES[dayStrategy]?.(rawSym) ?? null) : null;

      return res.status(200).json({
        symbol: rawSym, mode, strategy: dayStrategy,
        startDate, endDate,
        capital: totalCapital, deployedCapital: capUsed,
        barsUsed: minBars.length,
        message, summary, trades,
      });
    }

    // ── SINGLE MODE: swing ────────────────────────────────────────────────────
    if (mode === 'swing') {
      const minRequired = { ema_cross: 55, combined: 201, golden_cross: 201, rsi_macd: 36 };
      const need = minRequired[swingStrategy] || 55;
      if (dailyBars.length < need) {
        return res.status(422).json({
          error: `Not enough data — ${dailyBars.length} bars found but "${swingStrategy}" needs at least ${need}. Select a longer date range.`,
        });
      }

      const capUsed = swingCapital;
      let trades;
      if      (swingStrategy === 'ema_cross')    trades = simulateSwingEmaCross(dailyBars, capUsed, rawSym);
      else if (swingStrategy === 'combined')      trades = simulateSwingCombined(dailyBars, capUsed, rawSym);
      else if (swingStrategy === 'golden_cross')  trades = simulateGoldenCross(dailyBars, capUsed, rawSym);
      else                                        trades = simulateRsiMacd(dailyBars, capUsed, rawSym);

      const summary = calcSummary(trades, rawSym, capUsed);
      const message = trades.length === 0 ? (ZERO_MESSAGES[swingStrategy]?.(rawSym) ?? null) : null;

      return res.status(200).json({
        symbol: rawSym, mode, strategy: swingStrategy,
        startDate, endDate,
        capital: totalCapital, deployedCapital: capUsed,
        barsUsed: dailyBars.length,
        message, summary, trades,
      });
    }

    // ── BOTH MODE ─────────────────────────────────────────────────────────────
    // Day side
    let dayTrades = [];
    if (minBars.length >= 50) {
      if (dayStrategy === 'macd_crossover') dayTrades = simulateDayMacdCrossover(minBars, dayCapital, rawSym);
      else                                   dayTrades = simulateDayRsiMeanReversion(minBars, dayCapital, rawSym);
    }
    const dayMsg     = dayTrades.length === 0 ? (ZERO_MESSAGES[dayStrategy]?.(rawSym) ?? null) : null;
    const daySummary = calcSummary(dayTrades, rawSym, dayCapital);

    // Swing side
    const swingNeed = { ema_cross: 55, combined: 201, golden_cross: 201, rsi_macd: 36 };
    let swingTrades = [];
    if (dailyBars.length >= (swingNeed[swingStrategy] || 55)) {
      if      (swingStrategy === 'ema_cross')    swingTrades = simulateSwingEmaCross(dailyBars, swingCapital, rawSym);
      else if (swingStrategy === 'combined')      swingTrades = simulateSwingCombined(dailyBars, swingCapital, rawSym);
      else if (swingStrategy === 'golden_cross')  swingTrades = simulateGoldenCross(dailyBars, swingCapital, rawSym);
      else                                        swingTrades = simulateRsiMacd(dailyBars, swingCapital, rawSym);
    }
    const swingMsg     = swingTrades.length === 0 ? (ZERO_MESSAGES[swingStrategy]?.(rawSym) ?? null) : null;
    const swingSummary = calcSummary(swingTrades, rawSym, swingCapital);

    // Combined portfolio performance
    const combinedFinalEquity = daySummary.finalEquity + swingSummary.finalEquity;
    const combinedPnl         = combinedFinalEquity - totalCapital;
    const combinedPnlPct      = (combinedPnl / totalCapital) * 100;
    // Merge equity curves by date
    const allDates = new Set([
      ...daySummary.equityCurve.map(p => p.date),
      ...swingSummary.equityCurve.map(p => p.date),
    ]);
    // Build combined curve: sum of day + swing equity at each date
    const datesSorted = [...allDates].sort();
    let lastDay   = dayCapital;
    let lastSwing = swingCapital;
    const combinedCurve = [];
    const dayMap   = Object.fromEntries(daySummary.equityCurve.map(p => [p.date, p.equity]));
    const swingMap = Object.fromEntries(swingSummary.equityCurve.map(p => [p.date, p.equity]));
    for (const date of datesSorted) {
      if (dayMap[date]   != null) lastDay   = dayMap[date];
      if (swingMap[date] != null) lastSwing = swingMap[date];
      combinedCurve.push({ date, equity: parseFloat((lastDay + lastSwing).toFixed(2)) });
    }

    return res.status(200).json({
      symbol: rawSym,
      mode: 'both',
      startDate,
      endDate,
      capital:      totalCapital,
      dayCapital,
      swingCapital,
      dayResult: {
        strategy:  dayStrategy,
        barsUsed:  minBars.length,
        message:   dayMsg,
        summary:   daySummary,
        trades:    dayTrades,
      },
      swingResult: {
        strategy:  swingStrategy,
        barsUsed:  dailyBars.length,
        message:   swingMsg,
        summary:   swingSummary,
        trades:    swingTrades,
      },
      combined: {
        totalTrades:   dayTrades.length + swingTrades.length,
        totalPnl:      parseFloat(combinedPnl.toFixed(2)),
        totalPnlPct:   parseFloat(combinedPnlPct.toFixed(2)),
        finalEquity:   parseFloat(combinedFinalEquity.toFixed(2)),
        maxDrawdown:   parseFloat(Math.max(daySummary.maxDrawdown, swingSummary.maxDrawdown).toFixed(2)),
        equityCurve:   combinedCurve,
      },
    });

  } catch (err) {
    console.error('[backtest] Error:', rawSym, err.message);
    return res.status(500).json({ error: `Backtest failed: ${err.message}` });
  }
};
