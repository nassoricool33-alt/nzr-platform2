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

  const base   = `https://api.polygon.io/v1/indicators`;
  const common2 = `timespan=day&adjusted=true&series_type=close&order=desc&limit=2&apiKey=${key}`;
  const common3 = `timespan=day&adjusted=true&series_type=close&order=desc&limit=3&apiKey=${key}`;

  try {
    const [rsiRes, macdRes, ema20Res, ema60Res, ema200Res] = await Promise.allSettled([
      httpsGet(`${base}/rsi/${symbol}?${common2}&window=14`),
      httpsGet(`${base}/macd/${symbol}?${common2}&short_window=12&long_window=26&signal_window=9`),
      httpsGet(`${base}/ema/${symbol}?${common2}&window=20`),
      httpsGet(`${base}/ema/${symbol}?${common3}&window=60`),
      httpsGet(`${base}/ema/${symbol}?${common3}&window=200`),
    ]);

    const get = (r) => r.status === 'fulfilled' ? r.value : null;
    const rsiData   = get(rsiRes);
    const macdData  = get(macdRes);
    const ema20Data = get(ema20Res);
    const ema60Data = get(ema60Res);
    const ema200Data= get(ema200Res);

    // RSI
    const rsiValues = rsiData?.results?.values;
    if (!rsiValues?.length) return res.status(502).json({ error: 'RSI data unavailable' });
    const rsiVal    = rsiValues[0].value;
    const rsiSignal = rsiVal >= 70 ? 'Overbought' : rsiVal <= 30 ? 'Oversold' : 'Neutral';

    // MACD
    const macdValues = macdData?.results?.values;
    if (!macdValues?.length) return res.status(502).json({ error: 'MACD data unavailable' });
    const macdEntry  = macdValues[0];
    const macdVal    = macdEntry.value;
    const macdSignal = macdEntry.signal;
    const macdHist   = macdEntry.histogram;
    const macdLabel  = macdHist >= 0 ? 'Bullish' : 'Bearish';

    // EMA20
    const ema20Values = ema20Data?.results?.values;
    const ema20 = ema20Values?.[0]?.value ?? null;

    // EMA60 & EMA200 — golden/death cross
    const ema60Values  = ema60Data?.results?.values;
    const ema200Values = ema200Data?.results?.values;
    let goldenCross = null;
    if (ema60Values?.length && ema200Values?.length) {
      const ema60Now   = ema60Values[0].value;
      const ema200Now  = ema200Values[0].value;
      const ema60Prev  = ema60Values[1]?.value  ?? null;
      const ema200Prev = ema200Values[1]?.value ?? null;

      let signal, fresh;
      const freshGolden = ema60Prev !== null && ema200Prev !== null
        && ema60Now > ema200Now && ema60Prev <= ema200Prev;
      const freshDeath  = ema60Prev !== null && ema200Prev !== null
        && ema60Now < ema200Now && ema60Prev >= ema200Prev;

      if (freshGolden)          { signal = 'Fresh Golden Cross'; fresh = true; }
      else if (freshDeath)      { signal = 'Fresh Death Cross';  fresh = true; }
      else if (ema60Now > ema200Now) { signal = 'Golden Cross';  fresh = false; }
      else                      { signal = 'Death Cross';        fresh = false; }

      goldenCross = {
        signal,
        ema60:   ema60Now,
        ema200:  ema200Now,
        fresh,
        bullish: ema60Now > ema200Now,
      };
    }

    return res.status(200).json({
      symbol,
      rsi:          { value: rsiVal, signal: rsiSignal },
      macd:         { macd: macdVal, signal: macdSignal, histogram: macdHist, signal_label: macdLabel },
      ema20,
      ema60:        ema60Values?.[0]?.value  ?? null,
      ema200:       ema200Values?.[0]?.value ?? null,
      golden_cross: goldenCross,
    });
  } catch (err) {
    console.error('[indicators]', symbol, err.message);
    return res.status(500).json({ error: 'Indicators unavailable.' });
  }
};
