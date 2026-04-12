const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

function withTimeout(promise, ms = 8000, fallback = null) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

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

// ── Options flow score cache ──────────────────────────────────────────────────
const flowScoreCache = {};
const FLOW_SCORE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/**
 * Fetches top-50 options contracts for `symbol`, aggregates call/put volume and
 * open interest, and returns a directional score from -20 (bearish) to +20 (bullish).
 *
 * volumeScore = (callVol / totalVol - 0.5) × 20   (range -10 .. +10)
 * oiScore     = (callOI  / totalOI  - 0.5) × 20   (range -10 .. +10)
 * score       = clamp(volumeScore + oiScore, -20, +20)
 * signal      = score ≥ 8 → 'bullish' | score ≤ -8 → 'bearish' | else 'neutral'
 * smartMoney  = volumeRatio > 0.80 (heavy call-side skew)
 */
async function getOptionsFlowScore(symbol, key) {
  const cacheKey = `flow:${symbol}`;
  const cached = flowScoreCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < FLOW_SCORE_CACHE_TTL) {
    console.log(`[polygon/flowscore] cache hit for ${symbol}`);
    return cached.result;
  }

  const data = await httpsGet(
    `https://api.polygon.io/v3/snapshot/options/${symbol}?limit=50&apiKey=${key}`
  );

  const results = data?.results;
  if (!Array.isArray(results) || results.length === 0) {
    return { score: 0, signal: 'neutral', volumeRatio: null, oiRatio: null, smartMoney: false, contracts: 0 };
  }

  let callVol = 0, putVol = 0, callOI = 0, putOI = 0;
  for (const r of results) {
    const ct  = (r.details?.contract_type || '').toLowerCase();
    const vol = r.day?.volume ?? 0;
    const oi  = r.open_interest ?? 0;
    if (ct === 'call') { callVol += vol; callOI += oi; }
    else if (ct === 'put') { putVol += vol; putOI += oi; }
  }

  const totalVol = callVol + putVol;
  const totalOI  = callOI  + putOI;

  const volumeRatio = totalVol > 0 ? callVol / totalVol : 0.5;
  const oiRatio     = totalOI  > 0 ? callOI  / totalOI  : 0.5;

  const volumeScore = (volumeRatio - 0.5) * 20;
  const oiScore     = (oiRatio     - 0.5) * 20;
  const rawScore    = volumeScore + oiScore;
  const score       = Math.round(Math.max(-20, Math.min(20, rawScore)));

  const signal    = score >= 8 ? 'bullish' : score <= -8 ? 'bearish' : 'neutral';
  const smartMoney = volumeRatio > 0.80;

  const result = {
    score,
    signal,
    volumeRatio: parseFloat(volumeRatio.toFixed(3)),
    oiRatio:     parseFloat(oiRatio.toFixed(3)),
    smartMoney,
    contracts:   results.length,
    callVolume:  callVol,
    putVolume:   putVol,
    callOI,
    putOI,
  };

  flowScoreCache[cacheKey] = { ts: Date.now(), result };
  console.log(`[polygon/flowscore] ${symbol}: score=${score} signal=${signal} volRatio=${volumeRatio.toFixed(3)}`);
  return result;
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
  const _deadline = setTimeout(() => {
    if (!res.headersSent) res.status(200).json({ error: 'timeout', data: [] });
  }, 8000);

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
    } else if (type === 'options' || type === 'flow') {
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
      const today = new Date().toISOString().split('T')[0];

      // Fetch recent filings with tickers — request more so we can filter empty tickers
      let items = [];
      try {
        const data = await httpsGet(
          `https://api.polygon.io/vX/reference/financials?timeframe=quarterly&filing_date.gte=${today}&order=asc&limit=50&sort=filing_date&apiKey=${key}`
        );
        items = (data.results || [])
          .filter(r => r.tickers?.[0] || r.ticker)
          .map(r => {
            const is = r.financials?.income_statement || {};
            const ticker = r.tickers?.[0] || r.ticker || null;
            const epsActual = is.basic_earnings_per_share?.value ?? null;
            const epsDiluted = is.diluted_earnings_per_share?.value ?? null;
            return {
              ticker,
              companyName: r.company_name || ticker || '--',
              reportDate:  r.filing_date || r.end_date || null,
              period:      r.fiscal_period || null,
              year:        r.fiscal_year   || null,
              date:        r.filing_date   || r.start_date || null,
              revenue:     is.revenues?.value               ?? null,
              netIncome:   is.net_income_loss?.value         ?? null,
              eps:         epsActual ?? epsDiluted ?? null,
            };
          });
      } catch (e) {
        console.error('[polygon/earnings] upcoming fetch error:', e.message);
      }

      // If no upcoming filings, fall back to recent filings (desc order)
      if (!items.length) {
        try {
          const data = await httpsGet(
            `https://api.polygon.io/vX/reference/financials?timeframe=quarterly&order=desc&limit=50&sort=filing_date&apiKey=${key}`
          );
          items = (data.results || [])
            .filter(r => r.tickers?.[0] || r.ticker)
            .map(r => {
              const is = r.financials?.income_statement || {};
              const ticker = r.tickers?.[0] || r.ticker || null;
              const epsActual = is.basic_earnings_per_share?.value ?? null;
              const epsDiluted = is.diluted_earnings_per_share?.value ?? null;
              return {
                ticker,
                companyName: r.company_name || ticker || '--',
                reportDate:  r.filing_date || r.end_date || null,
                period:      r.fiscal_period || null,
                year:        r.fiscal_year   || null,
                date:        r.filing_date   || r.start_date || null,
                revenue:     is.revenues?.value               ?? null,
                netIncome:   is.net_income_loss?.value         ?? null,
                eps:         epsActual ?? epsDiluted ?? null,
              };
            });
        } catch (e) {
          console.error('[polygon/earnings] recent fetch error:', e.message);
        }
      }

      console.log('[polygon/earnings] returning', items.length, 'entries, tickers:', items.slice(0, 5).map(i => i.ticker).join(','));
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

    // ── OPTIONS FLOW SCORE ──────────────────────────────────────────
    } else if (type === 'flowscore') {
      const rawSym = (req.query.symbol || '')
        .toUpperCase()
        .replace(/[^A-Z0-9.\-]/g, '')
        .slice(0, 10);
      if (!rawSym) return res.status(400).json({ error: 'symbol is required' });

      const flowResult = await getOptionsFlowScore(rawSym, key);
      return res.status(200).json({ symbol: rawSym, ...flowResult });

    } else {
      return res.status(400).json({ error: 'Invalid type. Use: movers, options, earnings, historical, or flowscore.' });
    }

  } catch (err) {
    console.error('[polygon]', type, err.message);
    return res.status(200).json({ error: 'Data unavailable — market may be closed or rate limit reached.' });
  } finally {
    clearTimeout(_deadline);
  }
};
