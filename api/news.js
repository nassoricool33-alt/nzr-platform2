const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

const HIGH_IMPACT_KEYWORDS = ['FOMC', 'Federal Reserve', 'CPI', 'Non-Farm', 'NFP', 'GDP', 'PCE', 'Unemployment', 'Interest Rate Decision', 'Jackson Hole'];

// ─── BREAKING NEWS CACHE ──────────────────────────────────────────────────────
let breakingNewsCache = null;
const BREAKING_NEWS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── GEO RISK CACHE ───────────────────────────────────────────────────────────
let geoRiskCache = null;
const GEO_RISK_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// ─── RATE LIMIT ───────────────────────────────────────────────────────────────
const rateLimit = new Map();
function checkRate(ip, max = 20) {
  const now = Date.now(), w = 60000;
  const e = rateLimit.get(ip);
  if (!e || now - e.s > w) { rateLimit.set(ip, { c: 1, s: now }); return true; }
  if (e.c >= max) return false;
  e.c++;
  return true;
}

// ─── SENTIMENT CACHE ─────────────────────────────────────────────────────────
// Keyed as "sentiment:SYMBOL" → { ts, result: { score, catalyst, summary } }
const sentimentCache = {};
const SENTIMENT_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

/**
 * Calls claude-sonnet-4-6 to score the trading sentiment of up to 5 headlines.
 * Returns { score: -10..10, catalyst: boolean, summary: string }.
 * Falls back to { score: 0, catalyst: false, summary: "neutral" } on any error.
 */
async function scoreNewsSentiment(headlines) {
  const fallback = { score: 0, catalyst: false, summary: 'neutral' };
  if (!headlines || headlines.length === 0) return fallback;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallback;

  const headlineStr = headlines.slice(0, 5).join(' | ');
  const prompt = `You are a trading signal assistant. Rate the overall trading sentiment of these headlines for the stock. Return ONLY valid JSON, no explanation: { "score": <integer from -10 to 10>, "catalyst": <true or false>, "summary": <5 words max> }. Headlines: ${headlineStr}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let resp;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 100,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      console.error('[news] sentiment API status:', resp.status);
      return fallback;
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text ?? '';

    // Strip any markdown fences the model might add
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]);
    const scoreRaw = parseInt(parsed.score ?? 0, 10);
    return {
      score:    isNaN(scoreRaw) ? 0 : Math.max(-10, Math.min(10, scoreRaw)),
      catalyst: parsed.catalyst === true,
      summary:  String(parsed.summary ?? 'neutral').slice(0, 60),
    };
  } catch (err) {
    console.error('[news] sentiment error:', err.message);
    return fallback;
  }
}

function httpsGet(url, opts = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, opts, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('Invalid JSON')); } });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

async function getHighImpactEvents(finnhubKey) {
  const today = new Date().toISOString().slice(0, 10);
  const to    = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  let events  = [];
  try {
    const data = await httpsGet(
      `https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${to}&token=${finnhubKey}`
    );
    const all = data?.economicCalendar || [];
    events = all.filter(e => {
      const isHigh    = e.impact === 'high' || (e.importance != null && e.importance >= 3);
      const hasKw     = HIGH_IMPACT_KEYWORDS.some(kw => (e.event || '').includes(kw));
      return isHigh || hasKw;
    });
  } catch (err) {
    console.error('[news/macro] fetch error:', err.message);
  }

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const hasHighImpactToday    = events.some(e => (e.time || e.date || '').slice(0, 10) === today);
  const hasHighImpactTomorrow = events.some(e => (e.time || e.date || '').slice(0, 10) === tomorrow);
  const nextEvent = events.length > 0
    ? { name: events[0].event, date: events[0].time || events[0].date, impact: events[0].impact || 'high' }
    : null;

  return { hasHighImpactToday, hasHighImpactTomorrow, events, nextEvent };
}

// ─── CLAUDE HELPER ───────────────────────────────────────────────────────────

async function callClaude(prompt, maxTokens = 500) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let resp;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!resp.ok) { console.error('[news/claude] HTTP', resp.status); return null; }
    const data = await resp.json();
    const text = data.content?.[0]?.text ?? '';
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    return m ? JSON.parse(m[0]) : null;
  } catch (err) {
    console.error('[news/claude] error:', err.message);
    return null;
  }
}

// ─── BREAKING NEWS ────────────────────────────────────────────────────────────

async function handleBreakingNews(polygonKey, finnhubKey) {
  if (breakingNewsCache && (Date.now() - breakingNewsCache.ts) < BREAKING_NEWS_CACHE_TTL) {
    console.log('[news/breaking] cache hit');
    return breakingNewsCache.result;
  }

  // Fetch Polygon general news + Finnhub general news in parallel
  const [polyRes, finnRes] = await Promise.allSettled([
    httpsGet(
      `https://api.polygon.io/v2/reference/news?limit=50&order=desc&sort=published_utc&apiKey=${polygonKey}`
    ),
    finnhubKey
      ? httpsGet(
          `https://finnhub.io/api/v1/news?category=general&token=${finnhubKey}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        )
      : Promise.resolve(null),
  ]);

  // Normalise both feeds to { title, datetime, source, url }
  const polyItems = (polyRes.status === 'fulfilled' ? polyRes.value?.results ?? [] : [])
    .map(n => ({ title: n.title, datetime: n.published_utc, source: n.publisher?.name ?? 'Polygon', url: n.article_url, tickers: n.tickers ?? [] }));

  const finnItems = (finnRes.status === 'fulfilled' && Array.isArray(finnRes.value) ? finnRes.value : [])
    .map(n => ({ title: n.headline, datetime: new Date(n.datetime * 1000).toISOString(), source: n.source ?? 'Finnhub', url: n.url, tickers: [] }));

  // Combine + deduplicate by headline similarity (first 60 chars)
  const seen = new Set();
  const combined = [];
  for (const item of [...polyItems, ...finnItems]) {
    if (!item.title) continue;
    const key = item.title.slice(0, 60).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!seen.has(key)) { seen.add(key); combined.push(item); }
  }
  // Sort newest first
  combined.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  const top50 = combined.slice(0, 50);

  // Single Claude batch call — analyze all headlines at once
  const fallbackAnalyses = top50.map(() => ({
    impact: 'low', direction: 'neutral', affectedSectors: [], affectedSymbols: [],
    isGeopolitical: false, isFlashNews: false, pauseTrading: false, reason: 'unavailable',
  }));

  let analyses = fallbackAnalyses;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey && top50.length > 0) {
    const headlineList = top50.map((h, i) => `${i + 1}. ${h.title}`).join('\n');
    const prompt = `You are a trading risk monitor. Analyze these ${top50.length} news headlines and return ONLY a valid JSON array (no explanation, no markdown) with one object per headline in the same order:
[
  {
    "impact": "high" | "medium" | "low" | "none",
    "direction": "bullish" | "bearish" | "neutral",
    "affectedSectors": ["XLK","XLF" etc],
    "affectedSymbols": ["AAPL","NVDA" etc],
    "isGeopolitical": true/false,
    "isFlashNews": true/false,
    "pauseTrading": true/false,
    "reason": "one sentence"
  }
]
pauseTrading=true ONLY for: war/conflict escalation, major central bank surprise, circuit breaker trigger, major sovereign default, pandemic declaration, major natural disaster.
Headlines:\n${headlineList}`;

    const result = await callClaude(prompt, 3000);
    if (Array.isArray(result) && result.length === top50.length) {
      analyses = result;
    } else if (Array.isArray(result)) {
      // Pad or trim to match
      analyses = top50.map((_, i) => result[i] ?? fallbackAnalyses[i]);
    }
  }

  // Attach analysis to each headline
  const headlines = top50.map((item, i) => ({
    ...item,
    analysis: analyses[i] ?? fallbackAnalyses[i],
  }));

  // Aggregate market-level flags
  const now10Min = Date.now() - 10 * 60 * 1000;
  const highImpact = headlines.filter(h => h.analysis.impact === 'high');
  const marketPauseRecommended = headlines.some(h => h.analysis.pauseTrading);
  const flashNews = headlines.filter(h =>
    h.analysis.impact === 'high' &&
    h.analysis.isFlashNews &&
    new Date(h.datetime).getTime() > now10Min
  );

  // Sector aggregation
  const sectorBullish = {}, sectorBearish = {};
  for (const h of headlines) {
    const { direction, affectedSectors } = h.analysis;
    if (!Array.isArray(affectedSectors)) continue;
    for (const s of affectedSectors) {
      if (direction === 'bullish') sectorBullish[s] = (sectorBullish[s] ?? 0) + 1;
      if (direction === 'bearish') sectorBearish[s] = (sectorBearish[s] ?? 0) + 1;
    }
  }
  const bullishSectors = Object.entries(sectorBullish).sort((a,b)=>b[1]-a[1]).map(([s])=>s);
  const bearishSectors = Object.entries(sectorBearish).sort((a,b)=>b[1]-a[1]).map(([s])=>s);
  const pauseReason = marketPauseRecommended
    ? headlines.find(h => h.analysis.pauseTrading)?.title ?? 'Breaking news'
    : null;

  const result = {
    headlines,
    marketPauseRecommended,
    pauseReason,
    highImpactCount: highImpact.length,
    flashNewsItems:  flashNews.map(h => ({ title: h.title, datetime: h.datetime, reason: h.analysis.reason })),
    bullishSectors,
    bearishSectors,
    analyzedAt: new Date().toISOString(),
  };

  breakingNewsCache = { ts: Date.now(), result };
  console.log(`[news/breaking] ${headlines.length} headlines, ${highImpact.length} high-impact, pauseRecommended=${marketPauseRecommended}`);
  return result;
}

// ─── GEO RISK INDEX ───────────────────────────────────────────────────────────

async function handleGeoRisk(polygonKey) {
  if (geoRiskCache && (Date.now() - geoRiskCache.ts) < GEO_RISK_CACHE_TTL) {
    console.log('[news/georisk] cache hit');
    return geoRiskCache.result;
  }

  const data = await httpsGet(
    `https://api.polygon.io/v2/reference/news?limit=100&order=desc&sort=published_utc&apiKey=${polygonKey}`
  );
  const items = data?.results ?? [];
  const headlineList = items.map(n => n.title).filter(Boolean).slice(0, 100);

  const fallback = {
    geoRiskScore:      30,
    tradeWarRisk:      20,
    conflictRisk:      20,
    centralBankRisk:   25,
    overallMarketRisk: 'low',
    keyThemes:         ['Markets operating normally'],
    recommendation:    'trade normally',
  };

  if (headlineList.length === 0) {
    geoRiskCache = { ts: Date.now(), result: fallback };
    return fallback;
  }

  const prompt = `Analyze these ${headlineList.length} recent financial news headlines and return ONLY valid JSON (no markdown, no explanation):
{
  "geoRiskScore": <0-100>,
  "tradeWarRisk": <0-100>,
  "conflictRisk": <0-100>,
  "centralBankRisk": <0-100>,
  "overallMarketRisk": "low" | "elevated" | "high" | "extreme",
  "keyThemes": ["theme1","theme2","theme3"],
  "recommendation": "trade normally" | "reduce size" | "avoid new entries" | "exit all positions"
}
Headlines: ${headlineList.join(' | ')}`;

  const parsed = await callClaude(prompt, 400);
  const result = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    ? {
        geoRiskScore:      Math.max(0, Math.min(100, Number(parsed.geoRiskScore) || 30)),
        tradeWarRisk:      Math.max(0, Math.min(100, Number(parsed.tradeWarRisk) || 20)),
        conflictRisk:      Math.max(0, Math.min(100, Number(parsed.conflictRisk) || 20)),
        centralBankRisk:   Math.max(0, Math.min(100, Number(parsed.centralBankRisk) || 25)),
        overallMarketRisk: ['low','elevated','high','extreme'].includes(parsed.overallMarketRisk) ? parsed.overallMarketRisk : 'low',
        keyThemes:         Array.isArray(parsed.keyThemes) ? parsed.keyThemes.slice(0,3).map(String) : fallback.keyThemes,
        recommendation:    ['trade normally','reduce size','avoid new entries','exit all positions'].includes(parsed.recommendation) ? parsed.recommendation : 'trade normally',
        analyzedAt:        new Date().toISOString(),
        headlineCount:     headlineList.length,
      }
    : { ...fallback, analyzedAt: new Date().toISOString(), headlineCount: headlineList.length };

  geoRiskCache = { ts: Date.now(), result };
  console.log(`[news/georisk] risk=${result.overallMarketRisk} geo=${result.geoRiskScore} recommendation="${result.recommendation}"`);
  return result;
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

  const polygonKey  = process.env.POLYGON_API_KEY;
  const finnhubKey  = process.env.FINNHUB_API_KEY;
  const type = req.query.type || 'market';

  try {
    if (type === 'breaking') {
      if (!polygonKey) return res.status(500).json({ error: 'Not configured' });
      const result = await handleBreakingNews(polygonKey, finnhubKey);
      return res.status(200).json(result);
    }

    if (type === 'georisk') {
      if (!polygonKey) return res.status(500).json({ error: 'Not configured' });
      const result = await handleGeoRisk(polygonKey);
      return res.status(200).json(result);
    }

    if (type === 'macro') {
      if (!finnhubKey) return res.status(500).json({ error: 'Not configured' });
      const result = await getHighImpactEvents(finnhubKey);
      return res.status(200).json(result);

    } else if (type === 'economic') {
      // Economic calendar still uses Finnhub — Polygon does not cover macro events
      if (!finnhubKey) return res.status(500).json({ error: 'Not configured' });
      const from = req.query.from || new Date().toISOString().split('T')[0];
      const to   = req.query.to   || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const data = await httpsGet(
        `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${to}&token=${finnhubKey}`
      );
      return res.status(200).json(data);

    } else {
      if (!polygonKey) return res.status(500).json({ error: 'Not configured' });

      // ── Symbol-specific news + sentiment ─────────────────────────────────────
      if (req.query.symbol) {
        const symbol = String(req.query.symbol).toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
        if (!symbol) return res.status(400).json({ error: 'Invalid symbol' });

        // Check sentiment cache first
        const cacheKey = `sentiment:${symbol}`;
        const cached = sentimentCache[cacheKey];
        if (cached && (Date.now() - cached.ts) < SENTIMENT_CACHE_TTL) {
          console.log(`[news] sentiment cache hit for ${symbol}`);
          return res.status(200).json({ symbol, news: cached.news, sentimentScore: cached.result, fromCache: true });
        }

        const newsData = await httpsGet(
          `https://api.polygon.io/v2/reference/news?ticker=${symbol}&limit=5&order=desc&sort=published_utc&apiKey=${polygonKey}`
        );
        const articles = (newsData.results || []).slice(0, 5);
        const headlines = articles.map(n => n.title).filter(Boolean);

        const sentiment = await scoreNewsSentiment(headlines);

        const news = articles.map(n => ({
          headline: n.title,
          summary:  n.description || '',
          url:      n.article_url,
          source:   n.publisher?.name || 'News',
          datetime: n.published_utc ? Math.floor(new Date(n.published_utc).getTime() / 1000) : 0,
          image:    n.image_url || null,
          tickers:  n.tickers || [],
        }));

        sentimentCache[cacheKey] = { ts: Date.now(), result: sentiment, news };
        console.log(`[news] sentiment ${symbol}: score=${sentiment.score} catalyst=${sentiment.catalyst}`);
        return res.status(200).json({ symbol, news, sentimentScore: sentiment });
      }

      // ── General market news — Polygon ────────────────────────────────────────
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
