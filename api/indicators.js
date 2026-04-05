const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 20;
  if (!rateLimit.has(ip)) { rateLimit.set(ip, { c: 1, s: now }); return true; }
  const e = rateLimit.get(ip);
  if (now - e.s > w) { rateLimit.set(ip, { c: 1, s: now }); return true; }
  if (e.c >= max) return false;
  e.c++;
  return true;
}

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

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'Too many requests' });

  const key = process.env.POLYGON_API_KEY;
  if (!key) return res.status(500).json({ error: 'Not configured' });

  const symbol = (req.query.symbol || '').replace(/[^A-Z0-9.\-]/g, '').slice(0, 10).toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });

  const base = `https://api.polygon.io/v1/indicators`;
  const common = `timespan=day&adjusted=true&series_type=close&order=desc&limit=2&apiKey=${key}`;

  try {
    const [rsiRes, macdRes, sma50Res, sma200Res, ema20Res] = await Promise.allSettled([
      httpsGet(`${base}/rsi/${symbol}?${common}&window=14`),
      httpsGet(`${base}/macd/${symbol}?${common}&short_window=12&long_window=26&signal_window=9`),
      httpsGet(`${base}/sma/${symbol}?${common}&window=50`),
      httpsGet(`${base}/sma/${symbol}?${common}&window=200`),
      httpsGet(`${base}/ema/${symbol}?${common}&window=20`),
    ]);

    const get = (r) => r.status === 'fulfilled' ? r.value : null;
    const rsiData   = get(rsiRes);
    const macdData  = get(macdRes);
    const sma50Data = get(sma50Res);
    const sma200Data= get(sma200Res);
    const ema20Data = get(ema20Res);

    // RSI
    const rsiResults = rsiData?.results?.values;
    if (!rsiResults?.length) return res.status(502).json({ error: 'RSI data unavailable' });
    const rsiVal = rsiResults[0].value;
    const rsiSignal = rsiVal >= 70 ? 'Overbought' : rsiVal <= 30 ? 'Oversold' : 'Neutral';

    // MACD
    const macdResults = macdData?.results?.values;
    if (!macdResults?.length) return res.status(502).json({ error: 'MACD data unavailable' });
    const macdEntry   = macdResults[0];
    const macdVal     = macdEntry.value;
    const macdSignal  = macdEntry.signal;
    const macdHist    = macdEntry.histogram;
    const macdLabel   = macdHist >= 0 ? 'Bullish' : 'Bearish';

    // SMA50 & SMA200 (golden/death cross)
    const sma50Values  = sma50Data?.results?.values;
    const sma200Values = sma200Data?.results?.values;
    let goldenCross = null;
    if (sma50Values?.length && sma200Values?.length) {
      const sma50Now  = sma50Values[0].value;
      const sma200Now = sma200Values[0].value;
      const sma50Prev  = sma50Values[1]?.value ?? null;
      const sma200Prev = sma200Values[1]?.value ?? null;
      let signal;
      if (sma50Prev !== null && sma200Prev !== null && sma50Prev <= sma200Prev && sma50Now > sma200Now) {
        signal = 'Golden Cross';
      } else if (sma50Prev !== null && sma200Prev !== null && sma50Prev >= sma200Prev && sma50Now < sma200Now) {
        signal = 'Death Cross';
      } else {
        signal = sma50Now > sma200Now ? 'Golden Cross' : 'Death Cross';
      }
      goldenCross = { signal, sma50: sma50Now, sma200: sma200Now };
    }

    // EMA20
    const ema20Values = ema20Data?.results?.values;
    const ema20 = ema20Values?.[0]?.value ?? null;

    return res.status(200).json({
      symbol,
      rsi:         { value: rsiVal, signal: rsiSignal },
      macd:        { macd: macdVal, signal: macdSignal, histogram: macdHist, signal_label: macdLabel },
      sma50:       sma50Values?.[0]?.value ?? null,
      sma200:      sma200Values?.[0]?.value ?? null,
      ema20,
      golden_cross: goldenCross,
    });
  } catch (err) {
    console.error('[indicators]', symbol, err.message);
    return res.status(500).json({ error: 'Indicators unavailable.' });
  }
};
