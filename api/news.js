const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.FINNHUB_API_KEY;
  if (!key) return res.status(500).json({ error: 'Not configured' });

  const type = req.query.type || 'market';

  try {
    if (type === 'earnings') {
      const from = (req.query.from || new Date().toISOString().split('T')[0]);
      const to   = (req.query.to   || new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]);
      const data = await httpsGet(
        'https://finnhub.io/api/v1/calendar/earnings?from=' + from + '&to=' + to + '&token=' + key
      );
      return res.status(200).json(data);
    } else if (type === 'economic') {
      const from = (req.query.from || new Date().toISOString().split('T')[0]);
      const to   = (req.query.to   || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0]);
      const data = await httpsGet(
        'https://finnhub.io/api/v1/calendar/economic?from=' + from + '&to=' + to + '&token=' + key
      );
      return res.status(200).json(data);
    } else {
      // General market news
      const data = await httpsGet(
        'https://finnhub.io/api/v1/news?category=general&minId=0&token=' + key
      );
      const news = Array.isArray(data) ? data.slice(0, 8) : [];
      return res.status(200).json({ news });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to fetch data' });
  }
};
