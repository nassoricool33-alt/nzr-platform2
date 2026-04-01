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

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

module.exports = function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  setSecurityHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
  }

  const { searchParams } = new URL(req.url, 'http://localhost');
  const rawSymbol = searchParams.get('symbol') || '';
  const symbol = rawSymbol.toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);

  if (!symbol) {
    return res.status(400).json({ error: 'Symbol is required' });
  }

  const key = process.env.FINNHUB_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'Market data service not configured' });
  }

  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`;

  https.get(url, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const d = JSON.parse(data);
        if (!d || d.c === undefined || d.c === 0) {
          return res.status(404).json({ error: 'No data found for symbol: ' + symbol });
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
        console.error(JSON.stringify({ timestamp: new Date().toISOString(), error: 'Parse error', endpoint: '/api/quote' }));
        return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
      }
    });
  }).on('error', (e) => {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), error: e.message, endpoint: '/api/quote' }));
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  });
};