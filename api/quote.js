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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
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

  try {
    // Fetch last trade (real-time price) and previous day OHLCV in parallel
    const [tradeData, prevData] = await Promise.allSettled([
      httpsGet(`https://api.polygon.io/v2/last/trade/${symbol}?apiKey=${key}`),
      httpsGet(`https://api.polygon.io/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${key}`),
    ]);

    const trade = tradeData.status === 'fulfilled' ? tradeData.value : null;
    const prev  = prevData.status  === 'fulfilled' ? prevData.value  : null;

    // Real-time price from last trade
    const price = trade?.results?.p ?? trade?.last?.price ?? null;

    // OHLCV from previous day aggregate
    const bar = prev?.results?.[0] ?? null;
    const open      = bar?.o ?? null;
    const high      = bar?.h ?? null;
    const low       = bar?.l ?? null;
    const prevClose = bar?.c ?? null;
    const volume    = bar?.v ?? null;

    if (price == null && prevClose == null) {
      return res.status(404).json({ error: 'No data for symbol' });
    }

    const livePrice = price ?? prevClose;
    const change = prevClose ? ((livePrice - prevClose) / prevClose) * 100 : null;

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
    });
  } catch (err) {
    console.error('[quote]', symbol, err.message);
    return res.status(500).json({ error: 'Quote data unavailable.' });
  }
};
