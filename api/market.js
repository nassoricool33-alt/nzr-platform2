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

  return res.status(400).json({ error: `Unknown type: "${type}". Valid: vix, feargreed, wstoken` });
};
