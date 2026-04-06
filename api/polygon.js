const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 30;
  const entry = rateLimit.get(ip);
  if (!entry || now - entry.start > w) {
    rateLimit.set(ip, { count: 1, start: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

function httpsGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Invalid JSON')); } });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

// Timeframe param → Polygon multiplier/timespan
const TF_MAP = {
  '1m':  { mult: 1,  span: 'minute' },
  '5m':  { mult: 5,  span: 'minute' },
  '15m': { mult: 15, span: 'minute' },
  '1h':  { mult: 1,  span: 'hour'   },
  '1D':  { mult: 1,  span: 'day'    },
  '1W':  { mult: 1,  span: 'week'   },
  '1M':  { mult: 1,  span: 'month'  },
};

// How many calendar days of history to request per timeframe
const TF_DAYS = {
  '1m':  2,
  '5m':  5,
  '15m': 10,
  '1h':  30,
  '1D':  365,
  '1W':  730,
  '1M':  1825,
};

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
  if (!checkRate(ip)) return res.status(429).json({ error: 'Rate limit reached. Please wait a moment.' });

  const key = process.env.POLYGON_API_KEY;
  if (!key) return res.status(500).json({ error: 'Data service unavailable.' });

  const type = req.query.type || '';

  try {
    // ── TOP MOVERS ─────────────────────────────────────────────────
    if (type === 'movers') {
      const [gainersData, losersData] = await Promise.all([
        httpsGet(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers?apiKey=${key}`),
        httpsGet(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/losers?apiKey=${key}`),
      ]);

      const mapTicker = t => ({
        symbol:        t.ticker,
        price:         t.day?.c ?? t.prevDay?.c ?? null,
        changePercent: t.todaysChangePerc ?? null,
      });

      const gainers = (gainersData.tickers || []).slice(0, 5).map(mapTicker);
      const losers  = (losersData.tickers  || []).slice(0, 5).map(mapTicker);

      return res.status(200).json({ gainers, losers });

    // ── OPTIONS CHAIN ───────────────────────────────────────────────
    } else if (type === 'options') {
      const rawSym = (req.query.symbol || '')
        .toUpperCase()
        .replace(/[^A-Z0-9.\-]/g, '')
        .slice(0, 10);
      if (!rawSym) return res.status(400).json({ error: 'symbol is required' });

      const data = await httpsGet(
        `https://api.polygon.io/v3/snapshot/options/${rawSym}?limit=20&apiKey=${key}`
      );

      const items = (data.results || []).map(r => {
        const d   = r.details || {};
        const day = r.day    || {};
        const rawPrem = (day.vwap != null && d.shares_per_contract != null)
          ? day.vwap * d.shares_per_contract
          : null;
        return {
          symbol:             rawSym,
          type:               d.contract_type ? d.contract_type.toUpperCase() : '--',
          strike:             d.strike_price ?? null,
          expiry:             d.expiration_date || '--',
          volume:             day.volume ?? null,
          open_interest:      r.open_interest ?? null,
          implied_volatility: r.implied_volatility != null
            ? (r.implied_volatility * 100).toFixed(1)
            : null,
          premium: rawPrem,
        };
      });

      return res.status(200).json({ options: items, symbol: rawSym });

    // ── EARNINGS / FINANCIALS ───────────────────────────────────────
    } else if (type === 'earnings') {
      const data = await httpsGet(
        `https://api.polygon.io/vX/reference/financials?limit=20&order=desc&apiKey=${key}`
      );

      const items = (data.results || []).map(r => {
        const is = r.financials?.income_statement || {};
        return {
          ticker:    r.ticker,
          period:    r.fiscal_period || null,
          year:      r.fiscal_year   || null,
          date:      r.filing_date   || r.start_date || null,
          revenue:   is.revenues?.value               ?? null,
          netIncome: is.net_income_loss?.value         ?? null,
          eps:       is.basic_earnings_per_share?.value ?? null,
        };
      });

      return res.status(200).json({ earnings: items });

    // ── HISTORICAL OHLCV ────────────────────────────────────────────
    } else if (type === 'historical') {
      const rawSym = (req.query.symbol || '')
        .toUpperCase()
        .replace(/[^A-Z0-9.\-]/g, '')
        .slice(0, 10);
      if (!rawSym) return res.status(400).json({ error: 'symbol is required' });

      const tf = req.query.timeframe || '1D';
      const cfg = TF_MAP[tf] || TF_MAP['1D'];
      const days = TF_DAYS[tf] || 365;

      const toDate   = new Date();
      const fromDate = new Date(toDate.getTime() - days * 86400000);
      const from = fromDate.toISOString().split('T')[0];
      const to   = toDate.toISOString().split('T')[0];

      const data = await httpsGet(
        `https://api.polygon.io/v2/aggs/ticker/${rawSym}/range/${cfg.mult}/${cfg.span}/${from}/${to}?adjusted=true&sort=asc&limit=5000&apiKey=${key}`
      );

      const bars = (data.results || []).map(b => ({
        t: b.t,   // timestamp ms
        o: b.o,
        h: b.h,
        l: b.l,
        c: b.c,
        v: b.v,
      }));

      return res.status(200).json({ symbol: rawSym, timeframe: tf, bars });

    } else {
      return res.status(400).json({ error: 'Invalid type. Use: movers, options, earnings, or historical.' });
    }

  } catch (err) {
    console.error('[polygon]', type, err.message);
    return res.status(500).json({ error: 'Data unavailable — market may be closed or rate limit reached.' });
  }
};
