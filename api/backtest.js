/**
 * NZR Backtest Engine v3
 * Realism improvements: ATR sizing, dynamic stops, volume filter, earnings blackout,
 * gap risk, EOD force close, max hold, circuit breaker, full commission model,
 * Sharpe ratio, benchmark comparison, trend filter, dynamic slippage.
 */

const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];
const MAX_HOLD_DAYS   = 30;

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
function getETOffsetMs(ts)    { return isDST(ts) ? -4 * 3600000 : -5 * 3600000; }
function getETMinuteOfDay(ts) { const et = new Date(ts + getETOffsetMs(ts)); return et.getUTCHours() * 60 + et.getUTCMinutes(); }
function getETDateStr(ts)     { const et = new Date(ts + getETOffsetMs(ts)); return et.toISOString().slice(0, 10); }

// ─── INDICATOR MATH ───────────────────────────────────────────────────────────

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return [];
  const rsi = new Array(closes.length).fill(null);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses += Math.abs(d);
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = 100 - (100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss)));
  for (let i = period + 1; i < closes.length; i++) {
    const d    = closes[i] - closes[i - 1];
    const gain = d >= 0 ? d : 0;
    const loss = d <  0 ? Math.abs(d) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i]  = 100 - (100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss)));
  }
  return rsi;
}

function calculateEMA(closes, period) {
  if (closes.length < period) return [];
  const ema = new Array(closes.length).fill(null);
  const k   = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  ema[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  return ema;
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return { macd: [], signal: [], histogram: [] };
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] === null || emaSlow[i] === null ? null : emaFast[i] - emaSlow[i]);
  const signalLine = new Array(closes.length).fill(null);
  const firstIdx   = macdLine.findIndex(v => v !== null);
  if (firstIdx === -1) return { macd: macdLine, signal: signalLine, histogram: signalLine };
  const k = 2 / (signal + 1);
  let sum = 0, cnt = 0;
  for (let i = firstIdx; i < firstIdx + signal; i++) {
    if (macdLine[i] !== null) { sum += macdLine[i]; cnt++; }
  }
  signalLine[firstIdx + signal - 1] = sum / cnt;
  for (let i = firstIdx + signal; i < closes.length; i++) {
    if (macdLine[i] !== null && signalLine[i - 1] !== null)
      signalLine[i] = macdLine[i] * k + signalLine[i - 1] * (1 - k);
  }
  const histogram = closes.map((_, i) =>
    macdLine[i] === null || signalLine[i] === null ? null : macdLine[i] - signalLine[i]);
  return { macd: macdLine, signal: signalLine, histogram };
}

/** Wilder-smoothed ATR(14). Returns null until warmed up. */
function calculateATR(bars, period = 14) {
  const tr  = new Array(bars.length).fill(null);
  const atr = new Array(bars.length).fill(null);
  for (let i = 1; i < bars.length; i++) {
    tr[i] = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
  }
  if (bars.length <= period) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < bars.length; i++)
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

/** 20-bar rolling average volume. */
function calculateVolAvg(volumes, period = 20) {
  const avg = new Array(volumes.length).fill(null);
  for (let i = period - 1; i < volumes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += volumes[j];
    avg[i] = s / period;
  }
  return avg;
}

// ─── REALISM HELPERS ─────────────────────────────────────────────────────────

/** Volume-adjusted slippage rate per side. */
function dynamicSlippage(vol, avgVol) {
  if (!avgVol || avgVol <= 0) return 0.001;
  const r = vol / avgVol;
  if (r > 2.0) return 0.0005;
  if (r > 1.0) return 0.001;
  if (r > 0.5) return 0.0015;
  return 0.0025;
}

/** Full commission: $5 flat + SEC fee + FINRA TAF on sell leg. */
function calcFees(shares, tradeValue, side) {
  const base = 5;
  if (side === 'sell') {
    const sec   = 0.0000278 * tradeValue;
    const finra = Math.min(0.000145 * shares, 7.27);
    return base + sec + finra;
  }
  return base;
}

/** ATR-based position sizing. Risks 1% of capital, capped at 10% of capital. */
function calcPositionSize(entryPrice, atr, capital) {
  if (!atr || atr <= 0 || entryPrice <= 0)
    return Math.max(1, Math.floor((capital * 0.1) / entryPrice));
  const byRisk    = Math.floor((capital * 0.01) / (2 * atr));
  const byCap     = Math.floor((capital * 0.1)  / entryPrice);
  return Math.max(1, Math.min(byRisk, byCap));
}

/** ATR-based stop (2×ATR) and target (3×ATR). Floor stop at −25%. */
function calcATRStops(entryPrice, atr) {
  const stopLoss   = Math.max(entryPrice - 2 * atr, entryPrice * 0.75);
  const takeProfit = entryPrice + 3 * atr;
  const risk       = entryPrice - stopLoss;
  const riskReward = risk > 0 ? parseFloat((( takeProfit - entryPrice) / risk).toFixed(2)) : 1.5;
  return { stopLoss, takeProfit, riskReward };
}

/** Days until the nearest upcoming earnings date from earningsDates Set. */
function daysUntilEarnings(earningsDates, dateStr) {
  if (!earningsDates || earningsDates.size === 0) return null;
  const d = new Date(dateStr + 'T12:00:00Z').getTime();
  let min = Infinity;
  for (const ed of earningsDates) {
    const diff = (new Date(ed + 'T12:00:00Z').getTime() - d) / 86400000;
    if (diff >= 0 && diff < min) min = diff;
  }
  return min === Infinity ? null : min;
}

/** Annualised Sharpe Ratio from trade pnlPct values. */
function calculateSharpe(trades) {
  if (trades.length < 2) return 0;
  const ret = trades.map(t => t.pnlPct / 100);
  const n   = ret.length;
  const avg = ret.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(ret.reduce((s, r) => s + (r - avg) ** 2, 0) / n);
  if (std === 0) return avg > 0 ? 99 : 0;
  return parseFloat(((avg / std) * Math.sqrt(252)).toFixed(2));
}

/** Buy-and-hold return for the same period. */
function calculateBenchmark(bars, capital) {
  if (!bars || bars.length < 2) return { benchmarkReturn: 0, benchmarkPnl: 0 };
  const ret = (bars[bars.length - 1].c - bars[0].c) / bars[0].c * 100;
  return {
    benchmarkReturn: parseFloat(ret.toFixed(2)),
    benchmarkPnl:    parseFloat((capital * ret / 100).toFixed(2)),
  };
}

/** Fetch SEC filing dates as a proxy for earnings dates. */
async function fetchEarningsDates(symbol, key) {
  try {
    const url  = `https://api.polygon.io/vX/reference/financials?ticker=${symbol}&limit=20&apiKey=${key}`;
    const data = await httpsGet(url);
    if (!data.results || !Array.isArray(data.results)) return new Set();
    return new Set(data.results.map(r => r.filing_date).filter(Boolean));
  } catch (e) {
    console.warn(`[backtest] Earnings dates unavailable for ${symbol}: ${e.message}`);
    return new Set();
  }
}

// ─── CONTEXT BUILDER ──────────────────────────────────────────────────────────

/**
 * Builds per-bar indicator context shared by the trading engine.
 * mode: 'day' (15-min bars, EOD close) | 'swing' (daily bars, max hold 30d)
 */
function buildContext(bars, mode, symbol, earningsDates = new Set()) {
  const closes  = bars.map(b => b.c);
  const volumes = bars.map(b => b.v || 0);
  return {
    symbol,
    mode,
    earningsDates,
    atr:      calculateATR(bars),
    ema200:   calculateEMA(closes, 200),
    avgVol20: calculateVolAvg(volumes),
    skipped:  { vol: 0, trend: 0, earnings: 0 },
    circuitBreakerCount: 0,
  };
}

// ─── CORE TRADING ENGINE ──────────────────────────────────────────────────────

function buildTrade(entry, exitIdx, bars, rawExitPx, exitReason, ctx, extraSlip = 0) {
  const bar      = bars[exitIdx];
  const exitSlip = dynamicSlippage(bar.v || 0, entry.avgVol) + extraSlip;
  const exitPx   = rawExitPx * (1 - exitSlip);
  const exitFees = calcFees(entry.shares, exitPx * entry.shares, 'sell');
  const totFees  = (entry.entryFees || 5) + exitFees;
  const netPnl   = (exitPx - entry.price) * entry.shares - totFees;
  const pnlPct   = (exitPx - entry.price) / entry.price * 100;
  return {
    entryDate:       new Date(bars[entry.barIdx].t).toISOString().split('T')[0],
    exitDate:        new Date(bar.t).toISOString().split('T')[0],
    entryPrice:      parseFloat(entry.price.toFixed(2)),
    exitPrice:       parseFloat(exitPx.toFixed(2)),
    pnl:             parseFloat(netPnl.toFixed(2)),
    pnlPct:          parseFloat(pnlPct.toFixed(2)),
    result:          netPnl >= 0 ? 'WIN' : 'LOSS',
    exitReason,
    holdingBars:     exitIdx - entry.barIdx,
    stopLoss:        parseFloat(entry.stopLoss.toFixed(2)),
    takeProfit:      parseFloat(entry.takeProfit.toFixed(2)),
    riskReward:      parseFloat(entry.riskReward.toFixed(2)),
    atr:             parseFloat(entry.atr.toFixed(4)),
    positionSize:    entry.shares,
    positionValue:   parseFloat((entry.price * entry.shares).toFixed(2)),
    commission:      parseFloat(totFees.toFixed(2)),
    volumeConfirmed: entry.volumeConfirmed,
    gapRisk:         entry.gapRisk || false,
    gapPct:          entry.gapPct  || 0,
  };
}

/**
 * Shared trading loop with all 14 realism improvements.
 * signalFns = { shouldEnter(bars,i,ctx), shouldExit(bars,i,entry,ctx) }
 */
function runCore(bars, capital, ctx, signalFns) {
  const trades = [];
  let inTrade           = false;
  let entry             = null;
  let consecutiveLosses = 0;
  let pauseBars         = 0;

  // Closes the current trade, records it, updates circuit breaker.
  const close = (exitIdx, rawPx, reason, extraSlip = 0) => {
    const t = buildTrade(entry, exitIdx, bars, rawPx, reason, ctx, extraSlip);
    trades.push(t);
    if (t.result === 'LOSS') consecutiveLosses++;
    else                     consecutiveLosses = 0;
    if (consecutiveLosses >= 3) {
      pauseBars = 5; consecutiveLosses = 0; ctx.circuitBreakerCount++;
      console.log(`[backtest] Circuit breaker triggered — 3 consecutive losses, pausing for 5 bars`);
    }
    inTrade = false; entry = null;
  };

  for (let i = 0; i < bars.length; i++) {
    const bar     = bars[i];
    const dateStr = new Date(bar.t).toISOString().split('T')[0];

    // ── IMPROVEMENT 1–10: In-trade management ──────────────────────────────
    if (inTrade) {

      // Improvement 3: Gap risk — check open vs previous close
      if (i > entry.barIdx && bar.o > 0 && bars[i - 1].c > 0) {
        const gapPct = (bar.o - bars[i - 1].c) / bars[i - 1].c * 100;
        if (Math.abs(gapPct) > 1.5) {
          entry.gapRisk = true;
          entry.gapPct  = parseFloat(gapPct.toFixed(2));
          // Gap down through stop: exit at gap open
          if (gapPct < -1.5 && bar.o <= entry.stopLoss) {
            close(i, bar.o, 'Stop Loss (Gap)');
            continue;
          }
        }
      }

      // Improvement 2: Earnings blackout — exit if earnings ≤2 days away
      const earningsDist = daysUntilEarnings(ctx.earningsDates, dateStr);
      if (earningsDist !== null && earningsDist <= 2) {
        close(i, bar.c, 'Earnings Blackout');
        continue;
      }

      // Improvement 4: EOD force close (day/15-min bars only)
      if (ctx.mode === 'day') {
        const min = getETMinuteOfDay(bar.t);
        if (min >= 945) { // 3:45 PM ET
          close(i, bar.c, 'End of Day Force Close', 0.0005);
          continue;
        }
      }

      // Improvement 5: Max hold period (swing / daily bars)
      if (ctx.mode !== 'day') {
        const holdDays = (bar.t - bars[entry.barIdx].t) / 86400000;
        if (holdDays >= MAX_HOLD_DAYS) {
          close(i, bar.c, 'Max Hold Period (30 days)');
          continue;
        }
      }

      // Improvement 8: ATR-based stop loss (checked via bar.l intrabar)
      if (bar.l <= entry.stopLoss) {
        close(i, entry.stopLoss, 'Stop Loss');
        continue;
      }

      // Improvement 8: ATR-based take profit (checked via bar.h intrabar)
      if (bar.h >= entry.takeProfit) {
        close(i, entry.takeProfit, 'Take Profit');
        continue;
      }

      // Strategy-specific exit signal
      const exitSig = signalFns.shouldExit(bars, i, entry, ctx);
      if (exitSig.exit) {
        close(i, bar.c, exitSig.reason);
        continue;
      }
    }

    // ── Entry logic ─────────────────────────────────────────────────────────
    if (!inTrade) {

      // Improvement 6: Circuit breaker pause
      if (pauseBars > 0) { pauseBars--; continue; }

      // Strategy entry signal
      if (!signalFns.shouldEnter(bars, i, ctx)) continue;

      // Improvement 9: Trend filter — only enter when price > EMA200
      if (ctx.ema200[i] !== null && bar.c < ctx.ema200[i]) {
        ctx.skipped.trend++;
        console.log(`[backtest] Signal skipped — against major trend (EMA200 filter)`);
        continue;
      }

      // Improvement 1: Volume confirmation — require 1.2× 20-bar avg volume
      const avgVol = ctx.avgVol20[i];
      if (avgVol !== null && bar.v < avgVol * 1.2) {
        ctx.skipped.vol++;
        console.log(`[backtest] Signal skipped — low volume confirmation`);
        continue;
      }

      // Improvement 2: Earnings blackout — skip if earnings ≤3 days away
      const earningsDist = daysUntilEarnings(ctx.earningsDates, dateStr);
      if (earningsDist !== null && earningsDist <= 3) {
        ctx.skipped.earnings++;
        console.log(`[backtest] Trade skipped — earnings within 3 days for ${ctx.symbol}`);
        continue;
      }

      // Improvement 7 & 8 & 10: ATR sizing, dynamic stops, dynamic slippage
      const slip       = dynamicSlippage(bar.v, avgVol);
      const entryPx    = bar.c * (1 + slip);
      const atrVal     = (ctx.atr[i] && ctx.atr[i] > 0) ? ctx.atr[i] : entryPx * 0.02;
      const { stopLoss, takeProfit, riskReward } = calcATRStops(entryPx, atrVal);
      const shares     = calcPositionSize(entryPx, atrVal, capital);
      const entryFees  = calcFees(shares, entryPx * shares, 'buy');

      inTrade = true;
      entry   = {
        barIdx: i, price: entryPx, stopLoss, takeProfit, riskReward,
        shares, atr: atrVal, avgVol: avgVol || bar.v || 1,
        entryFees, volumeConfirmed: true, gapRisk: false, gapPct: 0,
      };
    }
  }

  // Close any open trade at end of data
  if (inTrade && entry) {
    const last = bars.length - 1;
    close(last, bars[last].c, 'End of Data');
  }

  return trades;
}

// ─── STRATEGIES ───────────────────────────────────────────────────────────────

function runRSIStrategy(bars, capital, ctx) {
  const rsi = calculateRSI(bars.map(b => b.c), 14);
  ctx.rsi   = rsi;
  return runCore(bars, capital, ctx, {
    shouldEnter: (bars, i, ctx) =>
      i > 0 && ctx.rsi[i] !== null && ctx.rsi[i] < 35 && ctx.rsi[i - 1] >= 35,
    shouldExit: (bars, i, entry, ctx) => ({
      exit:   ctx.rsi[i] !== null && ctx.rsi[i] > 65 && (ctx.rsi[i - 1] === null || ctx.rsi[i - 1] <= 65),
      reason: 'RSI Exit',
    }),
  });
}

function runMACDStrategy(bars, capital, ctx) {
  const { histogram } = calculateMACD(bars.map(b => b.c));
  ctx.histogram = histogram;
  return runCore(bars, capital, ctx, {
    shouldEnter: (bars, i, ctx) =>
      i > 0 && ctx.histogram[i] !== null && ctx.histogram[i - 1] !== null &&
      ctx.histogram[i] > 0 && ctx.histogram[i - 1] <= 0,
    shouldExit: (bars, i, entry, ctx) => ({
      exit:   ctx.histogram[i] !== null && ctx.histogram[i - 1] !== null &&
              ctx.histogram[i] < 0 && ctx.histogram[i - 1] >= 0,
      reason: 'MACD Cross',
    }),
  });
}

function runEMA2050Strategy(bars, capital, ctx) {
  const closes = bars.map(b => b.c);
  ctx.ema20    = calculateEMA(closes, 20);
  ctx.ema50    = calculateEMA(closes, 50);
  return runCore(bars, capital, ctx, {
    shouldEnter: (bars, i, ctx) =>
      i > 0 &&
      ctx.ema20[i] !== null && ctx.ema50[i] !== null &&
      ctx.ema20[i - 1] !== null && ctx.ema50[i - 1] !== null &&
      ctx.ema20[i] > ctx.ema50[i] && ctx.ema20[i - 1] <= ctx.ema50[i - 1],
    shouldExit: (bars, i, entry, ctx) => ({
      exit:   ctx.ema20[i] !== null && ctx.ema50[i] !== null &&
              ctx.ema20[i - 1] !== null && ctx.ema50[i - 1] !== null &&
              ctx.ema20[i] < ctx.ema50[i] && ctx.ema20[i - 1] >= ctx.ema50[i - 1],
      reason: 'Death Cross',
    }),
  });
}

// ─── SUMMARY STATS ────────────────────────────────────────────────────────────

function calculateSummary(trades, startingCapital, ctx, bars) {
  // Improvement 12: benchmark comparison
  const bm = calculateBenchmark(bars, startingCapital);

  const empty = {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    totalPnl: 0, totalPnlPct: 0, maxDrawdown: 0,
    avgWin: 0, avgLoss: 0, profitFactor: 0, finalEquity: startingCapital,
    sharpeRatio: 0,
    benchmarkReturn: bm.benchmarkReturn,
    benchmarkPnl:    bm.benchmarkPnl,
    alphaPct:        parseFloat((0 - bm.benchmarkReturn).toFixed(2)),
    circuitBreakerTriggered: ctx ? ctx.circuitBreakerCount : 0,
    skippedSignals:  ctx ? { ...ctx.skipped } : { vol: 0, trend: 0, earnings: 0 },
    avgPositionValue: 0,
  };
  if (!trades.length) return empty;

  const wins      = trades.filter(t => t.result === 'WIN');
  const losses    = trades.filter(t => t.result === 'LOSS');
  const totalPnl  = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  let peak = startingCapital, cap = startingCapital, maxDD = 0;
  for (const t of trades) {
    cap += t.pnl;
    if (cap > peak) peak = cap;
    const dd = (peak - cap) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const totalPnlPct = parseFloat((totalPnl / startingCapital * 100).toFixed(2));
  const sharpe      = calculateSharpe(trades);
  const alphaPct    = parseFloat((totalPnlPct - bm.benchmarkReturn).toFixed(2));
  const avgPosnVal  = parseFloat((trades.reduce((s, t) => s + (t.positionValue || 0), 0) / trades.length).toFixed(2));

  return {
    totalTrades:  trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      parseFloat((wins.length / trades.length * 100).toFixed(1)),
    totalPnl:     parseFloat(totalPnl.toFixed(2)),
    totalPnlPct,
    maxDrawdown:  parseFloat(maxDD.toFixed(2)),
    avgWin:       wins.length   ? parseFloat((grossWin  / wins.length).toFixed(2))   : 0,
    avgLoss:      losses.length ? parseFloat((grossLoss / losses.length).toFixed(2)) : 0,
    profitFactor: grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 999 : 0,
    finalEquity:  parseFloat((startingCapital + totalPnl).toFixed(2)),
    sharpeRatio:  sharpe,
    benchmarkReturn: bm.benchmarkReturn,
    benchmarkPnl:    bm.benchmarkPnl,
    alphaPct,
    circuitBreakerTriggered: ctx ? ctx.circuitBreakerCount : 0,
    skippedSignals: ctx ? { ...ctx.skipped } : { vol: 0, trend: 0, earnings: 0 },
    avgPositionValue: avgPosnVal,
  };
}

// ─── ZERO-TRADE MESSAGES ──────────────────────────────────────────────────────

const ZERO_MESSAGES = {
  rsi:               s => `No RSI oversold crossings found for ${s} in this period. Filters (volume, trend, earnings) may have blocked signals — try a longer range.`,
  rsi_mean_reversion:s => `No RSI oversold crossings found for ${s} in this period. Try a longer date range or a more volatile symbol.`,
  macd:              s => `No MACD histogram crossovers found for ${s} in this period. Filters may have blocked signals — try a longer range.`,
  macd_crossover:    s => `No MACD histogram crossovers found for ${s} in this period. Try a longer date range or a more volatile symbol.`,
  ema2050:           s => `No EMA20/50 golden cross found for ${s} in this period. Try a longer date range (at least 6 months recommended).`,
  ema_cross:         s => `No EMA20/50 golden cross found for ${s} in this period. Try a longer date range (at least 6 months recommended).`,
  combined:          s => `No EMA20/50 golden cross found for ${s} in this period. Try a longer date range (at least 6 months recommended).`,
  golden_cross:      s => `No EMA20/50 golden cross found for ${s} in this period. Try at least 6 months of data for this strategy.`,
  rsi_macd:          s => `No RSI oversold crossings found for ${s} in this period. Try a longer date range or a more volatile symbol.`,
};

function resolveStrategy(name) {
  const n = (name || '').toLowerCase();
  if (n === 'macd' || n === 'macd_crossover') return 'macd';
  if (n === 'rsi'  || n === 'rsi_mean_reversion' || n === 'rsi_macd') return 'rsi';
  return 'ema2050';
}

function runStrategy(name, bars, capital, ctx) {
  if (name === 'macd') return runMACDStrategy(bars, capital, ctx);
  if (name === 'rsi')  return runRSIStrategy(bars, capital, ctx);
  return runEMA2050Strategy(bars, capital, ctx);
}

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
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'Rate limit reached. Please wait.' });

  const key = process.env.POLYGON_API_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_API_KEY not configured on server.' });

  const src = req.method === 'POST' ? (req.body || {}) : req.query;

  const rawSym = String(src.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
  if (!rawSym) return res.status(400).json({ error: 'symbol is required' });

  const startDate = String(src.startDate || '').replace(/[^0-9\-]/g, '').slice(0, 10);
  const endDate   = String(src.endDate   || '').replace(/[^0-9\-]/g, '').slice(0, 10);
  if (!startDate || !endDate)
    return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });

  const mode = String(src.mode || 'swing').toLowerCase();
  if (!['day', 'swing', 'both'].includes(mode))
    return res.status(400).json({ error: "mode must be 'day', 'swing', or 'both'" });

  const dayStrategy   = resolveStrategy(src.dayStrategy   || src.strategy || 'macd');
  const swingStrategy = resolveStrategy(src.swingStrategy || src.strategy || 'ema2050');

  const totalCapital = Math.max(100, parseFloat(src.capital || '10000') || 10000);
  const dayCapital   = parseFloat((totalCapital * 0.40).toFixed(2));
  const swingCapital = parseFloat((totalCapital * 0.60).toFixed(2));

  console.log(`[backtest] ${rawSym} ${startDate}→${endDate} mode=${mode} cap=$${totalCapital}`);

  try {
    // ── Fetch daily bars (always) ────────────────────────────────────────────
    const dailyBars = await fetchBars(rawSym, 1, 'day', startDate, endDate, key);
    if (!dailyBars.length)
      return res.status(422).json({
        error: `No daily data returned for ${rawSym} from ${startDate} to ${endDate}. Check the ticker and date range.`,
      });
    if (dailyBars.length < 30)
      return res.status(422).json({
        error: `Only ${dailyBars.length} daily bars — need at least 30. Widen the date range.`,
      });

    // ── For day / both: try to fetch 15-min bars (graceful fallback) ─────────
    let dayBars = dailyBars; // fallback to daily if intraday unavailable
    if (mode === 'day' || mode === 'both') {
      try {
        const intraday = await fetchBars(rawSym, 15, 'minute', startDate, endDate, key);
        if (intraday.length >= 50) {
          dayBars = intraday;
          console.log(`[backtest] Using ${intraday.length} 15-min bars for day strategy`);
        } else {
          console.log(`[backtest] Insufficient 15-min bars (${intraday.length}), using daily`);
        }
      } catch (e) {
        console.warn(`[backtest] 15-min fetch failed, using daily: ${e.message}`);
      }
    }

    // ── Improvement 2: Fetch earnings dates (graceful failure) ───────────────
    let earningsDates = new Set();
    try { earningsDates = await fetchEarningsDates(rawSym, key); }
    catch (e) { console.warn(`[backtest] Earnings fetch failed: ${e.message}`); }

    // ── SINGLE MODE: day ─────────────────────────────────────────────────────
    if (mode === 'day') {
      const ctx     = buildContext(dayBars, 'day', rawSym, earningsDates);
      const trades  = runStrategy(dayStrategy, dayBars, dayCapital, ctx);
      const summary = calculateSummary(trades, dayCapital, ctx, dailyBars);
      const message = trades.length === 0 ? (ZERO_MESSAGES[dayStrategy]?.(rawSym) ?? null) : null;
      return res.status(200).json({
        symbol: rawSym, mode, strategy: dayStrategy,
        startDate, endDate,
        capital: totalCapital, deployedCapital: dayCapital,
        barsUsed: dayBars.length,
        message, summary, trades,
      });
    }

    // ── SINGLE MODE: swing ────────────────────────────────────────────────────
    if (mode === 'swing') {
      const ctx     = buildContext(dailyBars, 'swing', rawSym, earningsDates);
      const trades  = runStrategy(swingStrategy, dailyBars, swingCapital, ctx);
      const summary = calculateSummary(trades, swingCapital, ctx, dailyBars);
      const message = trades.length === 0 ? (ZERO_MESSAGES[swingStrategy]?.(rawSym) ?? null) : null;
      return res.status(200).json({
        symbol: rawSym, mode, strategy: swingStrategy,
        startDate, endDate,
        capital: totalCapital, deployedCapital: swingCapital,
        barsUsed: dailyBars.length,
        message, summary, trades,
      });
    }

    // ── BOTH MODE ─────────────────────────────────────────────────────────────
    const dayCtx    = buildContext(dayBars,   'day',   rawSym, earningsDates);
    const swingCtx  = buildContext(dailyBars, 'swing', rawSym, earningsDates);
    const dayTrades   = runStrategy(dayStrategy,   dayBars,   dayCapital,   dayCtx);
    const swingTrades = runStrategy(swingStrategy, dailyBars, swingCapital, swingCtx);
    const dayMsg      = dayTrades.length   === 0 ? (ZERO_MESSAGES[dayStrategy]?.(rawSym)   ?? null) : null;
    const swingMsg    = swingTrades.length === 0 ? (ZERO_MESSAGES[swingStrategy]?.(rawSym) ?? null) : null;
    const daySummary  = calculateSummary(dayTrades,   dayCapital,   dayCtx,   dayBars);
    const swingSummary= calculateSummary(swingTrades, swingCapital, swingCtx, dailyBars);

    const combinedPnl    = daySummary.totalPnl + swingSummary.totalPnl;
    const combinedPnlPct = (combinedPnl / totalCapital) * 100;

    return res.status(200).json({
      symbol: rawSym,
      mode:   'both',
      startDate, endDate,
      capital: totalCapital, dayCapital, swingCapital,
      dayResult: {
        strategy: dayStrategy,
        barsUsed: dayBars.length,
        message:  dayMsg,
        summary:  daySummary,
        trades:   dayTrades,
      },
      swingResult: {
        strategy: swingStrategy,
        barsUsed: dailyBars.length,
        message:  swingMsg,
        summary:  swingSummary,
        trades:   swingTrades,
      },
      combined: {
        totalTrades: dayTrades.length + swingTrades.length,
        totalPnl:    parseFloat(combinedPnl.toFixed(2)),
        totalPnlPct: parseFloat(combinedPnlPct.toFixed(2)),
        finalEquity: parseFloat((totalCapital + combinedPnl).toFixed(2)),
        maxDrawdown: parseFloat(Math.max(daySummary.maxDrawdown, swingSummary.maxDrawdown).toFixed(2)),
        equityCurve: [],
      },
    });

  } catch (err) {
    console.error('[backtest] Error:', rawSym, err.message);
    return res.status(500).json({ error: `Backtest failed: ${err.message}` });
  }
};
