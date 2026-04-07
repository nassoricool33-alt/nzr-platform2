const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 20;
  if (!rateLimit.has(ip)) { rateLimit.set(ip, { c: 1, s: now }); return true; }
  const e = rateLimit.get(ip);
  if (now - e.s > w) { rateLimit.set(ip, { c: 1, s: now }); return true; }
  if (e.c >= max) return false;
  e.c++;
  return true;
}

function httpsGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Invalid JSON')); } });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

// ── S/R cache ─────────────────────────────────────────────────────────────────
const srCache = {};
const SR_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

/** Clusters an array of raw price values within `thresholdPct` of each other. */
function clusterPivots(prices, thresholdPct = 0.005) {
  if (!prices.length) return [];
  prices.sort((a, b) => a - b);
  const clusters = [];
  for (const p of prices) {
    const hit = clusters.find(c => Math.abs(c.avg - p) / c.avg <= thresholdPct);
    if (hit) { hit.sum += p; hit.n++; hit.avg = hit.sum / hit.n; }
    else      clusters.push({ avg: p, sum: p, n: 1 });
  }
  return clusters.map(c => parseFloat(c.avg.toFixed(4)));
}

/** Counts how many bars have high, low, or close within `thresholdPct` of `level`. */
function touchCount(level, bars, thresholdPct = 0.003) {
  return bars.filter(b =>
    Math.abs(b.h - level) / level <= thresholdPct ||
    Math.abs(b.l - level) / level <= thresholdPct ||
    Math.abs(b.c - level) / level <= thresholdPct
  ).length;
}

/**
 * Fetches 60 daily bars, identifies pivot highs/lows (±2 bars), clusters them
 * within 0.5%, counts touches within 0.3%, and returns the top 3 resistance
 * and support levels with strength scores.
 */
async function getSupportResistance(symbol, key) {
  const cacheKey = `sr:${symbol}`;
  const cached = srCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < SR_CACHE_TTL) {
    console.log(`[indicators] S/R cache hit for ${symbol}`);
    return cached.result;
  }

  const today    = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const data = await httpsGet(
    `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${fromDate}/${today}?adjusted=true&sort=asc&limit=60&apiKey=${key}`
  );

  const bars = data?.results;
  if (!Array.isArray(bars) || bars.length < 10) return { resistance: [], support: [] };

  const pivotHighs = [], pivotLows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    const b = bars[i];
    if (b.h > bars[i-1].h && b.h > bars[i-2].h && b.h > bars[i+1].h && b.h > bars[i+2].h)
      pivotHighs.push(b.h);
    if (b.l < bars[i-1].l && b.l < bars[i-2].l && b.l < bars[i+1].l && b.l < bars[i+2].l)
      pivotLows.push(b.l);
  }

  const resistance = clusterPivots(pivotHighs).map(price => {
    const tc = touchCount(price, bars);
    return { price: parseFloat(price.toFixed(2)), strength: tc, touchCount: tc };
  }).sort((a, b) => b.strength - a.strength).slice(0, 3);

  const support = clusterPivots(pivotLows).map(price => {
    const tc = touchCount(price, bars);
    return { price: parseFloat(price.toFixed(2)), strength: tc, touchCount: tc };
  }).sort((a, b) => a.strength - b.strength).slice(0, 3);

  const result = { resistance, support };
  srCache[cacheKey] = { ts: Date.now(), result };
  console.log(`[indicators] S/R ${symbol}: ${resistance.length} resistance, ${support.length} support levels`);
  return result;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'Too many requests' });

  const key = process.env.POLYGON_API_KEY;
  if (!key) return res.status(500).json({ error: 'Not configured' });

  const symbol = (req.query.symbol || '').replace(/[^A-Z0-9.\-]/g, '').slice(0, 10).toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });

  // ── ?type=sr — support & resistance levels ───────────────────────────────────
  if ((req.query.type || '').toLowerCase() === 'sr') {
    try {
      const sr = await getSupportResistance(symbol, key);
      return res.status(200).json({ symbol, ...sr });
    } catch (err) {
      console.error('[indicators/sr]', symbol, err.message);
      return res.status(500).json({ error: 'S/R calculation failed' });
    }
  }

  const base   = `https://api.polygon.io/v1/indicators`;
  const common2 = `timespan=day&adjusted=true&series_type=close&order=desc&limit=2&apiKey=${key}`;
  const common3 = `timespan=day&adjusted=true&series_type=close&order=desc&limit=3&apiKey=${key}`;

  try {
    const [rsiRes, macdRes, ema20Res, ema60Res, ema200Res] = await Promise.allSettled([
      httpsGet(`${base}/rsi/${symbol}?${common2}&window=14`),
      httpsGet(`${base}/macd/${symbol}?${common2}&short_window=12&long_window=26&signal_window=9`),
      httpsGet(`${base}/ema/${symbol}?${common2}&window=20`),
      httpsGet(`${base}/ema/${symbol}?${common3}&window=60`),
      httpsGet(`${base}/ema/${symbol}?${common3}&window=200`),
    ]);

    const get = (r) => r.status === 'fulfilled' ? r.value : null;
    const rsiData   = get(rsiRes);
    const macdData  = get(macdRes);
    const ema20Data = get(ema20Res);
    const ema60Data = get(ema60Res);
    const ema200Data= get(ema200Res);

    // RSI
    const rsiValues = rsiData?.results?.values;
    if (!rsiValues?.length) return res.status(502).json({ error: 'RSI data unavailable' });
    const rsiVal    = rsiValues[0].value;
    const rsiSignal = rsiVal >= 70 ? 'Overbought' : rsiVal <= 30 ? 'Oversold' : 'Neutral';

    // MACD
    const macdValues = macdData?.results?.values;
    if (!macdValues?.length) return res.status(502).json({ error: 'MACD data unavailable' });
    const macdEntry  = macdValues[0];
    const macdVal    = macdEntry.value;
    const macdSignal = macdEntry.signal;
    const macdHist   = macdEntry.histogram;
    const macdLabel  = macdHist >= 0 ? 'Bullish' : 'Bearish';

    // EMA20
    const ema20Values = ema20Data?.results?.values;
    const ema20 = ema20Values?.[0]?.value ?? null;

    // EMA60 & EMA200 — golden/death cross
    const ema60Values  = ema60Data?.results?.values;
    const ema200Values = ema200Data?.results?.values;
    let goldenCross = null;
    if (ema60Values?.length && ema200Values?.length) {
      const ema60Now   = ema60Values[0].value;
      const ema200Now  = ema200Values[0].value;
      const ema60Prev  = ema60Values[1]?.value  ?? null;
      const ema200Prev = ema200Values[1]?.value ?? null;

      let signal, fresh;
      const freshGolden = ema60Prev !== null && ema200Prev !== null
        && ema60Now > ema200Now && ema60Prev <= ema200Prev;
      const freshDeath  = ema60Prev !== null && ema200Prev !== null
        && ema60Now < ema200Now && ema60Prev >= ema200Prev;

      if (freshGolden)          { signal = 'Fresh Golden Cross'; fresh = true; }
      else if (freshDeath)      { signal = 'Fresh Death Cross';  fresh = true; }
      else if (ema60Now > ema200Now) { signal = 'Golden Cross';  fresh = false; }
      else                      { signal = 'Death Cross';        fresh = false; }

      goldenCross = {
        signal,
        ema60:   ema60Now,
        ema200:  ema200Now,
        fresh,
        bullish: ema60Now > ema200Now,
      };
    }

    return res.status(200).json({
      symbol,
      rsi:          { value: rsiVal, signal: rsiSignal },
      macd:         { macd: macdVal, signal: macdSignal, histogram: macdHist, signal_label: macdLabel },
      ema20,
      ema60:        ema60Values?.[0]?.value  ?? null,
      ema200:       ema200Values?.[0]?.value ?? null,
      golden_cross: goldenCross,
    });
  } catch (err) {
    console.error('[indicators]', symbol, err.message);
    return res.status(500).json({ error: 'Indicators unavailable.' });
  }
};
