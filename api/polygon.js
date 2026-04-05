const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

// Rate limiting: 5 requests per minute per IP (Polygon free tier)
const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now();
  const window = 60000;
  const max = 5;
  const entry = rateLimit.get(ip);
  if (!entry || now - entry.start > window) {
    rateLimit.set(ip, { count: 1, start: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
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
  if (!checkRate(ip)) {
    return res.status(429).json({ error: 'Rate limit reached. Please wait a moment.' });
  }

  const key = process.env.POLYGON_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'Data service unavailable.' });
  }

  const type = req.query.type || '';

  try {
    if (type === 'movers') {
      const [gainersData, losersData] = await Promise.all([
        httpsGet(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${key}`),
        httpsGet(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/losers?apiKey=${key}`),
      ]);

      const mapTicker = t => ({
        symbol: t.ticker,
        price: t.day?.c ?? t.min?.c ?? null,
        change: t.todaysChangePerc ?? null,
      });

      const gainers = (gainersData.tickers || []).slice(0, 5).map(mapTicker);
      const losers  = (losersData.tickers  || []).slice(0, 5).map(mapTicker);

      return res.status(200).json({ gainers, losers, delayed: true });

    } else if (type === 'earnings') {
      const data = await httpsGet(
        `https://api.polygon.io/vX/reference/financials?limit=10&apiKey=${key}`
      );

      const items = (data.results || []).map(r => ({
        ticker:  r.ticker,
        date:    r.filing_date || r.start_date || null,
        period:  r.fiscal_period || null,
        year:    r.fiscal_year  || null,
        revenue: r.financials?.income_statement?.revenues?.value ?? null,
      }));

      return res.status(200).json({ earnings: items, delayed: true });

    } else if (type === 'options') {
      const rawSym = (req.query.symbol || '')
        .toUpperCase()
        .replace(/[^A-Z0-9.\-]/g, '')
        .slice(0, 10);
      if (!rawSym) return res.status(400).json({ error: 'symbol is required' });

      const data = await httpsGet(
        `https://api.polygon.io/v3/snapshot/options/${rawSym}?limit=10&apiKey=${key}`
      );

      const items = (data.results || []).map(r => {
        const d   = r.details || {};
        const day = r.day    || {};
        const rawPrem = (day.vwap != null && d.shares_per_contract != null)
          ? day.vwap * d.shares_per_contract
          : null;
        return {
          symbol:           rawSym,
          type:             d.contract_type ? d.contract_type.toUpperCase() : '--',
          strike:           d.strike_price ?? null,
          expiry:           d.expiration_date || '--',
          volume:           day.volume ?? null,
          open_interest:    r.open_interest ?? null,
          implied_volatility: r.implied_volatility != null
            ? (r.implied_volatility * 100).toFixed(1)
            : null,
          premium: rawPrem,
        };
      });

      return res.status(200).json({ options: items, symbol: rawSym, delayed: true });

    } else {
      return res.status(400).json({ error: 'Invalid type. Use: movers, earnings, or options.' });
    }

  } catch (err) {
    console.error('[polygon]', type, err.message);
    return res.status(500).json({ error: 'Data unavailable — market may be closed or rate limit reached.' });
  }
};
