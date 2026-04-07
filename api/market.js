/**
 * NZR — Market Data API
 * Merged: vix.js + feargreed.js + wstoken.js
 * Routes: ?type=vix | ?type=feargreed | ?type=wstoken
 * Requires env vars: POLYGON_API_KEY
 */

const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

const rateLimit = new Map();
function checkRate(ip, max = 30) {
  const now = Date.now(), w = 60000;
  const e = rateLimit.get(ip);
  if (!e || now - e.start > w) { rateLimit.set(ip, { count: 1, start: now }); return true; }
  if (e.count >= max) return false;
  e.count++; return true;
}

function httpsGet(url, opts = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, opts, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('Invalid JSON response')); }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);
  });
}

// ── Regime cache ─────────────────────────────────────────────────────────────
let regimeCache = null;
const REGIME_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ── ADX14 (Wilder's method) ───────────────────────────────────────────────────
/**
 * Computes ADX14 from an ascending array of OHLC bars ({ h, l, c }).
 * Requires at least 30 bars (14 to seed DI smoothing + 14 to seed ADX + buffer).
 * Returns { adx, plusDI, minusDI } or null on insufficient data.
 */
function calcADX14(bars, period = 14) {
  if (!bars || bars.length < period * 2 + 2) return null;

  const pdms = [], mdms = [], trs = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], c = bars[i];
    const up   = c.h - p.h;
    const down = p.l - c.l;
    pdms.push(up > down && up > 0 ? up : 0);
    mdms.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }

  if (trs.length < period + period) return null;

  // Seed: simple sum of first `period` values
  let sTR  = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = pdms.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = mdms.slice(0, period).reduce((a, b) => a + b, 0);

  const dx = (tr, pdm, mdm) => {
    if (tr === 0) return 0;
    const pdi = 100 * pdm / tr, mdi = 100 * mdm / tr;
    const s = pdi + mdi;
    return s === 0 ? 0 : 100 * Math.abs(pdi - mdi) / s;
  };

  const dxVals = [dx(sTR, sPDM, sMDM)];
  for (let i = period; i < trs.length; i++) {
    sTR  = sTR  - sTR  / period + trs[i];
    sPDM = sPDM - sPDM / period + pdms[i];
    sMDM = sMDM - sMDM / period + mdms[i];
    dxVals.push(dx(sTR, sPDM, sMDM));
  }

  if (dxVals.length < period) return null;

  let adx = dxVals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxVals.length; i++) {
    adx = (adx * (period - 1) + dxVals[i]) / period;
  }

  const plusDI  = sTR === 0 ? 0 : parseFloat((100 * sPDM / sTR).toFixed(2));
  const minusDI = sTR === 0 ? 0 : parseFloat((100 * sMDM / sTR).toFixed(2));
  return { adx: parseFloat(adx.toFixed(2)), plusDI, minusDI };
}

// ── type=regime ───────────────────────────────────────────────────────────────
async function handleRegime(key) {
  if (regimeCache && (Date.now() - regimeCache.ts) < REGIME_CACHE_TTL) {
    console.log('[market/regime] cache hit');
    return regimeCache.result;
  }

  const today    = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  // Fetch SPY bars and VIX in parallel
  const [spyData, vixData] = await Promise.allSettled([
    httpsGet(
      `https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/${fromDate}/${today}?adjusted=true&sort=asc&limit=30&apiKey=${key}`
    ),
    httpsGet(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    ),
  ]);

  const bars = spyData.status === 'fulfilled' ? spyData.value?.results : null;
  const vix  = vixData.status === 'fulfilled'
    ? (vixData.value?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null)
    : null;

  if (!Array.isArray(bars) || bars.length < 30) {
    console.warn('[market/regime] insufficient SPY bars:', bars?.length ?? 0);
    return { adx: null, plusDI: null, minusDI: null, vix, regime: 'neutral', error: 'Insufficient data' };
  }

  // Polygon bars use h/l/c/o/v/t
  const ohlc = bars.map(b => ({ h: b.h, l: b.l, c: b.c }));
  const adxResult = calcADX14(ohlc);

  if (!adxResult) {
    return { adx: null, plusDI: null, minusDI: null, vix, regime: 'neutral', error: 'ADX calculation failed' };
  }

  const { adx, plusDI, minusDI } = adxResult;

  let regime;
  if (vix != null && vix > 30 && adx < 20) regime = 'crisis';
  else if (adx > 25)                        regime = 'trending';
  else if (adx < 20)                        regime = 'choppy';
  else                                      regime = 'neutral';

  const result = { adx, plusDI, minusDI, vix, regime };
  regimeCache = { ts: Date.now(), result };
  console.log(`[market/regime] adx=${adx} vix=${vix} → ${regime}`);
  return result;
}

// ── type=vix ─────────────────────────────────────────────────────────────────
async function handleVix() {
  try {
    const data = await httpsGet(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return { symbol: 'VIX', price: null, error: 'VIX data unavailable' };

    const price     = meta.regularMarketPrice ?? null;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const change    = price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null;
    return { symbol: 'VIX', price, change, changePercent: change };
  } catch (err) {
    console.error('[market/vix]', err.message);
    return { symbol: 'VIX', price: null, error: 'VIX data unavailable' };
  }
}

// ── type=feargreed ────────────────────────────────────────────────────────────
function scoreToRating(score) {
  if (score <= 25) return 'Extreme Fear';
  if (score <= 45) return 'Fear';
  if (score <= 55) return 'Neutral';
  if (score <= 75) return 'Greed';
  return 'Extreme Greed';
}

async function handleFearGreed() {
  // Try CNN endpoint with multiple extraction paths
  try {
    const data = await httpsGet(
      'https://production.dataviz.cnn.io/index/fearandgreed/graphdata',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );

    console.log('[feargreed] raw response:', JSON.stringify(data).slice(0, 500));

    // Try all known extraction paths in order
    const fg = data?.fear_and_greed;
    let rawScore =
      fg?.score?.value                  ??  // nested object
      (typeof fg?.score === 'number' ? fg.score : null) ??  // direct number
      fg?.current_value                 ??  // alternate field
      data?.score?.value                ??  // top-level score object
      (Array.isArray(data) ? data[0]?.value : null) ?? // array response
      null;

    if (rawScore != null) {
      const score = Math.round(Number(rawScore));
      const rawRating = fg?.score?.description ?? fg?.rating ?? null;
      const rating = rawRating
        ? rawRating.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
        : scoreToRating(score);
      return { value: score, rating, timestamp: fg?.timestamp || null };
    }

    console.warn('[feargreed] no score found in CNN response, falling back to VIX estimate');
  } catch (err) {
    console.error('[market/feargreed] CNN fetch error:', err.message);
  }

  // VIX-based fallback
  try {
    const vixData = await httpsGet(
      'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    const vix = vixData?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    if (vix != null) {
      let value, rating;
      if (vix > 30)      { value = 20; rating = 'Extreme Fear'; }
      else if (vix > 20) { value = 35; rating = 'Fear'; }
      else if (vix > 15) { value = 50; rating = 'Neutral'; }
      else if (vix > 12) { value = 65; rating = 'Greed'; }
      else               { value = 80; rating = 'Extreme Greed'; }
      return { value, rating, note: 'Estimated from VIX — CNN data unavailable', vix };
    }
  } catch (err) {
    console.error('[market/feargreed] VIX fallback error:', err.message);
  }

  return { value: null, rating: 'Unavailable', error: 'Fear & Greed data unavailable' };
}

// ── type=wstoken ──────────────────────────────────────────────────────────────
function handleWsToken(key) {
  // Returns the Polygon API key for client-side WebSocket auth (read-only market data)
  return { token: key };
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  // wstoken has stricter rate limit (10/min) to protect key exposure
  const type = String(req.query.type || '').toLowerCase();
  const rateMax = type === 'wstoken' ? 10 : 30;
  if (!checkRate(ip, rateMax)) return res.status(429).json({ error: 'Rate limit reached' });

  const key = process.env.POLYGON_API_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_API_KEY not configured' });

  if (type === 'vix')       return res.status(200).json(await handleVix());
  if (type === 'feargreed') return res.status(200).json(await handleFearGreed());
  if (type === 'wstoken')   return res.status(200).json(handleWsToken(key));
  if (type === 'regime')    return res.status(200).json(await handleRegime(key));

  return res.status(400).json({ error: `Unknown type: "${type}". Valid: vix, feargreed, wstoken, regime` });
};
