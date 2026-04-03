const https = require('https');

const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 20;
  if (!rateLimit.has(ip)) { rateLimit.set(ip, {c: 1, s: now}); return true; }
  const e = rateLimit.get(ip);
  if (now - e.s > w) { rateLimit.set(ip, {c: 1, s: now}); return true; }
  if (e.c >= max) return false;
  e.c++;
  return true;
}

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

module.exports = function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({error: 'Method not allowed'});

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({error: 'Too many requests'});

  const symbol = (req.query.symbol || '').replace(/[^A-Z0-9.\-]/g, '').slice(0, 10).toUpperCase();
  if (!symbol) return res.status(400).json({error: 'Symbol required'});

  const key = process.env.FINNHUB_API_KEY;
  if (!key) return res.status(500).json({error: 'Not configured'});

  https.get('https://finnhub.io/api/v1/quote?symbol=' + symbol + '&token=' + key, function(r) {
    let d = '';
    r.on('data', function(c) { d += c; });
    r.on('end', function() {
      try {
        const q = JSON.parse(d);
        if (!q || !q.c) return res.status(404).json({error: 'No data'});
        return res.status(200).json({price: q.c, open: q.o, high: q.h, low: q.l, prevClose: q.pc, change: ((q.c - q.pc) / q.pc) * 100});
      } catch (e) { return res.status(500).json({error: 'Error'}); }
    });
  }).on('error', function() { return res.status(500).json({error: 'Error'}); });
};
