const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

const HIGH_IMPACT_KEYWORDS = ['FOMC', 'Federal Reserve', 'CPI', 'Non-Farm', 'NFP', 'GDP', 'PCE', 'Unemployment', 'Interest Rate Decision', 'Jackson Hole'];

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

  const polygonKey  = process.env.POLYGON_API_KEY;
  const finnhubKey  = process.env.FINNHUB_API_KEY;
  const type = req.query.type || 'market';

  try {
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
