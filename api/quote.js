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
      r.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Quote request timed out'));
    });
    req.on('error', reject);
  });
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

  console.log('[quote] fetching:', symbol);

  try {
    // Primary: previous day aggregate (reliable OHLCV)
    let bar = null;
    try {
      const prevData = await httpsGet(
        `https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${key}`
      );
      bar = prevData?.results?.[0] ?? null;
    } catch (err) {
      console.error('[quote] prev agg failed for', symbol, err.message);
    }

    // Fallback: last trade for real-time price
    let lastPrice = null;
    try {
      const tradeData = await httpsGet(
        `https://api.polygon.io/v2/last/trade/${symbol}?apiKey=${key}`
      );
      lastPrice = tradeData?.results?.p ?? tradeData?.last?.price ?? null;
    } catch (err) {
      console.error('[quote] last trade failed for', symbol, err.message);
    }

    if (!bar && lastPrice == null) {
      return res.status(200).json({ symbol, price: null, error: 'Quote unavailable' });
    }

    const prevClose = bar?.c ?? null;
    const open      = bar?.o ?? null;
    const high      = bar?.h ?? null;
    const low       = bar?.l ?? null;
    const volume    = bar?.v ?? null;
    const livePrice = lastPrice ?? prevClose;
    const change    = prevClose ? ((livePrice - prevClose) / prevClose) * 100 : null;

    console.log('[quote] result:', symbol, 'price:', livePrice);
    return res.status(200).json({
      symbol,
      price: livePrice,
      open,
      high,
      low,
      prevClose,
      volume,
      change,
      changePercent: change,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error('[quote]', symbol, err.message);
    return res.status(200).json({ symbol, price: null, error: 'Quote unavailable' });
  }
};
