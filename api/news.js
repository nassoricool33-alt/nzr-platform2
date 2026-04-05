const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

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

  const polygonKey  = process.env.POLYGON_API_KEY;
  const finnhubKey  = process.env.FINNHUB_API_KEY;
  const type = req.query.type || 'market';

  try {
    if (type === 'economic') {
      // Economic calendar still uses Finnhub — Polygon does not cover macro events
      if (!finnhubKey) return res.status(500).json({ error: 'Not configured' });
      const from = req.query.from || new Date().toISOString().split('T')[0];
      const to   = req.query.to   || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const data = await httpsGet(
        `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${finnhubKey}`
      );
      return res.status(200).json(data);

    } else {
      // General market news — Polygon
      if (!polygonKey) return res.status(500).json({ error: 'Not configured' });
      const data = await httpsGet(
        `https://api.polygon.io/v2/reference/news?limit=20&order=desc&sort=published_utc&apiKey=${polygonKey}`
      );
      const news = (data.results || []).slice(0, 20).map(n => ({
        headline: n.title,
        summary:  n.description || '',
        url:      n.article_url,
        source:   n.publisher?.name || 'News',
        datetime: n.published_utc ? Math.floor(new Date(n.published_utc).getTime() / 1000) : 0,
        image:    n.image_url || null,
        tickers:  n.tickers || [],
      }));
      return res.status(200).json({ news });
    }
  } catch (err) {
    console.error('[news]', type, err.message);
    return res.status(500).json({ error: 'Failed to fetch data' });
  }
};
