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

function fetchAV(path) {
  return new Promise((resolve, reject) => {
    https.get('https://www.alphavantage.co/query?' + path, (r) => {
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
  if (req.method !== 'GET') return res.status(405).json({error: 'Method not allowed'});

  const ip = req.headers['x-forwarded-for'] || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({error: 'Too many requests'});

  const key = process.env.ALPHA_VANTAGE_KEY;
  if (!key) return res.status(500).json({error: 'Not configured'});

  const symbol = (req.query.symbol || '').replace(/[^A-Z0-9.\-]/g, '').slice(0, 10).toUpperCase();
  if (!symbol) return res.status(400).json({error: 'Symbol required'});

  try {
    const [rsiData, macdData, bbandsData] = await Promise.all([
      fetchAV('function=RSI&symbol=' + symbol + '&interval=daily&time_period=14&series_type=close&apikey=' + key),
      fetchAV('function=MACD&symbol=' + symbol + '&interval=daily&series_type=close&apikey=' + key),
      fetchAV('function=BBANDS&symbol=' + symbol + '&interval=daily&time_period=20&series_type=close&apikey=' + key),
    ]);

    if (rsiData.Note || rsiData.Information || macdData.Note || macdData.Information || bbandsData.Note || bbandsData.Information) {
      return res.status(429).json({error: 'Alpha Vantage rate limit reached. Please wait and try again.'});
    }

    const rsiSeries = rsiData['Technical Analysis: RSI'];
    if (!rsiSeries) return res.status(502).json({error: 'RSI data unavailable'});
    const rsiDate = Object.keys(rsiSeries)[0];
    const rsiVal = parseFloat(rsiSeries[rsiDate]['RSI']);
    const rsiSignal = rsiVal >= 70 ? 'Overbought' : rsiVal <= 30 ? 'Oversold' : 'Neutral';

    const macdSeries = macdData['Technical Analysis: MACD'];
    if (!macdSeries) return res.status(502).json({error: 'MACD data unavailable'});
    const macdDate = Object.keys(macdSeries)[0];
    const macdEntry = macdSeries[macdDate];
    const macdVal = parseFloat(macdEntry['MACD']);
    const macdSignalVal = parseFloat(macdEntry['MACD_Signal']);
    const macdHist = parseFloat(macdEntry['MACD_Hist']);
    const macdLabel = macdHist >= 0 ? 'Bullish' : 'Bearish';

    const bbSeries = bbandsData['Technical Analysis: BBANDS'];
    if (!bbSeries) return res.status(502).json({error: 'Bollinger Bands data unavailable'});
    const bbDate = Object.keys(bbSeries)[0];
    const bbEntry = bbSeries[bbDate];
    const bbUpper = parseFloat(bbEntry['Real Upper Band']);
    const bbMiddle = parseFloat(bbEntry['Real Middle Band']);
    const bbLower = parseFloat(bbEntry['Real Lower Band']);

    return res.status(200).json({
      symbol,
      date: rsiDate,
      rsi: {value: rsiVal, signal: rsiSignal},
      macd: {macd: macdVal, signal: macdSignalVal, histogram: macdHist, signal_label: macdLabel},
      bbands: {upper: bbUpper, middle: bbMiddle, lower: bbLower},
    });
  } catch (e) {
    return res.status(500).json({error: 'Failed to fetch indicators'});
  }
};
