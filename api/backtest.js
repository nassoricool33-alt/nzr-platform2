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

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return [];
  const rsi = new Array(closes.length).fill(null);

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = 100 - (100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss)));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = 100 - (100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss)));
  }
  return rsi;
}

function calculateEMA(closes, period) {
  if (closes.length < period) return [];
  const ema = new Array(closes.length).fill(null);
  const k = 2 / (period + 1);

  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  ema[period - 1] = sum / period;

  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return { macd: [], signal: [], histogram: [] };

  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);

  const macdLine = closes.map((_, i) => {
    if (emaFast[i] === null || emaSlow[i] === null) return null;
    return emaFast[i] - emaSlow[i];
  });

  const signalLine = new Array(closes.length).fill(null);
  const firstValidIdx = macdLine.findIndex(v => v !== null);
  if (firstValidIdx === -1) return { macd: macdLine, signal: signalLine, histogram: signalLine };

  const k = 2 / (signal + 1);
  let sum = 0, count = 0;
  for (let i = firstValidIdx; i < firstValidIdx + signal; i++) {
    if (macdLine[i] !== null) { sum += macdLine[i]; count++; }
  }
  signalLine[firstValidIdx + signal - 1] = sum / count;

  for (let i = firstValidIdx + signal; i < closes.length; i++) {
    if (macdLine[i] !== null && signalLine[i - 1] !== null) {
      signalLine[i] = macdLine[i] * k + signalLine[i - 1] * (1 - k);
    }
  }

  const histogram = closes.map((_, i) => {
    if (macdLine[i] === null || signalLine[i] === null) return null;
    return macdLine[i] - signalLine[i];
  });

  return { macd: macdLine, signal: signalLine, histogram };
}

// ─── STRATEGIES ───────────────────────────────────────────────────────────────

function runRSIStrategy(bars, capital, slippage = 0.001) {
  const closes = bars.map(b => b.c);
  const rsi = calculateRSI(closes, 14);
  const trades = [];
  let inTrade = false;
  let entryBar = null;
  let entryPrice = null;

  for (let i = 15; i < bars.length; i++) {
    if (rsi[i] === null) continue;

    if (!inTrade && rsi[i] < 35 && rsi[i - 1] >= 35) {
      inTrade = true;
      entryBar = bars[i];
      entryPrice = bars[i].c * (1 + slippage);
    }

    if (inTrade) {
      const stopLoss = entryPrice * 0.97;
      const takeProfit = entryPrice * 1.06;
      const currentPrice = bars[i].c;

      const hitStop = currentPrice <= stopLoss;
      const hitTarget = currentPrice >= takeProfit;
      const rsiExit = rsi[i] > 65 && rsi[i - 1] <= 65;

      if (hitStop || hitTarget || rsiExit) {
        const exitPrice = currentPrice * (1 - slippage);
        const pnl = (exitPrice - entryPrice) * Math.floor((capital * 0.1) / entryPrice);
        trades.push({
          entryDate: new Date(entryBar.t).toISOString().split('T')[0],
          exitDate: new Date(bars[i].t).toISOString().split('T')[0],
          entryPrice: parseFloat(entryPrice.toFixed(2)),
          exitPrice: parseFloat(exitPrice.toFixed(2)),
          pnl: parseFloat(pnl.toFixed(2)),
          pnlPct: parseFloat(((exitPrice - entryPrice) / entryPrice * 100).toFixed(2)),
          result: pnl >= 0 ? 'WIN' : 'LOSS',
          exitReason: hitStop ? 'Stop Loss' : hitTarget ? 'Take Profit' : 'RSI Exit',
          holdingBars: i - bars.indexOf(entryBar),
        });
        inTrade = false;
        entryBar = null;
        entryPrice = null;
      }
    }
  }
  return trades;
}

function runMACDStrategy(bars, capital, slippage = 0.001) {
  const closes = bars.map(b => b.c);
  const { macd, signal, histogram } = calculateMACD(closes);
  const trades = [];
  let inTrade = false;
  let entryBar = null;
  let entryPrice = null;

  for (let i = 27; i < bars.length; i++) {
    if (histogram[i] === null || histogram[i - 1] === null) continue;

    if (!inTrade && histogram[i] > 0 && histogram[i - 1] <= 0) {
      inTrade = true;
      entryBar = bars[i];
      entryPrice = bars[i].c * (1 + slippage);
    }

    if (inTrade) {
      const stopLoss = entryPrice * 0.975;
      const currentPrice = bars[i].c;

      const hitStop = currentPrice <= stopLoss;
      const macdExit = histogram[i] < 0 && histogram[i - 1] >= 0;

      if (hitStop || macdExit) {
        const exitPrice = currentPrice * (1 - slippage);
        const pnl = (exitPrice - entryPrice) * Math.floor((capital * 0.1) / entryPrice);
        trades.push({
          entryDate: new Date(entryBar.t).toISOString().split('T')[0],
          exitDate: new Date(bars[i].t).toISOString().split('T')[0],
          entryPrice: parseFloat(entryPrice.toFixed(2)),
          exitPrice: parseFloat(exitPrice.toFixed(2)),
          pnl: parseFloat(pnl.toFixed(2)),
          pnlPct: parseFloat(((exitPrice - entryPrice) / entryPrice * 100).toFixed(2)),
          result: pnl >= 0 ? 'WIN' : 'LOSS',
          exitReason: hitStop ? 'Stop Loss' : 'MACD Cross',
          holdingBars: i - bars.indexOf(entryBar),
        });
        inTrade = false;
        entryBar = null;
        entryPrice = null;
      }
    }
  }
  return trades;
}

function runEMA2050Strategy(bars, capital, slippage = 0.001) {
  const closes = bars.map(b => b.c);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const trades = [];
  let inTrade = false;
  let entryBar = null;
  let entryPrice = null;

  for (let i = 51; i < bars.length; i++) {
    if (ema20[i] === null || ema50[i] === null) continue;

    const goldenCross = ema20[i] > ema50[i] && ema20[i - 1] <= ema50[i - 1];
    const deathCross = ema20[i] < ema50[i] && ema20[i - 1] >= ema50[i - 1];

    if (!inTrade && goldenCross) {
      inTrade = true;
      entryBar = bars[i];
      entryPrice = bars[i].c * (1 + slippage);
    }

    if (inTrade) {
      const stopLoss = entryPrice * 0.97;
      const currentPrice = bars[i].c;

      if (deathCross || currentPrice <= stopLoss) {
        const exitPrice = currentPrice * (1 - slippage);
        const pnl = (exitPrice - entryPrice) * Math.floor((capital * 0.1) / entryPrice);
        trades.push({
          entryDate: new Date(entryBar.t).toISOString().split('T')[0],
          exitDate: new Date(bars[i].t).toISOString().split('T')[0],
          entryPrice: parseFloat(entryPrice.toFixed(2)),
          exitPrice: parseFloat(exitPrice.toFixed(2)),
          pnl: parseFloat(pnl.toFixed(2)),
          pnlPct: parseFloat(((exitPrice - entryPrice) / entryPrice * 100).toFixed(2)),
          result: pnl >= 0 ? 'WIN' : 'LOSS',
          exitReason: currentPrice <= stopLoss ? 'Stop Loss' : 'Death Cross',
          holdingBars: i - bars.indexOf(entryBar),
        });
        inTrade = false;
        entryBar = null;
        entryPrice = null;
      }
    }
  }
  return trades;
}

// ─── SUMMARY STATS ────────────────────────────────────────────────────────────

function calculateSummary(trades, startingCapital) {
  if (trades.length === 0) return {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    totalPnl: 0, totalPnlPct: 0, maxDrawdown: 0,
    avgWin: 0, avgLoss: 0, profitFactor: 0,
  };

  const wins = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const grossWin = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  let peak = startingCapital;
  let capital = startingCapital;
  let maxDrawdown = 0;
  for (const t of trades) {
    capital += t.pnl;
    if (capital > peak) peak = capital;
    const drawdown = (peak - capital) / peak * 100;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: parseFloat((wins.length / trades.length * 100).toFixed(1)),
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    totalPnlPct: parseFloat((totalPnl / startingCapital * 100).toFixed(2)),
    maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
    avgWin: wins.length ? parseFloat((grossWin / wins.length).toFixed(2)) : 0,
    avgLoss: losses.length ? parseFloat((grossLoss / losses.length).toFixed(2)) : 0,
    profitFactor: grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 999 : 0,
  };
}

// ─── ZERO-TRADE MESSAGES ──────────────────────────────────────────────────────

const ZERO_MESSAGES = {
  rsi:              s => `No RSI oversold crossings found for ${s} in this period. Try a longer date range or a more volatile symbol.`,
  rsi_mean_reversion: s => `No RSI oversold crossings found for ${s} in this period. Try a longer date range or a more volatile symbol.`,
  macd:             s => `No MACD histogram crossovers found for ${s} in this period. Try a longer date range or a more volatile symbol.`,
  macd_crossover:   s => `No MACD histogram crossovers found for ${s} in this period. Try a longer date range or a more volatile symbol.`,
  ema2050:          s => `No EMA20/50 golden cross found for ${s} in this period. Try a longer date range (at least 6 months recommended).`,
  ema_cross:        s => `No EMA20/50 golden cross found for ${s} in this period. Try a longer date range (at least 6 months recommended).`,
  combined:         s => `No EMA20/50 golden cross found for ${s} in this period. Try a longer date range (at least 6 months recommended).`,
  golden_cross:     s => `No EMA20/50 golden cross found for ${s} in this period. Try a longer date range (at least 6 months recommended).`,
  rsi_macd:         s => `No RSI oversold crossings found for ${s} in this period. Try a longer date range or a more volatile symbol.`,
};

function resolveStrategy(name) {
  const n = (name || '').toLowerCase();
  if (n === 'macd' || n === 'macd_crossover') return 'macd';
  if (n === 'rsi' || n === 'rsi_mean_reversion' || n === 'rsi_macd') return 'rsi';
  return 'ema2050'; // ema_cross, ema2050, combined, golden_cross
}

function runStrategy(name, bars, capital) {
  if (name === 'macd') return runMACDStrategy(bars, capital);
  if (name === 'rsi')  return runRSIStrategy(bars, capital);
  return runEMA2050Strategy(bars, capital);
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

  // strategy resolution
  const dayStrategy   = resolveStrategy(src.dayStrategy   || src.strategy || 'macd');
  const swingStrategy = resolveStrategy(src.swingStrategy || src.strategy || 'ema2050');

  const totalCapital = Math.max(100, parseFloat(src.capital || '10000') || 10000);
  const dayCapital   = parseFloat((totalCapital * 0.40).toFixed(2));
  const swingCapital = parseFloat((totalCapital * 0.60).toFixed(2));

  console.log(`[backtest] ${rawSym} ${startDate}→${endDate} mode=${mode} cap=$${totalCapital}`);

  try {
    // ── Fetch daily bars (all modes use daily bars) ───────────────────────────
    const dailyBars = await fetchBars(rawSym, 1, 'day', startDate, endDate, key);
    if (!dailyBars.length) {
      return res.status(422).json({
        error: `No daily data returned for ${rawSym} from ${startDate} to ${endDate}. Check the ticker and date range.`,
      });
    }
    if (dailyBars.length < 30) {
      return res.status(422).json({ error: `Only ${dailyBars.length} daily bars found — need at least 30. Widen the date range.` });
    }

    // ── SINGLE MODE: day ─────────────────────────────────────────────────────
    if (mode === 'day') {
      const capUsed = dayCapital;
      const trades  = runStrategy(dayStrategy, dailyBars, capUsed);
      const summary = calculateSummary(trades, capUsed);
      const message = trades.length === 0 ? (ZERO_MESSAGES[dayStrategy]?.(rawSym) ?? null) : null;

      return res.status(200).json({
        symbol: rawSym, mode, strategy: dayStrategy,
        startDate, endDate,
        capital: totalCapital, deployedCapital: capUsed,
        barsUsed: dailyBars.length,
        message, summary, trades,
      });
    }

    // ── SINGLE MODE: swing ────────────────────────────────────────────────────
    if (mode === 'swing') {
      const capUsed = swingCapital;
      const trades  = runStrategy(swingStrategy, dailyBars, capUsed);
      const summary = calculateSummary(trades, capUsed);
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
    const dayTrades    = runStrategy(dayStrategy, dailyBars, dayCapital);
    const swingTrades  = runStrategy(swingStrategy, dailyBars, swingCapital);
    const dayMsg       = dayTrades.length   === 0 ? (ZERO_MESSAGES[dayStrategy]?.(rawSym)   ?? null) : null;
    const swingMsg     = swingTrades.length === 0 ? (ZERO_MESSAGES[swingStrategy]?.(rawSym) ?? null) : null;
    const daySummary   = calculateSummary(dayTrades, dayCapital);
    const swingSummary = calculateSummary(swingTrades, swingCapital);

    // Combined portfolio performance
    const combinedPnl    = daySummary.totalPnl + swingSummary.totalPnl;
    const combinedPnlPct = (combinedPnl / totalCapital) * 100;
    const combinedCurve  = [];

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
        finalEquity:   parseFloat((totalCapital + combinedPnl).toFixed(2)),
        maxDrawdown:   parseFloat(Math.max(daySummary.maxDrawdown, swingSummary.maxDrawdown).toFixed(2)),
        equityCurve:   combinedCurve,
      },
    });

  } catch (err) {
    console.error('[backtest] Error:', rawSym, err.message);
    return res.status(500).json({ error: `Backtest failed: ${err.message}` });
  }
};
