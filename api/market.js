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
async function handleVix(key) {
  try {
    const data = await httpsGet(
      `https://api.polygon.io/v2/aggs/ticker/I:VIX/prev?adjusted=true&apiKey=${key}`
    );
    const bar = data?.results?.[0];
    if (!bar) return { symbol: 'VIX', price: null, error: 'VIX data unavailable' };

    const price     = bar.c;
    const prevClose = bar.o;
    const change    = prevClose ? ((price - prevClose) / prevClose) * 100 : null;
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
  try {
    const data = await httpsGet(
      'https://production.dataviz.cnn.io/index/fearandgreed/graphdata',
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );

    const fg = data?.fear_and_greed;
    if (!fg || fg.score == null) {
      return { value: null, rating: 'Unavailable', error: 'Fear & Greed data unavailable' };
    }

    const score = Math.round(Number(fg.score));
    const rating = fg.rating
      ? fg.rating.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      : scoreToRating(score);

    return { value: score, rating, timestamp: fg.timestamp || null };
  } catch (err) {
    console.error('[market/feargreed]', err.message);
    return { value: null, rating: 'Unavailable', error: 'Fear & Greed data unavailable' };
  }
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

  if (type === 'vix')       return res.status(200).json(await handleVix(key));
  if (type === 'feargreed') return res.status(200).json(await handleFearGreed());
  if (type === 'wstoken')   return res.status(200).json(handleWsToken(key));

  return res.status(400).json({ error: `Unknown type: "${type}". Valid: vix, feargreed, wstoken` });
};
