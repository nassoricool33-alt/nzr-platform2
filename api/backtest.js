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
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
  });
}

// ─── TECHNICAL INDICATOR MATH ─────────────────────────────────────────────────

function calcEMA(closes, window) {
  const ema = new Array(closes.length).fill(null);
  if (closes.length < window) return ema;
  const k = 2 / (window + 1);
  let sum = 0;
  for (let i = 0; i < window; i++) sum += closes[i];
  ema[window - 1] = sum / window;
  for (let i = window; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine   = closes.map((_, i) =>
    ema12[i] !== null && ema26[i] !== null ? ema12[i] - ema26[i] : null
  );

  const signalLine = new Array(closes.length).fill(null);
  const histogram  = new Array(closes.length).fill(null);

  // Find first bar where MACD is defined
  const firstMacd = macdLine.findIndex(v => v !== null);
  if (firstMacd === -1) return { macdLine, signalLine, histogram };

  // Signal = EMA(9) of MACD line
  const sigK = 2 / (9 + 1);
  let seedCount = 0, seedSum = 0;
  let prevSignal = null;

  for (let i = firstMacd; i < closes.length; i++) {
    if (macdLine[i] === null) continue;
    seedCount++;
    seedSum += macdLine[i];
    if (seedCount === 9) {
      prevSignal = seedSum / 9;
      signalLine[i] = prevSignal;
      histogram[i]  = macdLine[i] - prevSignal;
    } else if (seedCount > 9) {
      prevSignal = macdLine[i] * sigK + prevSignal * (1 - sigK);
      signalLine[i] = prevSignal;
      histogram[i]  = macdLine[i] - prevSignal;
    }
  }
  return { macdLine, signalLine, histogram };
}

// ─── TRADE SIMULATION ─────────────────────────────────────────────────────────

const STOP_LOSS_PCT = 0.05; // 5% hard stop for golden_cross

function simulateGoldenCross(bars) {
  const closes = bars.map(b => b.c);
  const ema60  = calcEMA(closes, 60);
  const ema200 = calcEMA(closes, 200);
  const trades = [];

  let inTrade = false;
  let entry = null;

  for (let i = 1; i < bars.length; i++) {
    if (ema60[i] === null || ema200[i] === null) continue;

    if (!inTrade) {
      // BUY: EMA60 crosses above EMA200
      if (ema60[i - 1] !== null && ema60[i - 1] <= ema200[i - 1] && ema60[i] > ema200[i]) {
        inTrade = true;
        entry = { date: bars[i].t, price: bars[i].c, stopPrice: bars[i].c * (1 - STOP_LOSS_PCT) };
      }
    } else {
      const stopHit  = bars[i].l <= entry.stopPrice;
      const sellCross = ema60[i] < ema200[i] && ema60[i - 1] >= ema200[i - 1];

      if (stopHit || sellCross) {
        const exitPrice = stopHit ? entry.stopPrice : bars[i].c;
        trades.push(makeTrade(bars[i].t, entry.date, entry.price, exitPrice));
        inTrade = false; entry = null;
      }
    }
  }
  // Close any open trade at last bar
  if (inTrade && entry) {
    trades.push(makeTrade(bars[bars.length - 1].t, entry.date, entry.price, bars[bars.length - 1].c));
  }
  return trades;
}

function simulateRsiMacd(bars) {
  const closes = bars.map(b => b.c);
  const rsi    = calcRSI(closes, 14);
  const { histogram } = calcMACD(closes);
  const trades = [];

  let inTrade = false;
  let entry = null;

  for (let i = 1; i < bars.length; i++) {
    if (rsi[i] === null || histogram[i] === null) continue;
    if (rsi[i - 1] === null || histogram[i - 1] === null) continue;

    if (!inTrade) {
      // BUY: RSI < 35 AND MACD histogram just turned positive
      if (rsi[i] < 35 && histogram[i] > 0 && histogram[i - 1] <= 0) {
        inTrade = true;
        entry = { date: bars[i].t, price: bars[i].c };
      }
    } else {
      // SELL: RSI > 70 OR histogram turns negative
      const rsiExit  = rsi[i] > 70;
      const macdExit = histogram[i] < 0 && histogram[i - 1] >= 0;
      if (rsiExit || macdExit) {
        trades.push(makeTrade(bars[i].t, entry.date, entry.price, bars[i].c));
        inTrade = false; entry = null;
      }
    }
  }
  if (inTrade && entry) {
    trades.push(makeTrade(bars[bars.length - 1].t, entry.date, entry.price, bars[bars.length - 1].c));
  }
  return trades;
}

function simulateCombined(bars) {
  const closes = bars.map(b => b.c);
  const ema60  = calcEMA(closes, 60);
  const ema200 = calcEMA(closes, 200);
  const rsi    = calcRSI(closes, 14);
  const { histogram } = calcMACD(closes);
  const trades = [];

  let inTrade = false;
  let entry = null;

  for (let i = 1; i < bars.length; i++) {
    if (ema60[i] === null || ema200[i] === null) continue;
    if (rsi[i] === null || histogram[i] === null) continue;
    if (histogram[i - 1] === null) continue;

    if (!inTrade) {
      // BUY: EMA60 > EMA200 AND RSI < 35 AND MACD histogram crosses positive
      if (ema60[i] > ema200[i] && rsi[i] < 35 && histogram[i] > 0 && histogram[i - 1] <= 0) {
        inTrade = true;
        entry = { date: bars[i].t, price: bars[i].c, stopPrice: bars[i].c * (1 - STOP_LOSS_PCT) };
      }
    } else {
      const stopHit    = bars[i].l <= entry.stopPrice;
      const emaBearish = ema60[i] < ema200[i];
      const rsiExit    = rsi[i] > 70;
      const macdExit   = histogram[i] < 0 && histogram[i - 1] >= 0;
      if (stopHit || emaBearish || rsiExit || macdExit) {
        const exitPrice = stopHit ? entry.stopPrice : bars[i].c;
        trades.push(makeTrade(bars[i].t, entry.date, entry.price, exitPrice));
        inTrade = false; entry = null;
      }
    }
  }
  if (inTrade && entry) {
    trades.push(makeTrade(bars[bars.length - 1].t, entry.date, entry.price, bars[bars.length - 1].c));
  }
  return trades;
}

function makeTrade(exitTs, entryTs, entryPrice, exitPrice) {
  const pnl        = exitPrice - entryPrice;
  const pnlPct     = (pnl / entryPrice) * 100;
  const entryDate  = new Date(entryTs).toISOString().split('T')[0];
  const exitDate   = new Date(exitTs).toISOString().split('T')[0];
  const holdingDays= Math.round((exitTs - entryTs) / 86400000);
  return {
    entryDate,
    entryPrice: parseFloat(entryPrice.toFixed(4)),
    exitDate,
    exitPrice:  parseFloat(exitPrice.toFixed(4)),
    pnl:        parseFloat(pnl.toFixed(4)),
    pnlPct:     parseFloat(pnlPct.toFixed(2)),
    result:     pnl >= 0 ? 'WIN' : 'LOSS',
    holdingDays: Math.max(0, holdingDays),
    direction:  'LONG',
  };
}

// ─── SUMMARY STATS ────────────────────────────────────────────────────────────

function calcSummary(trades, symbol, startCapital = 10000) {
  if (!trades.length) {
    return {
      symbol, totalTrades: 0, wins: 0, losses: 0,
      winRate: 0, totalPnl: 0, totalPnlPct: 0,
      maxDrawdown: 0, avgWin: 0, avgLoss: 0, profitFactor: 0,
      equityCurve: [{ date: null, equity: startCapital }],
    };
  }

  const wins   = trades.filter(t => t.result === 'WIN');
  const losses = trades.filter(t => t.result === 'LOSS');
  const totalPnlPct = trades.reduce((s, t) => s + t.pnlPct, 0);
  const avgWin  = wins.length   ? wins.reduce((s, t) => s + t.pnlPct, 0)   / wins.length   : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const totalGain = wins.reduce((s, t) => s + t.pnlPct, 0);
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = totalLoss === 0 ? (totalGain > 0 ? 999 : 0) : totalGain / totalLoss;

  // Equity curve (compound %)
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
  if (!key) return res.status(500).json({ error: 'Data service unavailable.' });

  // Accept params from query string (GET) or body (POST)
  const src = req.method === 'POST' ? (req.body || {}) : req.query;

  // toUpperCase FIRST so lowercase input like "aapl" is accepted
  const rawSym = String(src.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
  if (!rawSym) return res.status(400).json({ error: 'symbol is required' });

  const startDate = String(src.startDate || '').replace(/[^0-9\-]/g, '').slice(0, 10);
  const endDate   = String(src.endDate   || '').replace(/[^0-9\-]/g, '').slice(0, 10);
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });

  const strategy = String(src.strategy || 'combined').toLowerCase();
  if (!['golden_cross', 'rsi_macd', 'combined'].includes(strategy)) {
    return res.status(400).json({ error: 'strategy must be golden_cross, rsi_macd, or combined' });
  }

  console.log(`[backtest] Received request: ${rawSym} ${startDate} → ${endDate} strategy=${strategy}`);

  try {
    // limit=5000 to handle multi-year date ranges (daily bars ~252/year)
    const url = `https://api.polygon.io/v2/aggs/ticker/${rawSym}/range/1/day/${startDate}/${endDate}?adjusted=true&sort=asc&limit=5000&apiKey=${key}`;
    console.log(`[backtest] Polygon URL: ${url.replace(key, 'REDACTED')}`);

    const data = await httpsGet(url);
    console.log(`[backtest] Polygon response status: ${data.status} resultsCount=${data.resultsCount ?? 0}`);
    console.log(`[backtest] Raw bars received: ${data.results?.length ?? 0}`);

    if (!data.results || data.results.length === 0) {
      return res.status(422).json({
        error: `No historical data found for ${rawSym} in this date range. Check the symbol and ensure the date range includes trading days.`,
      });
    }

    if (data.results.length < 50) {
      return res.status(422).json({
        error: `Insufficient data — need at least 50 bars, got ${data.results.length}. Widen the date range to at least 3 months.`,
      });
    }

    const bars = data.results.map(b => ({
      t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
    }));

    // EMA200 requires at least 210 bars to produce any valid signals (200 warmup + buffer)
    const needsEMA200 = strategy === 'golden_cross' || strategy === 'combined';
    if (needsEMA200 && bars.length < 210) {
      return res.status(422).json({
        error: `Not enough historical data — ${bars.length} bars found but EMA200 needs at least 210. Select a longer date range (minimum ~1 year).`,
      });
    }

    let trades;
    if (strategy === 'golden_cross') {
      trades = simulateGoldenCross(bars);
    } else if (strategy === 'rsi_macd') {
      trades = simulateRsiMacd(bars);
    } else {
      trades = simulateCombined(bars);
    }

    console.log(`[backtest] Trades generated: ${trades.length}`);

    // Tag each trade with symbol + strategy
    trades = trades.map(t => ({ symbol: rawSym, strategy, ...t }));

    const summary = calcSummary(trades, rawSym);

    return res.status(200).json({
      symbol:    rawSym,
      strategy,
      startDate,
      endDate,
      barsUsed:  bars.length,
      summary,
      trades,
    });

  } catch (err) {
    console.error('[backtest]', rawSym, err.message);
    return res.status(500).json({ error: 'Backtest failed — check symbol and date range.' });
  }
};
