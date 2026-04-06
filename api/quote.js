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
      req.destroy(new Error('Request timed out'));
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

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Fetch all three endpoints in parallel with 10s timeout each
  const [tradeRes, todayRes, prevRes] = await Promise.allSettled([
    httpsGet(`https://api.polygon.io/v2/last/trade/${symbol}?apiKey=${key}`, 10000),
    httpsGet(`https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${today}/${today}?adjusted=true&apiKey=${key}`, 10000),
    httpsGet(`https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${key}`, 10000),
  ]);

  // Extract latest trade price (real-time)
  let livePrice = null;
  let tradeTimestamp = null;
  if (tradeRes.status === 'fulfilled') {
    const t = tradeRes.value?.results;
    if (t?.p != null) {
      livePrice = t.p;
      tradeTimestamp = t.t ?? null; // nanosecond timestamp from Polygon
    }
  }

  // Extract today's OHLV bar
  let open = null, high = null, low = null, volume = null;
  if (todayRes.status === 'fulfilled') {
    const bar = todayRes.value?.results?.[0];
    if (bar) {
      open   = bar.o ?? null;
      high   = bar.h ?? null;
      low    = bar.l ?? null;
      volume = bar.v ?? null;
      // Fall back: if no live trade, use today's agg close
      if (livePrice == null && bar.c != null) livePrice = bar.c;
    }
  }

  // Extract previous close
  let prevClose = null;
  if (prevRes.status === 'fulfilled') {
    prevClose = prevRes.value?.results?.[0]?.c ?? null;
  }

  console.log('[quote] livePrice:', livePrice, 'prevClose:', prevClose, 'open:', open);

  if (livePrice == null) {
    console.warn('[quote] no price data for', symbol);
    return res.status(200).json({ symbol, price: null, error: 'Quote unavailable' });
  }

  const change        = prevClose != null ? livePrice - prevClose : null;
  const changePercent = prevClose != null ? (change / prevClose) * 100 : null;

  return res.status(200).json({
    symbol,
    price:         livePrice,
    open,
    high,
    low,
    prevClose,
    change,
    changePercent,
    volume,
    timestamp:     tradeTimestamp ?? Date.now(),
  });
};
