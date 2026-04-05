/**
 * NZR Backtest Engine
 * Fetches historical OHLCV from Polygon and simulates strategy performance.
 * All indicator math is computed from scratch — no external library.
 */

const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 10;
  const entry = rateLimit.get(ip);
  if (!entry || now - entry.start > w) { rateLimit.set(ip, { count: 1, start: now }); return true; }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Invalid JSON response from Polygon')); } });
    }).on('error', reject);
  });
}

// ─── TECHNICAL INDICATOR MATH ─────────────────────────────────────────────────

/**
 * EMA seeded from first close value.
 * ema[0] = closes[0], then ema[i] = closes[i]*k + ema[i-1]*(1-k)
 * Values exist for ALL bars — no null warmup period.
 * For meaningful results, only use from bar >= period.
 */
function calcEMA(closes, period) {
  if (!closes.length) return [];
  const k = 2 / (period + 1);
  const ema = new Array(closes.length);
  ema[0] = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

/**
 * Wilder-smoothed RSI.
 * Returns array of nulls for the first `period` indices, then RSI values.
 */
function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;

  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? Math.abs(diff) : 0);
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i - 1]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i - 1]) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }

  return rsi;
}

/**
 * MACD = EMA12 - EMA26, Signal = EMA9(MACD), Histogram = MACD - Signal.
 * All values exist from bar 0 (seeded from first close). Only meaningful from bar 26+.
 */
function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);

  // Signal = EMA9 of macdLine (also seeded from first value)
  const sigK = 2 / (9 + 1);
  const signalLine = new Array(closes.length);
  signalLine[0] = macdLine[0];
  for (let i = 1; i < closes.length; i++) {
    signalLine[i] = macdLine[i] * sigK + signalLine[i - 1] * (1 - sigK);
  }

  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

// ─── TRADE SIMULATION ─────────────────────────────────────────────────────────

const STOP_LOSS_PCT = 0.05; // 5% hard stop

/**
 * Golden Cross strategy.
 * Entry: EMA60 crosses above EMA200 (golden cross).
 * Exit:  EMA60 crosses back below EMA200 (death cross) OR 5% stop loss.
 * Only scans from bar 200 so EMA200 has had time to warm up.
 */
function simulateGoldenCross(bars) {
  const closes = bars.map(b => b.c);
  const ema60  = calcEMA(closes, 60);
  const ema200 = calcEMA(closes, 200);
  const trades = [];
  let inTrade = false;
  let entry   = null;

  // Start from bar 200: give EMA200 enough bars to be meaningful
  const startBar = Math.min(200, bars.length - 1);

  for (let i = startBar; i < bars.length; i++) {
    const goldenCross = ema60[i] > ema200[i] && ema60[i - 1] <= ema200[i - 1];
    const deathCross  = ema60[i] < ema200[i] && ema60[i - 1] >= ema200[i - 1];

    if (!inTrade) {
      if (goldenCross) {
        inTrade = true;
        entry = { date: bars[i].t, price: bars[i].c, stopPrice: bars[i].c * (1 - STOP_LOSS_PCT) };
      }
    } else {
      const stopHit = bars[i].l <= entry.stopPrice;
      if (stopHit || deathCross) {
        const exitPrice = stopHit ? entry.stopPrice : bars[i].c;
        trades.push(makeTrade(bars[i].t, entry.date, entry.price, exitPrice));
        inTrade = false;
        entry   = null;
      }
    }
  }

  // Close any open trade at last bar
  if (inTrade && entry) {
    trades.push(makeTrade(bars[bars.length - 1].t, entry.date, entry.price, bars[bars.length - 1].c));
  }

  return trades;
}

/**
 * RSI + MACD strategy.
 * Entry: RSI < 35 AND MACD histogram turns positive (previous bar was negative or zero).
 * Exit:  RSI > 70 OR histogram turns negative.
 * Scans from bar 35 (MACD needs ~26 bars, RSI needs 14).
 */
function simulateRsiMacd(bars) {
  const closes          = bars.map(b => b.c);
  const rsi             = calcRSI(closes, 14);
  const { histogram }   = calcMACD(closes);
  const trades          = [];
  let inTrade = false;
  let entry   = null;

  for (let i = 35; i < bars.length; i++) {
    if (rsi[i] === null) continue;

    if (!inTrade) {
      // BUY: RSI oversold AND MACD histogram just turned positive
      if (rsi[i] < 35 && histogram[i] > 0 && histogram[i - 1] <= 0) {
        inTrade = true;
        entry = { date: bars[i].t, price: bars[i].c };
      }
    } else {
      const rsiExit  = rsi[i] > 70;
      const macdExit = histogram[i] < 0 && histogram[i - 1] >= 0;
      if (rsiExit || macdExit) {
        trades.push(makeTrade(bars[i].t, entry.date, entry.price, bars[i].c));
        inTrade = false;
        entry   = null;
      }
    }
  }

  if (inTrade && entry) {
    trades.push(makeTrade(bars[bars.length - 1].t, entry.date, entry.price, bars[bars.length - 1].c));
  }

  return trades;
}

/**
 * Combined strategy (more lenient than pure golden cross + RSI).
 * Entry: EMA60 > EMA200 (uptrend) AND (RSI < 35 OR (RSI < 50 AND histogram > 0)).
 * Exit:  EMA60 crosses below EMA200 OR RSI > 70 OR histogram turns negative OR stop loss.
 * Scans from bar 200.
 */
function simulateCombined(bars) {
  const closes          = bars.map(b => b.c);
  const ema60           = calcEMA(closes, 60);
  const ema200          = calcEMA(closes, 200);
  const rsi             = calcRSI(closes, 14);
  const { histogram }   = calcMACD(closes);
  const trades          = [];
  let inTrade = false;
  let entry   = null;

  const startBar = Math.min(200, bars.length - 1);

  for (let i = startBar; i < bars.length; i++) {
    if (rsi[i] === null) continue;

    const inUptrend  = ema60[i] > ema200[i];
    // Relaxed entry: oversold OR momentum entry in uptrend
    const entrySignal = rsi[i] < 35 || (rsi[i] < 50 && histogram[i] > 0);

    if (!inTrade) {
      if (inUptrend && entrySignal) {
        inTrade = true;
        entry = { date: bars[i].t, price: bars[i].c, stopPrice: bars[i].c * (1 - STOP_LOSS_PCT) };
      }
    } else {
      const stopHit    = bars[i].l <= entry.stopPrice;
      const emaBearish = ema60[i] < ema200[i];
      const rsiOverbought = rsi[i] > 70;
      const macdExit   = histogram[i] < 0 && histogram[i - 1] >= 0;

      if (stopHit || emaBearish || rsiOverbought || macdExit) {
        const exitPrice = stopHit ? entry.stopPrice : bars[i].c;
        trades.push(makeTrade(bars[i].t, entry.date, entry.price, exitPrice));
        inTrade = false;
        entry   = null;
      }
    }
  }

  if (inTrade && entry) {
    trades.push(makeTrade(bars[bars.length - 1].t, entry.date, entry.price, bars[bars.length - 1].c));
  }

  return trades;
}

function makeTrade(exitTs, entryTs, entryPrice, exitPrice) {
  const pnl         = exitPrice - entryPrice;
  const pnlPct      = (pnl / entryPrice) * 100;
  const entryDate   = new Date(entryTs).toISOString().split('T')[0];
  const exitDate    = new Date(exitTs).toISOString().split('T')[0];
  const holdingDays = Math.max(0, Math.round((exitTs - entryTs) / 86400000));
  return {
    entryDate,
    entryPrice:  parseFloat(entryPrice.toFixed(4)),
    exitDate,
    exitPrice:   parseFloat(exitPrice.toFixed(4)),
    pnl:         parseFloat(pnl.toFixed(2)),
    pnlPct:      parseFloat(pnlPct.toFixed(2)),
    result:      pnl >= 0 ? 'WIN' : 'LOSS',
    holdingDays,
    direction:   'LONG',
  };
}

// ─── SUMMARY STATS ────────────────────────────────────────────────────────────

function calcSummary(trades, symbol, startCapital = 10000) {
  if (!trades.length) {
    return {
      symbol, totalTrades: 0, wins: 0, losses: 0,
      winRate: 0, totalPnl: 0, totalPnlPct: 0,
      maxDrawdown: 0, avgWin: 0, avgLoss: 0, profitFactor: 0,
      finalEquity: startCapital,
      equityCurve: [],
    };
  }

  const wins   = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const totalPnlPct  = trades.reduce((s, t) => s + t.pnlPct, 0);
  const avgWin       = wins.length   ? wins.reduce((s, t) => s + t.pnlPct, 0)   / wins.length   : 0;
  const avgLoss      = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const totalGain    = wins.reduce((s, t) => s + t.pnlPct, 0);
  const totalLoss    = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = totalLoss === 0 ? (totalGain > 0 ? 999 : 0) : totalGain / totalLoss;

  // Equity curve starting at startCapital, compounded per trade
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

  return {
    symbol,
    totalTrades:  trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      parseFloat(((wins.length / trades.length) * 100).toFixed(1)),
    totalPnl:     parseFloat(totalPnlPct.toFixed(2)),
    totalPnlPct:  parseFloat(totalPnlPct.toFixed(2)),
    maxDrawdown:  parseFloat(maxDrawdown.toFixed(2)),
    avgWin:       parseFloat(avgWin.toFixed(2)),
    avgLoss:      parseFloat(avgLoss.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    finalEquity:  parseFloat(equity.toFixed(2)),
    equityCurve,
  };
}

// ─── HANDLER ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'Rate limit reached. Please wait.' });

  const key = process.env.POLYGON_API_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_API_KEY not configured on server.' });

  // Accept params from query string (GET) or body (POST)
  const src = req.method === 'POST' ? (req.body || {}) : req.query;

  // toUpperCase FIRST so lowercase "aapl" is accepted
  const rawSym = String(src.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
  if (!rawSym) return res.status(400).json({ error: 'symbol is required' });

  const startDate = String(src.startDate || '').replace(/[^0-9\-]/g, '').slice(0, 10);
  const endDate   = String(src.endDate   || '').replace(/[^0-9\-]/g, '').slice(0, 10);
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
  }

  const strategy = String(src.strategy || 'combined').toLowerCase();
  if (!['golden_cross', 'rsi_macd', 'combined'].includes(strategy)) {
    return res.status(400).json({ error: 'strategy must be golden_cross, rsi_macd, or combined' });
  }

  console.log(`[backtest] Request: ${rawSym} ${startDate} → ${endDate} strategy=${strategy}`);

  try {
    // Note: Polygon param is "apiKey" with capital K
    const url = `https://api.polygon.io/v2/aggs/ticker/${rawSym}/range/1/day/${startDate}/${endDate}?adjusted=true&sort=asc&limit=5000&apiKey=${key}`;
    console.log(`[backtest] Fetching: ${url.replace(key, 'KEY_REDACTED')}`);

    const data = await httpsGet(url);

    // Log full response metadata (not the full results array to avoid log flooding)
    console.log(`[backtest] Polygon response: status=${data.status} resultsCount=${data.resultsCount ?? 0} queryCount=${data.queryCount ?? 0} adjusted=${data.adjusted}`);
    if (data.status && data.status !== 'OK') {
      console.log(`[backtest] Polygon error body:`, JSON.stringify(data));
    }

    // Guard: no data at all
    if (!data.results || data.results.length === 0) {
      const detail = data.status === 'NOT_AUTHORIZED'
        ? 'API key invalid or expired. Check POLYGON_API_KEY in Vercel environment variables.'
        : data.status === 'NOT_FOUND'
        ? `Symbol "${rawSym}" not found on Polygon. Check the ticker symbol.`
        : `No data returned for ${rawSym} from ${startDate} to ${endDate}. Try AAPL from 2022-01-01 to 2024-01-01.`;
      return res.status(422).json({ error: detail });
    }

    const bars = data.results.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    console.log(`[backtest] Bars loaded: ${bars.length} (${bars[0] ? new Date(bars[0].t).toISOString().slice(0,10) : '?'} → ${bars[bars.length-1] ? new Date(bars[bars.length-1].t).toISOString().slice(0,10) : '?'})`);

    // Minimum bar requirements
    const minBars = { golden_cross: 201, rsi_macd: 36, combined: 201 };
    const need = minBars[strategy];
    if (bars.length < need) {
      return res.status(422).json({
        error: `Not enough data — ${bars.length} bars found but "${strategy}" requires at least ${need}. ` +
               `Select a longer date range (${strategy === 'rsi_macd' ? 'minimum 2 months' : 'minimum 1 year'}).`,
      });
    }

    // Run simulation
    let trades;
    if (strategy === 'golden_cross') {
      trades = simulateGoldenCross(bars);
    } else if (strategy === 'rsi_macd') {
      trades = simulateRsiMacd(bars);
    } else {
      trades = simulateCombined(bars);
    }

    console.log(`[backtest] Trades generated: ${trades.length}`);

    // Tag trades with symbol + strategy
    trades = trades.map(t => ({ symbol: rawSym, strategy, ...t }));

    const summary = calcSummary(trades, rawSym);

    // Build user-facing message for 0 trades
    let message = null;
    if (trades.length === 0) {
      if (strategy === 'golden_cross') {
        message = `No EMA60/200 crossover found for ${rawSym} in this period. Try a longer date range — at least 2 years works best for this strategy.`;
      } else if (strategy === 'rsi_macd') {
        message = `No RSI < 35 + MACD histogram flip found for ${rawSym} in this period. This stock may not have had an oversold bounce here — try a different symbol or wider date range.`;
      } else {
        message = `No combined signals found for ${rawSym} in this period. Try a wider date range or use the Golden Cross or RSI+MACD strategy instead.`;
      }
    }

    return res.status(200).json({
      symbol:    rawSym,
      strategy,
      startDate,
      endDate,
      barsUsed:  bars.length,
      message,
      summary,
      trades,
    });

  } catch (err) {
    console.error('[backtest] Error:', rawSym, err.message);
    return res.status(500).json({ error: `Backtest failed: ${err.message}` });
  }
};
