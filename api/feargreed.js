const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
      },
    };
    https.get(url, opts, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    }).on('error', reject);
  });
}

function scoreToRating(score) {
  if (score <= 25) return 'Extreme Fear';
  if (score <= 45) return 'Fear';
  if (score <= 55) return 'Neutral';
  if (score <= 75) return 'Greed';
  return 'Extreme Greed';
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

  try {
    const data = await httpsGet(
      'https://production.dataviz.cnn.io/index/fearandgreed/graphdata'
    );

    // CNN response shape: { fear_and_greed: { score, rating, timestamp }, ... }
    const fg = data?.fear_and_greed;
    if (!fg || fg.score == null) {
      return res.status(502).json({ error: 'No Fear & Greed data' });
    }

    const score = Math.round(Number(fg.score));
    const rating = fg.rating
      ? fg.rating
          .split(' ')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ')
      : scoreToRating(score);

    return res.status(200).json({
      value: score,
      rating,
      timestamp: fg.timestamp || null,
    });

  } catch (err) {
    console.error('[feargreed]', err.message);
    return res.status(500).json({ error: 'Fear & Greed data unavailable.' });
  }
};
