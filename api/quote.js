const https = require('https');

const ALLOWED_ORIGINS = [
  'https://nzr-platform2.vercel.app',
  'https://nzr-platform.vercel.app',
  'http://localhost:3000'
];

const rateLimit = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const max = 60;
  if (!rateLimit.has(ip)) {
    rateLimit.set(ip, { count: 1, start: now });
    return true;
  }
  const entry = rateLimit.get(ip);
  if (now - entry.start > windowMs) {
    rateLimit.set(ip, { count: 1, start: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

module.exports = function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait.' });
  }

  const symbol = (req.query.symbol || '').replace(/[^A-Z0-9.\-]/g, '').slice(0, 10).toUpperCase();

  if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

  const key = process.env.FINNHUB_API_KEY;
  if (!key) return res.status(500).json({ error: 'Market data service not configured' });

  const url = 'https://finnhub.io/api/v1/quote?symbol=' + symbol + '&token=' + key;

  https.get(url, function(apiRes) {
    let data = '';
    apiRes.on('data', function(chunk) { data += chunk; });
    apiRes.on('end', function() {
      try {
        const d = JSON.parse(data);
        if (!d || !d.c || d.c === 0) {
          return res.status(404).json({ error: 'No data for: ' + symbol });
        }
        return res.status(200).json({
          price: d.c,
          open: d.o,
          high: d.h,
          low: d.l,
          prevClose: d.pc,
          change: ((d.c - d.pc) / d.pc) * 100
        });
      } catch (e) {
        return res.status(500).json({ error: 'Failed to parse market data' });
      }
    });
  }).on('error', function(e) {
    return res.status(500).json({ error: 'Failed to fetch market data' });
  });
};
