/**
 * NZR — Pharma Data API
 * Endpoints: calendar, scan, signal, shorts, fda
 * Requires env vars: POLYGON_KEY, ANTHROPIC_API_KEY
 */

const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

const PHARMA_SYMBOLS = [
  'MRNA','PFE','BIIB','NVAX','GILD','REGN','VRTX','BMY','ABBV','JNJ',
  'AMGN','LLY','NVO','ISRG','ILMN','SGEN','ALNY','BGNE','EXAS','INCY',
  'ACAD','SRPT','BMRN','RARE','FOLD','ARWR','BEAM','EDIT','NTLA','CRSP'
];

const HALAL_VERIFIED = new Set(['MRNA','PFE','BIIB','GILD','AMGN','LLY','NVO','VRTX']);

const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 30;
  const e = rateLimit.get(ip);
  if (!e || now - e.start > w) { rateLimit.set(ip, { count: 1, start: now }); return true; }
  if (e.count >= max) return false;
  e.count++; return true;
}

function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'Accept': 'application/json', ...extraHeaders },
    };
    const req = https.request(opts, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: d ? JSON.parse(d) : null }); }
        catch { resolve({ status: r.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(url, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const bodyStr = JSON.stringify(payload);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...extraHeaders,
      },
    };
    const req = https.request(opts, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: d ? JSON.parse(d) : null }); }
        catch { resolve({ status: r.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Polygon helpers ────────────────────────────────────────────────────────────

async function polyGet(path, key) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await httpsGet(`https://api.polygon.io${path}${sep}apiKey=${key}`);
  return r.body;
}

async function getPrevDay(symbol, key) {
  const data = await polyGet(`/v2/aggs/ticker/${symbol}/prev`, key);
  if (data?.results?.length) return data.results[0];
  return null;
}

async function getDailyBars(symbol, from, to, key) {
  const data = await polyGet(`/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=500`, key);
  return data?.results || [];
}

async function getTickerDetails(symbol, key) {
  const data = await polyGet(`/v3/reference/tickers/${symbol}`, key);
  return data?.results || null;
}

async function getNews(symbol, key, limit = 5) {
  const data = await polyGet(`/v2/reference/news?ticker=${symbol}&limit=${limit}&sort=published_utc&order=desc`, key);
  return data?.results || [];
}

async function getFinancials(symbol, key) {
  const data = await polyGet(`/vX/reference/financials?ticker=${symbol}&limit=4&sort=filing_date&order=desc`, key);
  return data?.results || [];
}

// ── Indicator helpers ──────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const result = new Array(closes.length).fill(null);
  let sum = 0, seeded = false, seedCount = 0;
  for (let i = 0; i < closes.length; i++) {
    if (!seeded) {
      sum += closes[i];
      seedCount++;
      if (seedCount === period) {
        result[i] = sum / period;
        seeded = true;
      }
    } else {
      result[i] = closes[i] * k + result[i - 1] * (1 - k);
    }
  }
  return result;
}

function calcRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    result[i] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  }
  return result;
}

function calcATR(bars, period = 14) {
  if (bars.length < 2) return new Array(bars.length).fill(null);
  const result = new Array(bars.length).fill(null);
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return result;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period] = atr;
  for (let i = period + 1; i < bars.length; i++) {
    atr = (atr * (period - 1) + trs[i - 1]) / period;
    result[i] = atr;
  }
  return result;
}

// ── FDA helpers ────────────────────────────────────────────────────────────────

const FDA_HARDCODED = [
  { drug: 'Lecanemab (Leqembi)', company: 'Eisai/Biogen (BIIB)', ticker: 'BIIB', date: '2026-06-15', type: 'PDUFA', indication: "Alzheimer's Disease" },
  { drug: 'Donanemab', company: 'Eli Lilly (LLY)', ticker: 'LLY', date: '2026-07-02', type: 'PDUFA', indication: "Alzheimer's Disease" },
  { drug: 'Imetelstat', company: 'Geron/J&J (JNJ)', ticker: 'JNJ', date: '2026-06-28', type: 'PDUFA', indication: 'Myelodysplastic Syndromes' },
  { drug: 'mRNA-1283', company: 'Moderna (MRNA)', ticker: 'MRNA', date: '2026-08-10', type: 'PDUFA', indication: 'COVID-19 Booster' },
  { drug: 'Patritumab Deruxtecan', company: 'Daiichi/AstraZeneca', ticker: 'AZN', date: '2026-05-20', type: 'PDUFA', indication: 'NSCLC' },
];

async function fetchFDACalendar() {
  try {
    const r = await httpsGet('https://api.fda.gov/drug/drugsfda.json?search=application_number:NDA*&limit=10&sort=submissions.submission_status_date:desc');
    if (r.status === 200 && r.body?.results?.length) {
      const events = [];
      for (const item of r.body.results) {
        const subs = item.submissions || [];
        for (const sub of subs) {
          if (sub.submission_type === 'PDUFA' || sub.submission_status === 'AP') {
            events.push({
              drug: item.openfda?.brand_name?.[0] || item.openfda?.generic_name?.[0] || 'Unknown',
              company: item.sponsor_name || 'Unknown',
              ticker: null,
              date: sub.submission_status_date || sub.pdufa_date || null,
              type: sub.submission_type || 'FDA',
              indication: sub.application_number || '',
            });
          }
        }
      }
      if (events.length > 0) return events.slice(0, 20);
    }
  } catch { /* fallback */ }
  return FDA_HARDCODED;
}

// ── Claude sentiment analysis ──────────────────────────────────────────────────

async function analyzeSentiment(symbol, newsItems, anthropicKey) {
  if (!anthropicKey || !newsItems.length) {
    return { score: 0.5, label: 'NEUTRAL', confidence: 0.3, summary: 'No news available for analysis' };
  }
  const headlines = newsItems.slice(0, 5).map((n, i) => `${i + 1}. ${n.title || n.headline || ''}`).join('\n');
  const prompt = `You are a pharmaceutical stock analyst. Analyze these recent news headlines for ${symbol} and provide a trading sentiment assessment.

Headlines:
${headlines}

Respond in JSON only with this exact format:
{"score": 0.75, "label": "BULLISH", "confidence": 0.8, "summary": "Brief 1-sentence reason"}

score: 0.0 (very bearish) to 1.0 (very bullish), 0.5 = neutral
label: "BULLISH", "BEARISH", or "NEUTRAL"
confidence: 0.0 to 1.0
summary: max 120 characters`;

  try {
    const r = await httpsPost(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      }
    );
    if (r.status === 200 && r.body?.content?.[0]?.text) {
      const text = r.body.content[0].text.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          score: Math.max(0, Math.min(1, parsed.score ?? 0.5)),
          label: ['BULLISH','BEARISH','NEUTRAL'].includes(parsed.label) ? parsed.label : 'NEUTRAL',
          confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
          summary: String(parsed.summary || '').slice(0, 150),
        };
      }
    }
  } catch { /* fallback */ }
  return { score: 0.5, label: 'NEUTRAL', confidence: 0.3, summary: 'Sentiment analysis unavailable' };
}

// ── Action handlers ────────────────────────────────────────────────────────────

async function handleCalendar(key, anthropicKey) {
  const fdaEvents = await fetchFDACalendar();

  // Enrich with upcoming earnings from Polygon financials (for top symbols)
  const enriched = [];
  const earningsPromises = ['MRNA','BIIB','LLY','PFE','GILD'].map(async sym => {
    try {
      const fins = await getFinancials(sym, key);
      if (fins.length) {
        return {
          ticker: sym,
          lastFilingDate: fins[0].filing_date,
          fiscalPeriod: fins[0].fiscal_period,
          fiscalYear: fins[0].fiscal_year,
        };
      }
    } catch { /* skip */ }
    return null;
  });
  const earningsData = (await Promise.all(earningsPromises)).filter(Boolean);

  // Mark which FDA events have catalyst imminent (within 14 days)
  const today = new Date();
  for (const ev of fdaEvents) {
    const evDate = ev.date ? new Date(ev.date) : null;
    const daysAway = evDate ? Math.ceil((evDate - today) / 86400000) : null;
    enriched.push({
      ...ev,
      daysAway,
      catalystImminent: daysAway !== null && daysAway >= 0 && daysAway <= 14,
      halalStatus: ev.ticker ? (HALAL_VERIFIED.has(ev.ticker) ? 'HALAL VERIFIED' : 'UNVERIFIED') : 'UNKNOWN',
    });
  }

  enriched.sort((a, b) => {
    if (a.daysAway === null) return 1;
    if (b.daysAway === null) return -1;
    return a.daysAway - b.daysAway;
  });

  return { events: enriched, earnings: earningsData, count: enriched.length };
}

async function handleScan(key) {
  const results = await Promise.all(
    PHARMA_SYMBOLS.map(async sym => {
      try {
        const prev = await getPrevDay(sym, key);
        if (!prev) return null;
        const changePct = prev.o > 0 ? ((prev.c - prev.o) / prev.o) * 100 : 0;
        const range = prev.h - prev.l;
        const rangePct = prev.o > 0 ? (range / prev.o) * 100 : 0;
        return {
          symbol: sym,
          close: prev.c,
          open: prev.o,
          high: prev.h,
          low: prev.l,
          volume: prev.v,
          vwap: prev.vw || null,
          changePct: +changePct.toFixed(2),
          rangePct: +rangePct.toFixed(2),
          halalStatus: HALAL_VERIFIED.has(sym) ? 'HALAL VERIFIED' : 'UNVERIFIED',
          catalystImminent: false, // enriched below if FDA data available
        };
      } catch { return null; }
    })
  );

  const valid = results.filter(Boolean);

  // Calculate average volume for relative volume
  const volAvg = valid.reduce((s, r) => s + r.volume, 0) / (valid.length || 1);

  for (const r of valid) {
    r.relVolume = volAvg > 0 ? +(r.volume / (volAvg / valid.length)).toFixed(2) : 1;
    // Flag catalyst imminent from FDA hardcoded list
    const fdaMatch = FDA_HARDCODED.find(e => e.ticker === r.symbol);
    if (fdaMatch) {
      const daysAway = Math.ceil((new Date(fdaMatch.date) - new Date()) / 86400000);
      r.catalystImminent = daysAway >= 0 && daysAway <= 14;
      r.catalystDate = fdaMatch.date;
      r.catalystDrug = fdaMatch.drug;
    }
  }

  // Sort by composite score: volume activity + price movement
  valid.sort((a, b) => {
    const scoreA = Math.abs(a.changePct) * 0.4 + a.rangePct * 0.3 + Math.min(a.relVolume, 5) * 0.3;
    const scoreB = Math.abs(b.changePct) * 0.4 + b.rangePct * 0.3 + Math.min(b.relVolume, 5) * 0.3;
    return scoreB - scoreA;
  });

  return { symbols: valid, count: valid.length, scannedAt: new Date().toISOString() };
}

async function handleSignal(symbol, key, anthropicKey) {
  if (!symbol) return { error: 'symbol required' };
  const sym = symbol.replace(/[^A-Z0-9]/g, '').slice(0, 10).toUpperCase();

  // Fetch 90 days of daily bars for indicators
  const to = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

  const [bars, prev, news, details] = await Promise.all([
    getDailyBars(sym, fromDate, to, key),
    getPrevDay(sym, key),
    getNews(sym, key, 8),
    getTickerDetails(sym, key).catch(() => null),
  ]);

  if (!bars.length || !prev) return { error: `No data available for ${sym}` };

  const closes = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);
  const rsiArr = calcRSI(closes, 14);
  const ema20Arr = calcEMA(closes, 20);
  const ema50Arr = calcEMA(closes, 50);
  const ema200Arr = calcEMA(closes, 200);
  const atrArr = calcATR(bars, 14);

  const n = closes.length - 1;
  const rsi = rsiArr[n];
  const ema20 = ema20Arr[n];
  const ema50 = ema50Arr[n];
  const ema200 = ema200Arr[n];
  const atr = atrArr[n];
  const close = closes[n];

  // Volume analysis
  const volAvg20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const todayVol = volumes[n];
  const relVol = volAvg20 > 0 ? +(todayVol / volAvg20).toFixed(2) : 1;

  // Technical score (0–1)
  let techScore = 0.5;
  if (rsi !== null) {
    if (rsi < 30) techScore += 0.25;
    else if (rsi < 45) techScore += 0.12;
    else if (rsi > 70) techScore -= 0.25;
    else if (rsi > 60) techScore -= 0.12;
  }
  if (ema20 && ema50) {
    if (close > ema20 && ema20 > ema50) techScore += 0.15;
    else if (close < ema20 && ema20 < ema50) techScore -= 0.15;
  }
  if (ema200) {
    if (close > ema200) techScore += 0.1;
    else techScore -= 0.1;
  }
  if (relVol > 2) techScore += 0.1;
  techScore = Math.max(0, Math.min(1, techScore));

  // Catalyst score (0–1)
  let catalystScore = 0.5;
  const fdaMatch = FDA_HARDCODED.find(e => e.ticker === sym);
  let catalystInfo = null;
  if (fdaMatch) {
    const daysAway = Math.ceil((new Date(fdaMatch.date) - new Date()) / 86400000);
    catalystInfo = { ...fdaMatch, daysAway };
    if (daysAway >= 0 && daysAway <= 7) catalystScore = 0.85;
    else if (daysAway >= 0 && daysAway <= 30) catalystScore = 0.7;
  }

  // Sentiment score via Claude (0–1)
  const sentiment = await analyzeSentiment(sym, news, anthropicKey);

  // Combined signal: technical 40%, sentiment 40%, catalyst 20%
  const combinedScore = techScore * 0.4 + sentiment.score * 0.4 + catalystScore * 0.2;

  let signal = 'HOLD';
  let signalStrength = 'WEAK';
  if (combinedScore >= 0.72) { signal = 'BUY'; signalStrength = 'STRONG'; }
  else if (combinedScore >= 0.62) { signal = 'BUY'; signalStrength = 'MODERATE'; }
  else if (combinedScore <= 0.28) { signal = 'SELL'; signalStrength = 'STRONG'; }
  else if (combinedScore <= 0.38) { signal = 'SELL'; signalStrength = 'MODERATE'; }

  // ATR-based stops
  const stopLoss = atr ? +(close - 2 * atr).toFixed(2) : null;
  const takeProfit = atr ? +(close + 3 * atr).toFixed(2) : null;

  const changePct = prev.o > 0 ? +((prev.c - prev.o) / prev.o * 100).toFixed(2) : 0;

  return {
    symbol: sym,
    price: close,
    changePct,
    volume: todayVol,
    relVolume: relVol,
    rsi: rsi !== null ? +rsi.toFixed(2) : null,
    ema20: ema20 ? +ema20.toFixed(2) : null,
    ema50: ema50 ? +ema50.toFixed(2) : null,
    ema200: ema200 ? +ema200.toFixed(2) : null,
    atr: atr ? +atr.toFixed(4) : null,
    technicalScore: +techScore.toFixed(3),
    sentimentScore: +sentiment.score.toFixed(3),
    sentimentLabel: sentiment.label,
    sentimentConfidence: +sentiment.confidence.toFixed(2),
    sentimentSummary: sentiment.summary,
    catalystScore: +catalystScore.toFixed(3),
    catalystInfo,
    combinedScore: +combinedScore.toFixed(3),
    signal,
    signalStrength,
    stopLoss,
    takeProfit,
    halalStatus: HALAL_VERIFIED.has(sym) ? 'HALAL VERIFIED' : 'UNVERIFIED',
    news: news.slice(0, 5).map(n => ({ title: n.title, published: n.published_utc, url: n.article_url })),
    companyName: details?.name || sym,
    analyzedAt: new Date().toISOString(),
  };
}

async function handleShorts(key) {
  const results = await Promise.all(
    PHARMA_SYMBOLS.map(async sym => {
      try {
        const prev = await getPrevDay(sym, key);
        if (!prev || prev.c < 10) return null; // require price > $10

        const changePct = prev.o > 0 ? ((prev.c - prev.o) / prev.o) * 100 : 0;
        if (changePct < 10) return null; // require >10% move

        // Get 30-day bars for RSI and relative volume
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const bars = await getDailyBars(sym, from, to, key);
        if (bars.length < 15) return null;

        const closes = bars.map(b => b.c);
        const volumes = bars.map(b => b.v);
        const rsiArr = calcRSI(closes, 14);
        const rsi = rsiArr[rsiArr.length - 1];

        if (rsi === null || rsi <= 70) return null; // require RSI > 70

        const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
        const relVol = avgVol > 0 ? +(prev.v / avgVol).toFixed(2) : 1;

        if (relVol < 3) return null; // require rel vol > 3x

        return {
          symbol: sym,
          price: prev.c,
          changePct: +changePct.toFixed(2),
          volume: prev.v,
          relVolume: relVol,
          rsi: +rsi.toFixed(2),
          halalStatus: HALAL_VERIFIED.has(sym) ? 'HALAL VERIFIED' : 'UNVERIFIED',
          squeezeScore: +(changePct * 0.4 + (relVol / 10) * 0.3 + ((rsi - 70) / 30) * 0.3).toFixed(3),
        };
      } catch { return null; }
    })
  );

  const valid = results.filter(Boolean).sort((a, b) => b.squeezeScore - a.squeezeScore);
  return { candidates: valid, count: valid.length, scannedAt: new Date().toISOString() };
}

async function handleFDA() {
  const events = await fetchFDACalendar();
  const today = new Date();
  const enriched = events.map(ev => {
    const evDate = ev.date ? new Date(ev.date) : null;
    const daysAway = evDate ? Math.ceil((evDate - today) / 86400000) : null;
    return {
      ...ev,
      daysAway,
      catalystImminent: daysAway !== null && daysAway >= 0 && daysAway <= 14,
      halalStatus: ev.ticker ? (HALAL_VERIFIED.has(ev.ticker) ? 'HALAL VERIFIED' : 'UNVERIFIED') : 'UNKNOWN',
    };
  }).sort((a, b) => {
    if (a.daysAway === null) return 1;
    if (b.daysAway === null) return -1;
    return a.daysAway - b.daysAway;
  });
  return { events: enriched, count: enriched.length, source: 'fda+hardcoded' };
}

// ── Main handler ───────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'Rate limit reached' });

  const key = process.env.POLYGON_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'POLYGON_KEY not configured' });

  const action = String(req.query.action || '').toLowerCase();

  try {
    if (action === 'calendar') {
      const data = await handleCalendar(key, anthropicKey);
      return res.status(200).json(data);
    }

    if (action === 'scan') {
      const data = await handleScan(key);
      return res.status(200).json(data);
    }

    if (action === 'signal') {
      const symbol = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      const data = await handleSignal(symbol, key, anthropicKey);
      return res.status(data.error ? 400 : 200).json(data);
    }

    if (action === 'shorts') {
      const data = await handleShorts(key);
      return res.status(200).json(data);
    }

    if (action === 'fda') {
      const data = await handleFDA();
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: `Unknown action: ${action}. Valid: calendar, scan, signal, shorts, fda` });

  } catch (err) {
    console.error('[pharma]', action, err.message);
    return res.status(500).json({ error: 'Pharma request failed', detail: err.message });
  }
};
