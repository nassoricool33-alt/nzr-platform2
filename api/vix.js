const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

function httpsGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error('Invalid JSON from VIX endpoint')); }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('VIX request timed out'));
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

  const key = process.env.POLYGON_API_KEY;
  if (!key) return res.status(500).json({ symbol: 'VIX', price: null, error: 'POLYGON_API_KEY not configured' });

  try {
    const data = await httpsGet(
      `https://api.polygon.io/v2/aggs/ticker/I:VIX/prev?adjusted=true&apiKey=${key}`
    );

    const bar = data?.results?.[0];
    if (!bar) {
      return res.status(200).json({ symbol: 'VIX', price: null, error: 'VIX data unavailable' });
    }

    const price     = bar.c;
    const prevClose = bar.o;
    const change    = prevClose ? ((price - prevClose) / prevClose) * 100 : null;

    return res.status(200).json({
      symbol: 'VIX',
      price,
      change,
      changePercent: change,
    });
  } catch (err) {
    console.error('[vix]', err.message);
    return res.status(200).json({ symbol: 'VIX', price: null, error: 'VIX data unavailable' });
  }
};
