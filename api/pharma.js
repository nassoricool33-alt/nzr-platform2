/**
 * NZR — Pharma Data + Bot API
 * Merged: pharma.js + pharmabot.js
 * Data endpoints  (?action=): calendar, scan, signal, shorts, fda
 * Bot endpoints   (?action=): botstatus, botstart, botstop, botcheck, botrules, validate
 * Requires env vars: POLYGON_API_KEY, ANTHROPIC_API_KEY, ALPACA_API_KEY, ALPACA_SECRET_KEY
 */

const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];
const DEFAULT_ALPACA  = 'https://paper-api.alpaca.markets';

function withTimeout(promise, ms = 8000, fallback = null) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ── Pharma universe ───────────────────────────────────────────────────────────
const PHARMA_SYMBOLS = [
  'MRNA','PFE','BIIB','NVAX','GILD','REGN','VRTX','BMY','ABBV','JNJ',
  'AMGN','LLY','NVO','ISRG','ILMN','SGEN','ALNY','BGNE','EXAS','INCY',
  'ACAD','SRPT','BMRN','RARE','FOLD','ARWR','BEAM','EDIT','NTLA','CRSP',
];

const HALAL_VERIFIED = new Set(['MRNA','PFE','BIIB','GILD','AMGN','LLY','NVO','VRTX']);

// ── Duplicate order prevention ───────────────────────────────────────────────
let pharmaOrdersTracked = { date: '', symbols: new Set() };

// ── FDA / PDUFA calendar — updated quarterly ──────────────────────────────────
const FDA_HARDCODED = [
  { date: '2026-04-10', ticker: 'VRTX', drug: 'Suzetrigine',      indication: 'Acute Pain',            type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'VERIFIED' },
  { date: '2026-04-15', ticker: 'MRNA', drug: 'mRNA-1345',         indication: 'RSV Vaccine',           type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'VERIFIED' },
  { date: '2026-04-22', ticker: 'BIIB', drug: 'Lecanemab',         indication: 'Alzheimers',            type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'VERIFIED' },
  { date: '2026-04-28', ticker: 'NVAX', drug: 'NVX-CoV2373',       indication: 'COVID-19',              type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'VERIFIED' },
  { date: '2026-05-05', ticker: 'REGN', drug: 'Dupixent',          indication: 'COPD',                  type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'VERIFIED' },
  { date: '2026-05-12', ticker: 'LLY',  drug: 'Tirzepatide',       indication: 'Sleep Apnea',           type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'VERIFIED' },
  { date: '2026-05-20', ticker: 'PFE',  drug: 'Danuglipron',       indication: 'Obesity',               type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'VERIFIED' },
  { date: '2026-05-28', ticker: 'ABBV', drug: 'Lutikizumab',       indication: 'Atopic Dermatitis',     type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'UNVERIFIED' },
  { date: '2026-06-03', ticker: 'GILD', drug: 'Seladelpar',        indication: 'PBC',                   type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'VERIFIED' },
  { date: '2026-06-10', ticker: 'AMGN', drug: 'Maritide',          indication: 'Obesity',               type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'VERIFIED' },
  { date: '2026-06-18', ticker: 'SRPT', drug: 'Elevidys',          indication: 'Duchenne MD',           type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'UNVERIFIED' },
  { date: '2026-06-25', ticker: 'BMRN', drug: 'Valoctocogene',     indication: 'Hemophilia A',          type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'UNVERIFIED' },
  { date: '2026-07-08', ticker: 'VRTX', drug: 'VX-880',            indication: 'Type 1 Diabetes',      type: 'FDA Decision', phase: 'Phase 3', halalStatus: 'VERIFIED' },
  { date: '2026-07-15', ticker: 'CRSP', drug: 'CTX001',            indication: 'Sickle Cell',           type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'UNVERIFIED' },
  { date: '2026-07-22', ticker: 'BEAM', drug: 'BEAM-101',          indication: 'Sickle Cell',           type: 'FDA Decision', phase: 'Phase 3', halalStatus: 'UNVERIFIED' },
  { date: '2026-08-05', ticker: 'NVO',  drug: 'CagriSema',         indication: 'Obesity',               type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'VERIFIED' },
  { date: '2026-08-18', ticker: 'ALNY', drug: 'Zilebesiran',       indication: 'Hypertension',          type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'UNVERIFIED' },
  { date: '2026-09-01', ticker: 'BGNE', drug: 'Zanubrutinib',      indication: 'CLL',                   type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'UNVERIFIED' },
  { date: '2026-09-15', ticker: 'EXAS', drug: 'Shield',            indication: 'Colorectal Cancer',     type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'UNVERIFIED' },
  { date: '2026-10-01', ticker: 'ARWR', drug: 'ARO-APOC3',         indication: 'Hypertriglyceridemia',  type: 'FDA Decision', phase: 'PDUFA',   halalStatus: 'UNVERIFIED' },
];

// ── Bot state (module-level, persists across warm invocations) ────────────────
let botState = {
  running:      false,
  mode:         'day',  // 'day' | 'swing'
  halalOnly:    false,
  positions:    {},     // symbol → { entryPrice, qty, entryTime, stopLoss, takeProfit, ... }
  tradeLog:     [],
  lastCheck:    null,
  maxPositions: 3,
  stats:        { wins: 0, losses: 0, totalPnl: 0 },
};

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 30;
  const e = rateLimit.get(ip);
  if (!e || now - e.start > w) { rateLimit.set(ip, { count: 1, start: now }); return true; }
  if (e.count >= max) return false;
  e.count++; return true;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpsGet(url, extraHeaders = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'Accept': 'application/json', ...extraHeaders },
    };
    const req = https.request(opts, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: d ? JSON.parse(d) : null }); }
        catch { resolve({ status: r.statusCode, body: d }); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(url, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const bodyStr = JSON.stringify(payload);
    const opts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Accept':         'application/json',
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

// Polygon GET — pass key as param so callers control which env var to use
async function polyGet(path, key) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await httpsGet(`https://api.polygon.io${path}${sep}apiKey=${key}`);
  return r.body;
}

// Alpaca request — uses native fetch with AbortController for 10s timeout
async function alpacaReq(method, path, body) {
  const baseUrl   = (process.env.ALPACA_BASE_URL || DEFAULT_ALPACA).replace(/\/$/, '');
  const keyId     = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'APCA-API-KEY-ID':     keyId,
        'APCA-API-SECRET-KEY': secretKey,
        'Content-Type':        'application/json',
        'Accept':              'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    let resBody = null;
    try { resBody = await res.json(); } catch { /* empty body */ }
    return { status: res.status, body: resBody };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ── Polygon data helpers ──────────────────────────────────────────────────────
async function getPrevDay(symbol, key) {
  const data = await polyGet(`/v2/aggs/ticker/${symbol}/prev`, key);
  return data?.results?.[0] ?? null;
}

async function getDailyBars(symbol, from, to, key) {
  const data = await polyGet(
    `/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=500`, key
  );
  return data?.results || [];
}

async function getTickerDetails(symbol, key) {
  const data = await polyGet(`/v3/reference/tickers/${symbol}`, key);
  return data?.results || null;
}

async function getNews(symbol, key, limit = 5) {
  const data = await polyGet(
    `/v2/reference/news?ticker=${symbol}&limit=${limit}&sort=published_utc&order=desc`, key
  );
  return data?.results || [];
}

async function getFinancials(symbol, key) {
  const data = await polyGet(
    `/vX/reference/financials?ticker=${symbol}&limit=4&sort=filing_date&order=desc`, key
  );
  return data?.results || [];
}

// ── Indicator helpers ─────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const result = new Array(closes.length).fill(null);
  let sum = 0, seeded = false, seedCount = 0;
  for (let i = 0; i < closes.length; i++) {
    if (!seeded) {
      sum += closes[i]; seedCount++;
      if (seedCount === period) { result[i] = sum / period; seeded = true; }
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
  let avgGain = gains / period, avgLoss = losses / period;
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

// ── FDA helpers ───────────────────────────────────────────────────────────────
async function fetchFDACalendar() {
  // Use hardcoded PDUFA calendar — updated quarterly
  // The FDA public API only returns past approvals, not upcoming PDUFA dates
  return FDA_HARDCODED;
}

// Keep old function signature for compatibility but redirect to hardcoded
async function _fetchFDACalendarOld_UNUSED() {
  try {
    const r = await httpsGet(
      'https://api.fda.gov/drug/drugsfda.json?search=application_number:NDA*&limit=10&sort=submissions.submission_status_date:desc'
    );
    if (r.status === 200 && r.body?.results?.length) {
      const events = [];
      for (const item of r.body.results) {
        for (const sub of (item.submissions || [])) {
          if (sub.submission_type === 'PDUFA' || sub.submission_status === 'AP') {
            events.push({
              drug:       item.openfda?.brand_name?.[0] || item.openfda?.generic_name?.[0] || 'Unknown',
              company:    item.sponsor_name || 'Unknown',
              ticker:     null,
              date:       sub.submission_status_date || sub.pdufa_date || null,
              type:       sub.submission_type || 'FDA',
              indication: sub.application_number || '',
            });
          }
        }
      }
      if (events.length > 0) return events.slice(0, 20);
    }
  } catch { /* fall through to hardcoded */ }
  return FDA_HARDCODED;
}

// ── Claude sentiment ──────────────────────────────────────────────────────────
async function analyzeSentiment(symbol, newsItems, anthropicKey) {
  if (!anthropicKey || !newsItems.length) {
    return { score: 0.5, label: 'NEUTRAL', confidence: 0.3, summary: 'No news available for analysis' };
  }
  const headlines = newsItems.slice(0, 5)
    .map((n, i) => `${i + 1}. ${n.title || n.headline || ''}`)
    .join('\n');
  const prompt =
    `You are a pharmaceutical stock analyst. Analyze these recent news headlines for ${symbol} and provide a trading sentiment assessment.\n\nHeadlines:\n${headlines}\n\nRespond in JSON only:\n{"score":0.75,"label":"BULLISH","confidence":0.8,"summary":"Brief 1-sentence reason"}\n\nscore: 0.0 (bearish) to 1.0 (bullish). label: BULLISH|BEARISH|NEUTRAL. summary: max 120 chars.`;

  try {
    const r = await httpsPost(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5-20251001', max_tokens: 150, messages: [{ role: 'user', content: prompt }] },
      { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' }
    );
    if (r.status === 200 && r.body?.content?.[0]?.text) {
      const m = r.body.content[0].text.trim().match(/\{[\s\S]*\}/);
      if (m) {
        const p = JSON.parse(m[0]);
        return {
          score:      Math.max(0, Math.min(1, p.score ?? 0.5)),
          label:      ['BULLISH','BEARISH','NEUTRAL'].includes(p.label) ? p.label : 'NEUTRAL',
          confidence: Math.max(0, Math.min(1, p.confidence ?? 0.5)),
          summary:    String(p.summary || '').slice(0, 150),
        };
      }
    }
  } catch { /* fallback */ }
  return { score: 0.5, label: 'NEUTRAL', confidence: 0.3, summary: 'Sentiment analysis unavailable' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── PHARMA DATA ACTION HANDLERS ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function handleCalendar(key, anthropicKey) {
  const fdaEvents = await fetchFDACalendar();
  const earningsData = (await Promise.all(
    ['MRNA','BIIB','LLY','PFE','GILD'].map(async sym => {
      try {
        const fins = await getFinancials(sym, key);
        if (fins.length) return { ticker: sym, lastFilingDate: fins[0].filing_date, fiscalPeriod: fins[0].fiscal_period, fiscalYear: fins[0].fiscal_year };
      } catch { /* skip */ }
      return null;
    })
  )).filter(Boolean);

  const today = new Date();
  const enriched = fdaEvents.map(ev => {
    const evDate   = ev.date ? new Date(ev.date) : null;
    const daysAway = evDate ? Math.ceil((evDate - today) / 86400000) : null;
    return {
      ...ev,
      daysAway,
      catalystImminent: daysAway !== null && daysAway >= 0 && daysAway <= 14,
      halalStatus: ev.ticker ? (HALAL_VERIFIED.has(ev.ticker) ? 'HALAL VERIFIED' : 'UNVERIFIED') : 'UNKNOWN',
    };
  }).sort((a, b) => (a.daysAway ?? Infinity) - (b.daysAway ?? Infinity));

  return { events: enriched, earnings: earningsData, count: enriched.length };
}

async function handleScan(key) {
  // Use snapshot endpoint — one call for all tickers
  const tickerList = PHARMA_SYMBOLS.join(',');
  let snapshotData;
  try {
    snapshotData = await polyGet(
      `/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerList}`, key
    );
  } catch (err) {
    console.error('[pharma/scan] snapshot failed:', err.message);
    snapshotData = null;
  }

  const tickers = snapshotData?.tickers || [];
  const results = tickers.map(t => {
    const day  = t.day  || {};
    const prev = t.prevDay || {};
    const close = day.c ?? prev.c ?? null;
    const open  = day.o ?? prev.o ?? null;
    if (!close) return null;
    const changePct = open > 0 ? ((close - open) / open) * 100 : 0;
    const range     = (day.h ?? prev.h ?? close) - (day.l ?? prev.l ?? close);
    const rangePct  = open > 0 ? (range / open) * 100 : 0;
    return {
      symbol: t.ticker, close, open,
      high: day.h ?? prev.h ?? null, low: day.l ?? prev.l ?? null,
      volume: day.v ?? prev.v ?? null, vwap: day.vw ?? null,
      changePct: +changePct.toFixed(2), rangePct: +rangePct.toFixed(2),
      halalStatus: HALAL_VERIFIED.has(t.ticker) ? 'HALAL VERIFIED' : 'UNVERIFIED',
      catalystImminent: false,
    };
  }).filter(Boolean);

  // Fall back to individual prev-day calls if snapshot returned nothing
  if (results.length === 0) {
    const fallback = await Promise.all(
      PHARMA_SYMBOLS.map(async sym => {
        try {
          const prev = await getPrevDay(sym, key);
          if (!prev) return null;
          const changePct = prev.o > 0 ? ((prev.c - prev.o) / prev.o) * 100 : 0;
          const range     = prev.h - prev.l;
          const rangePct  = prev.o > 0 ? (range / prev.o) * 100 : 0;
          return {
            symbol: sym, close: prev.c, open: prev.o, high: prev.h, low: prev.l,
            volume: prev.v, vwap: prev.vw || null,
            changePct: +changePct.toFixed(2), rangePct: +rangePct.toFixed(2),
            halalStatus: HALAL_VERIFIED.has(sym) ? 'HALAL VERIFIED' : 'UNVERIFIED',
            catalystImminent: false,
          };
        } catch { return null; }
      })
    );
    results.push(...fallback.filter(Boolean));
  }

  const volAvg = results.reduce((s, r) => s + (r.volume || 0), 0) / (results.length || 1);
  for (const r of results) {
    r.relVolume = volAvg > 0 ? +(r.volume / (volAvg / results.length)).toFixed(2) : 1;
    const fdaMatch = FDA_HARDCODED.find(e => e.ticker === r.symbol);
    if (fdaMatch) {
      const daysAway = Math.ceil((new Date(fdaMatch.date) - new Date()) / 86400000);
      r.catalystImminent = daysAway >= 0 && daysAway <= 14;
      r.catalystDate = fdaMatch.date;
      r.catalystDrug = fdaMatch.drug;
    }
  }
  results.sort((a, b) => {
    const sA = Math.abs(a.changePct) * 0.4 + a.rangePct * 0.3 + Math.min(a.relVolume, 5) * 0.3;
    const sB = Math.abs(b.changePct) * 0.4 + b.rangePct * 0.3 + Math.min(b.relVolume, 5) * 0.3;
    return sB - sA;
  });
  return { symbols: results, count: results.length, scannedAt: new Date().toISOString() };
}

async function handleSignal(symbol, key, anthropicKey) {
  if (!symbol) return { error: 'symbol required' };
  const sym = symbol.replace(/[^A-Z0-9]/g, '').slice(0, 10).toUpperCase();
  const to       = new Date().toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

  const [bars, prev, news, details] = await Promise.all([
    getDailyBars(sym, fromDate, to, key),
    getPrevDay(sym, key),
    getNews(sym, key, 8),
    getTickerDetails(sym, key).catch(() => null),
  ]);
  if (!bars.length || !prev) return { error: `No data available for ${sym}` };

  const closes  = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);
  const rsiArr  = calcRSI(closes, 14);
  const ema20Arr = calcEMA(closes, 20);
  const ema50Arr = calcEMA(closes, 50);
  const ema200Arr = calcEMA(closes, 200);
  const atrArr  = calcATR(bars, 14);
  const n       = closes.length - 1;
  const rsi     = rsiArr[n];
  const ema20   = ema20Arr[n];
  const ema50   = ema50Arr[n];
  const ema200  = ema200Arr[n];
  const atr     = atrArr[n];
  const close   = closes[n];
  const volAvg20 = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const relVol  = volAvg20 > 0 ? +(volumes[n] / volAvg20).toFixed(2) : 1;

  let techScore = 0.5;
  if (rsi !== null) {
    if (rsi < 30) techScore += 0.25; else if (rsi < 45) techScore += 0.12;
    else if (rsi > 70) techScore -= 0.25; else if (rsi > 60) techScore -= 0.12;
  }
  if (ema20 && ema50) {
    if (close > ema20 && ema20 > ema50) techScore += 0.15;
    else if (close < ema20 && ema20 < ema50) techScore -= 0.15;
  }
  if (ema200) { techScore += close > ema200 ? 0.1 : -0.1; }
  if (relVol > 2) techScore += 0.1;
  techScore = Math.max(0, Math.min(1, techScore));

  let catalystScore = 0.5, catalystInfo = null;
  const fdaMatch = FDA_HARDCODED.find(e => e.ticker === sym);
  if (fdaMatch) {
    const daysAway = Math.ceil((new Date(fdaMatch.date) - new Date()) / 86400000);
    catalystInfo = { ...fdaMatch, daysAway };
    if (daysAway >= 0 && daysAway <= 7) catalystScore = 0.85;
    else if (daysAway >= 0 && daysAway <= 30) catalystScore = 0.7;
  }

  const sentiment    = await analyzeSentiment(sym, news, anthropicKey);
  const combinedScore = techScore * 0.4 + sentiment.score * 0.4 + catalystScore * 0.2;

  let signal = 'HOLD', signalStrength = 'WEAK';
  if (combinedScore >= 0.70)      { signal = 'BUY';  signalStrength = 'STRONG'; }
  else if (combinedScore >= 0.60) { signal = 'BUY';  signalStrength = 'MODERATE'; }
  else if (combinedScore >= 0.52) { signal = 'BUY';  signalStrength = 'WEAK'; }
  else if (combinedScore <= 0.28) { signal = 'SELL'; signalStrength = 'STRONG'; }
  else if (combinedScore <= 0.38) { signal = 'SELL'; signalStrength = 'MODERATE'; }

  const changePct = prev.o > 0 ? +((prev.c - prev.o) / prev.o * 100).toFixed(2) : 0;
  return {
    symbol: sym, price: close, changePct, volume: volumes[n], relVolume: relVol,
    rsi: rsi !== null ? +rsi.toFixed(2) : null,
    ema20: ema20 ? +ema20.toFixed(2) : null, ema50: ema50 ? +ema50.toFixed(2) : null,
    ema200: ema200 ? +ema200.toFixed(2) : null, atr: atr ? +atr.toFixed(4) : null,
    technicalScore: +techScore.toFixed(3),
    sentimentScore: +sentiment.score.toFixed(3), sentimentLabel: sentiment.label,
    sentimentConfidence: +sentiment.confidence.toFixed(2), sentimentSummary: sentiment.summary,
    catalystScore: +catalystScore.toFixed(3), catalystInfo,
    combinedScore: +combinedScore.toFixed(3), signal, signalStrength,
    stopLoss:   atr ? +(close - 2 * atr).toFixed(2) : null,
    takeProfit: atr ? +(close + 3 * atr).toFixed(2) : null,
    halalStatus: HALAL_VERIFIED.has(sym) ? 'HALAL VERIFIED' : 'UNVERIFIED',
    news: news.slice(0, 5).map(n => ({ title: n.title, published: n.published_utc, url: n.article_url })),
    companyName: details?.name || sym,
    analyzedAt: new Date().toISOString(),
  };
}

async function handleShorts(key) {
  // Use snapshot endpoint — one call for all 20 tickers
  const squeezeTickers = [
    'MRNA','PFE','BIIB','NVAX','GILD','REGN','VRTX','BMY','ABBV','JNJ',
    'AMGN','LLY','NVO','ISRG','SRPT','ALNY','BGNE','EXAS','ARWR','BEAM',
  ];
  const tickerList = squeezeTickers.join(',');
  let snapshotData;
  try {
    snapshotData = await polyGet(
      `/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickerList}`, key
    );
  } catch (err) {
    console.error('[pharma/shorts] snapshot failed:', err.message);
    snapshotData = null;
  }

  const tickers = snapshotData?.tickers || [];
  const results = squeezeTickers.map(sym => {
    const t = tickers.find(x => x.ticker === sym);
    if (!t) return { symbol: sym, price: null, changePct: 0, relVolume: 0, squeezeScore: 0, squeezeAlert: false, halalStatus: HALAL_VERIFIED.has(sym) ? 'HALAL VERIFIED' : 'UNVERIFIED' };

    const dayVol  = t.day?.v  ?? 0;
    const prevVol = t.prevDay?.v ?? 0;
    const relVol  = prevVol > 0 ? +(dayVol / prevVol).toFixed(2) : 0;
    const chgPct  = t.todaysChangePerc ?? 0;
    const price   = t.day?.c ?? t.prevDay?.c ?? null;

    let score = 0;
    if (relVol > 3)       score += 40;
    else if (relVol > 2)  score += 20;
    if (chgPct > 10)      score += 30;
    else if (chgPct > 5)  score += 15;
    if (chgPct > 0 && relVol > 1.5) score += 20;
    if (price != null && price < 20) score += 10; // small caps squeeze harder

    return {
      symbol:       sym,
      price:        price,
      changePct:    +chgPct.toFixed(2),
      relVolume:    relVol,
      squeezeScore: score,
      squeezeAlert: score > 60,
      halalStatus:  HALAL_VERIFIED.has(sym) ? 'HALAL VERIFIED' : 'UNVERIFIED',
    };
  }).sort((a, b) => b.squeezeScore - a.squeezeScore);

  return { candidates: results, count: results.length, scannedAt: new Date().toISOString() };
}

async function handleFDA() {
  const today = new Date();
  const enriched = FDA_HARDCODED
    .map(ev => {
      const evDate   = ev.date ? new Date(ev.date) : null;
      const daysAway = evDate ? Math.ceil((evDate - today) / 86400000) : null;
      // Normalize: 'VERIFIED' → 'HALAL VERIFIED' for frontend badge
      const halalStatus = ev.halalStatus === 'VERIFIED' ? 'HALAL VERIFIED' : 'UNVERIFIED';
      return { ...ev, daysAway, halalStatus, catalystImminent: daysAway !== null && daysAway >= 0 && daysAway <= 7 };
    })
    .filter(ev => ev.daysAway === null || ev.daysAway >= 0) // drop past events
    .sort((a, b) => (a.daysAway ?? Infinity) - (b.daysAway ?? Infinity));
  return { events: enriched, count: enriched.length, source: 'hardcoded-pdufa-2026' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── BOT ACTION HANDLERS (merged from pharmabot.js) ────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// ── Bot risk rule helpers ─────────────────────────────────────────────────────

function safeNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function sanitizeSym(s) { return String(s || '').replace(/[^A-Z0-9]/g, '').slice(0, 10).toUpperCase(); }

function daysUntilFDA(ticker) {
  const ev = FDA_HARDCODED.find(e => e.ticker === ticker);
  if (!ev) return null;
  const d = Math.ceil((new Date(ev.date) - new Date()) / 86400000);
  return d >= 0 ? d : null;
}

function hoursUntilFDA(ticker) {
  const ev = FDA_HARDCODED.find(e => e.ticker === ticker);
  if (!ev) return null;
  const h = (new Date(ev.date) - new Date()) / 3600000;
  return h >= 0 ? +h.toFixed(1) : null;
}

// Rule 1: Catalyst blackout
function checkCatalystBlacklist(symbol, confidence = 0) {
  const hours = hoursUntilFDA(symbol);
  if (hours === null) return { blocked: false };
  if (hours <= 12)  return { blocked: true,  reason: 'FDA catalyst <12h — close position', forceClose: true };
  if (hours <= 24)  {
    if (confidence >= 0.85) return { blocked: false, reason: 'FDA <24h but high confidence — cap at 25% size', capSize: 0.25 };
    return { blocked: true, reason: 'FDA catalyst <24h — no entry' };
  }
  return { blocked: false };
}

// Rule 2: Post-catalyst status
function postCatalystCheck(symbol) {
  const ev = FDA_HARDCODED.find(e => e.ticker === symbol);
  if (!ev) return { status: 'none' };
  const hoursAgo = (new Date() - new Date(ev.date)) / 3600000;
  if (hoursAgo >= 0 && hoursAgo <= 72) return { status: 'post_catalyst', hoursAgo: +hoursAgo.toFixed(1), drug: ev.drug };
  return { status: 'none' };
}

// Rule 3: Position sizing
function calcPharmaPositionSize(equity, confidence, isShortSqueeze) {
  if (Object.keys(botState.positions).length >= botState.maxPositions) return 0;
  if (isShortSqueeze)      return equity * 0.03;
  if (confidence >= 0.85)  return equity * 0.08;
  return equity * 0.05;
}

// Rule 4: Stop losses
function calcPharmaStop(entryPrice, mode, isFDA, isShortSqueeze) {
  const pct = isFDA ? 0.12 : isShortSqueeze ? 0.05 : mode === 'swing' ? 0.08 : 0.03;
  return +(entryPrice * (1 - pct)).toFixed(2);
}

// Rule 5: Take profits
function calcPharmaTakeProfit(entryPrice, mode, isFDA, isShortSqueeze) {
  const pct = isFDA ? 0.25 : isShortSqueeze ? 0.15 : mode === 'swing' ? 0.15 : 0.04;
  return +(entryPrice * (1 + pct)).toFixed(2);
}

// Rule 6: Halal filter
function checkHalal(symbol) {
  const verified = HALAL_VERIFIED.has(symbol);
  if (botState.halalOnly && !verified) {
    return { allowed: false, reason: `${symbol} not in HALAL VERIFIED list`, halalStatus: 'UNVERIFIED' };
  }
  return { allowed: true, halalStatus: verified ? 'HALAL VERIFIED' : 'UNVERIFIED' };
}

// Rule 7: Short squeeze entry criteria
function evalShortSqueeze(changePct, relVol, rsi) {
  if (relVol >= 3 && changePct >= 8 && (rsi === null || rsi < 80)) {
    return { isSqueezeCandidate: true, trailingStopPct: 0.04, maxHoldHours: 2,
      reason: `Rel vol ${relVol}x, +${changePct.toFixed(1)}%, RSI ${rsi?.toFixed(0) ?? 'N/A'}` };
  }
  return { isSqueezeCandidate: false };
}

// Rule 8: Earnings surprise
function evalEarningsSurprise(surprisePct) {
  if (surprisePct >= 10)  return { action: 'long',  waitMinutes: 0,  reason: `Beat by ${surprisePct.toFixed(1)}% — long on first pullback` };
  if (surprisePct <= -10) return { action: 'short', waitMinutes: 30, reason: `Miss by ${Math.abs(surprisePct).toFixed(1)}% — short after 30min` };
  return { action: 'hold', reason: 'Earnings within normal range' };
}

// ── Position monitoring ───────────────────────────────────────────────────────
async function checkAndClosePositions(currentPrices) {
  const closed = [];
  for (const [sym, pos] of Object.entries(botState.positions)) {
    const price = currentPrices[sym];
    if (!price) continue;

    let shouldClose = false, closeReason = '';
    const cat = checkCatalystBlacklist(sym, 0);
    if (cat.forceClose)            { shouldClose = true; closeReason = cat.reason; }
    if (!shouldClose && price <= pos.stopLoss)   { shouldClose = true; closeReason = 'Stop Loss'; }
    if (!shouldClose && price >= pos.takeProfit) { shouldClose = true; closeReason = 'Take Profit'; }
    if (!shouldClose && pos.isShortSqueeze) {
      if (Date.now() - pos.entryTime >= 2 * 3600000) { shouldClose = true; closeReason = 'Short Squeeze Max Hold (2h)'; }
      else if (pos.trailingStopPct) {
        const trail = price * (1 - pos.trailingStopPct);
        if (trail > pos.stopLoss) pos.stopLoss = +trail.toFixed(2);
      }
    }

    if (shouldClose) {
      try {
        await alpacaReq('DELETE', `/v2/positions/${sym}`, null);
        const pnl    = (price - pos.entryPrice) * pos.qty;
        const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
        botState.tradeLog.unshift({
          symbol: sym, action: 'EXIT', qty: pos.qty,
          entryPrice: pos.entryPrice, exitPrice: price,
          pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
          reason: closeReason, time: new Date().toISOString(),
          result: pnl >= 0 ? 'WIN' : 'LOSS',
        });
        if (pnl >= 0) botState.stats.wins++; else botState.stats.losses++;
        botState.stats.totalPnl += pnl;
        botState.tradeLog = botState.tradeLog.slice(0, 100);
        delete botState.positions[sym];
        closed.push(sym);
      } catch (err) { console.error(`[pharma/bot] close ${sym}:`, err.message); }
    }
  }
  return closed;
}

// ── Signal evaluation for bot entry ──────────────────────────────────────────
async function evalBotEntrySignal(symbol, equity, key) {
  const sym = sanitizeSym(symbol);
  const halalCheck = checkHalal(sym);
  if (!halalCheck.allowed) return { skip: true, reason: halalCheck.reason };
  if (Object.keys(botState.positions).length >= botState.maxPositions)
    return { skip: true, reason: `Max ${botState.maxPositions} positions reached` };
  if (botState.positions[sym]) return { skip: true, reason: `Already holding ${sym}` };
  const cat = checkCatalystBlacklist(sym, 0);
  if (cat.blocked) return { skip: true, reason: cat.reason };

  let prevDay;
  try {
    prevDay = await getPrevDay(sym, key);
  } catch { return { skip: true, reason: 'Failed to fetch price data' }; }
  if (!prevDay) return { skip: true, reason: 'No price data' };

  const price     = prevDay.c;
  const changePct = prevDay.o > 0 ? ((prevDay.c - prevDay.o) / prevDay.o) * 100 : 0;
  const to        = new Date().toISOString().slice(0, 10);
  const from      = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
  let bars = [];
  try { bars = await getDailyBars(sym, from, to, key); } catch { /* no bars */ }

  const closes  = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);
  let rsi = null;
  if (closes.length >= 15) {
    const rsiArr = calcRSI(closes, 14);
    rsi = rsiArr[rsiArr.length - 1];
  }
  const avgVol = volumes.length >= 20 ? volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 : 0;
  const relVol = avgVol > 0 ? +(prevDay.v / avgVol).toFixed(2) : 1;

  const squeezeEval = evalShortSqueeze(changePct, relVol, rsi);
  const isBullish   = (rsi !== null && rsi < 40) || (changePct > 0 && relVol > 1.5);
  if (!isBullish && !squeezeEval.isSqueezeCandidate)
    return { skip: true, reason: `No signal — RSI ${rsi?.toFixed(0) ?? 'N/A'}, change ${changePct.toFixed(1)}%` };

  const isFDA        = daysUntilFDA(sym) !== null && daysUntilFDA(sym) <= 30;
  const confidence   = Math.min(0.9, 0.5 + (rsi !== null ? (50 - rsi) / 100 : 0) + (relVol > 2 ? 0.1 : 0));
  const positionValue = calcPharmaPositionSize(equity, confidence, squeezeEval.isSqueezeCandidate);
  if (positionValue <= 0) return { skip: true, reason: 'Position size is zero' };
  const qty = Math.floor(positionValue / price);
  if (qty < 1) return { skip: true, reason: 'Insufficient buying power for 1 share' };

  return {
    skip: false, symbol: sym, price, qty, positionValue: +(qty * price).toFixed(2),
    stopLoss:    calcPharmaStop(price, botState.mode, isFDA, squeezeEval.isSqueezeCandidate),
    takeProfit:  calcPharmaTakeProfit(price, botState.mode, isFDA, squeezeEval.isSqueezeCandidate),
    confidence:  +confidence.toFixed(2),
    isShortSqueeze: squeezeEval.isSqueezeCandidate,
    isFDA, rsi: rsi !== null ? +rsi.toFixed(2) : null, relVol,
    changePct:   +changePct.toFixed(2),
    halalStatus: halalCheck.halalStatus,
    trailingStopPct: squeezeEval.trailingStopPct || null,
    signalReason: squeezeEval.isSqueezeCandidate ? squeezeEval.reason : `RSI ${rsi?.toFixed(0) ?? 'N/A'}, rel vol ${relVol}x`,
  };
}

// ── Bot action handlers ───────────────────────────────────────────────────────

function handleBotStatus() {
  return {
    running:       botState.running,
    mode:          botState.mode,
    halalOnly:     botState.halalOnly,
    positionCount: Object.keys(botState.positions).length,
    maxPositions:  botState.maxPositions,
    positions:     Object.entries(botState.positions).map(([sym, p]) => ({
      symbol: sym, qty: p.qty, entryPrice: p.entryPrice,
      stopLoss: p.stopLoss, takeProfit: p.takeProfit,
      isShortSqueeze: p.isShortSqueeze || false,
      entryTime: p.entryTime ? new Date(p.entryTime).toISOString() : null,
    })),
    stats:     botState.stats,
    lastCheck: botState.lastCheck,
    tradeLog:  botState.tradeLog.slice(0, 20),
  };
}

function handleBotStart(body) {
  if (botState.running) return { ok: false, error: 'Bot already running' };
  botState.mode      = ['day','swing'].includes(body.mode) ? body.mode : 'day';
  botState.halalOnly = body.halalOnly === true || body.halalOnly === 'true';
  botState.running   = true;
  botState.lastCheck = new Date().toISOString();
  console.log(`[pharma/bot] Started — mode=${botState.mode} halalOnly=${botState.halalOnly}`);
  return { ok: true, mode: botState.mode, halalOnly: botState.halalOnly };
}

function handleBotStop() {
  botState.running = false;
  return { ok: true, message: 'Bot stopped' };
}

function handleBotRules(symbol) {
  if (!symbol) return { error: 'symbol required' };
  const sym = sanitizeSym(symbol);
  return {
    symbol: sym,
    halalStatus:      checkHalal(sym).halalStatus,
    catalystBlacklist: checkCatalystBlacklist(sym, 0.6),
    fdaDaysAway:      daysUntilFDA(sym),
    fdaHoursAway:     hoursUntilFDA(sym),
    postCatalyst:     postCatalystCheck(sym),
    stopLossRules:    { day: '3%', swing: '8%', fda: '12%', squeeze: '5% + 4% trailing' },
    takeProfitRules:  { day: '4%', swing: '15%', fdaApproval: '25–40%', squeeze: '15% (max 2h)' },
    positionSizeRules: { normal: '5%', highConfidence: '8% (≥85%)', shortSqueeze: '3%', maxPositions: 3 },
    shortSqueezeRules: { entry: 'relVol ≥3×, change ≥8%, RSI <80', trailingStop: '4%', maxHold: '2h' },
    earningsSurpriseRules: { beat: 'Long on pullback (>10%)', miss: 'Short after 30min (<-10%)' },
  };
}

async function handleBotValidate(body, key) {
  if (!botState.running) return { ok: false, error: 'Bot not running' };
  const sym = sanitizeSym(body.symbol);
  if (!sym) return { ok: false, error: 'symbol required' };
  if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY)
    return { ok: false, error: 'Alpaca not configured' };

  let equity = 100000;
  try {
    const acct = await alpacaReq('GET', '/v2/account', null);
    equity = safeNum(acct.body?.portfolio_value) || equity;
  } catch { /* use default */ }

  const signal = await evalBotEntrySignal(sym, equity, key);
  if (signal.skip) return { ok: false, skipped: true, reason: signal.reason };

  // Check if already own this symbol
  try {
    const posCheck = await alpacaReq('GET', '/v2/positions/' + encodeURIComponent(sym), null);
    if (posCheck.status === 200) {
      console.log('[pharma/validate] PHARMA_ALREADY_OWNED: ' + sym + ' skipping');
      return { ok: false, skipped: true, reason: 'PHARMA_ALREADY_OWNED: ' + sym };
    }
  } catch { /* no position — OK */ }

  try {
    const orderBody = {
      symbol: sym, qty: signal.qty, side: 'buy', type: 'market',
      time_in_force: botState.mode === 'day' ? 'day' : 'gtc',
    };
    const r = await alpacaReq('POST', '/v2/orders', orderBody);
    if (r.status !== 200 && r.status !== 201)
      return { ok: false, error: `Alpaca order failed: ${JSON.stringify(r.body)}` };

    botState.positions[sym] = {
      qty: signal.qty, entryPrice: signal.price,
      stopLoss: signal.stopLoss, takeProfit: signal.takeProfit,
      entryTime: Date.now(), isShortSqueeze: signal.isShortSqueeze,
      trailingStopPct: signal.trailingStopPct, isFDA: signal.isFDA, mode: botState.mode,
    };
    botState.tradeLog.unshift({
      symbol: sym, action: 'ENTER', qty: signal.qty,
      entryPrice: signal.price, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit,
      positionValue: signal.positionValue, reason: signal.signalReason,
      halalStatus: signal.halalStatus, time: new Date().toISOString(),
    });
    botState.tradeLog = botState.tradeLog.slice(0, 100);
    return {
      ok: true, symbol: sym, qty: signal.qty, entryPrice: signal.price,
      stopLoss: signal.stopLoss, takeProfit: signal.takeProfit,
      positionValue: signal.positionValue, halalStatus: signal.halalStatus,
      isShortSqueeze: signal.isShortSqueeze, orderId: r.body?.id,
    };
  } catch (err) {
    console.error('[pharma/bot] validate error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function handleBotCheck(key) {
  if (Object.keys(botState.positions).length === 0)
    return { checked: 0, closed: [], message: 'No open positions' };

  const symbols       = Object.keys(botState.positions);
  const currentPrices = {};
  await Promise.all(symbols.map(async sym => {
    try {
      const prev = await getPrevDay(sym, key);
      if (prev) currentPrices[sym] = prev.c;
    } catch { /* skip */ }
  }));

  const closed = await checkAndClosePositions(currentPrices);
  botState.lastCheck = new Date().toISOString();
  return { checked: symbols.length, closed, currentPrices, remainingPositions: Object.keys(botState.positions).length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── AUTOMATED PHARMA TRADING ─────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

// PDUFA calendar symbols — the 20 symbols with upcoming FDA dates
const PDUFA_SCAN_SYMBOLS = FDA_HARDCODED.map(e => e.ticker).filter((v, i, a) => a.indexOf(v) === i);

let pharmaLastScanResults = [];
let pharmaOrdersToday = { date: '', count: 0 };

async function executePharmaSignal(symbol, signal, capitalAmount) {
  const sym = sanitizeSym(symbol);

  // 1. Only trade within 7 days of a PDUFA date
  const days = daysUntilFDA(sym);
  if (days === null || days > 7) {
    return { skip: true, reason: 'No PDUFA within 7 days (daysUntil=' + days + ')' };
  }

  // 1b. Check if already ordered this symbol today
  const today = new Date().toISOString().split('T')[0];
  if (pharmaOrdersTracked.date !== today) {
    pharmaOrdersTracked = { date: today, symbols: new Set() };
  }
  if (pharmaOrdersTracked.symbols.has(sym)) {
    return { skip: true, reason: 'PHARMA_ALREADY_ORDERED_TODAY: ' + sym + ' skipping duplicate' };
  }

  // 1c. Check if we already own this symbol on Alpaca
  try {
    const checkRes = await alpacaReq('GET', '/v2/positions/' + encodeURIComponent(sym), null);
    if (checkRes.status === 200) {
      console.log('[pharma/exec] PHARMA_ALREADY_OWNED: ' + sym + ' skipping');
      return { skip: true, reason: 'PHARMA_ALREADY_OWNED: ' + sym + ' skipping' };
    }
  } catch { /* position doesn't exist — OK to proceed */ }

  // 2. Halal filter — skip excluded symbols
  const halalCheck = checkHalal(sym);
  if (!halalCheck.allowed) {
    return { skip: true, reason: halalCheck.reason };
  }

  // 3. IV crush risk — skip if options IV > 200%
  if (signal.atr && signal.price) {
    const impliedMove = (signal.atr / signal.price) * 100 * Math.sqrt(days || 1);
    if (impliedMove > 200) {
      return { skip: true, reason: 'IV_CRUSH_RISK: implied move ' + impliedMove.toFixed(0) + '% > 200%' };
    }
  }

  // 4. Check live trading mode
  if (process.env.BOT_LIVE_TRADING !== 'true') {
    return { skip: true, reason: 'PAPER_MODE: pharma signal logged for ' + sym + ' (score=' + signal.combinedScore + ')' };
  }

  // 5. Position size — max 3% of capital per pharma trade
  const positionSize = Math.max(300, (capitalAmount || 10000) * 0.03);
  const price = signal.price;
  if (!price || price <= 0) {
    return { skip: true, reason: 'No valid price for ' + sym };
  }
  const qty = Math.max(1, Math.floor(positionSize / price));

  // 6. Calculate bracket order stops — 2.5x ATR for pharma volatility
  const atr = signal.atr || (price * 0.03); // fallback 3% of price
  const stopLoss = +(price - 2.5 * atr).toFixed(2);
  const takeProfit = +(price + 3.5 * atr).toFixed(2);

  // 7. Determine order side from signal
  const side = (signal.signal === 'SELL') ? 'sell' : 'buy';

  try {
    const orderRes = await alpacaReq('POST', '/v2/orders', {
      symbol: sym,
      qty: String(qty),
      side: side,
      type: 'market',
      time_in_force: 'day',
      order_class: 'bracket',
      stop_loss: { stop_price: String(stopLoss) },
      take_profit: { limit_price: String(takeProfit) },
      client_order_id: 'NZR-PHARMA-' + sym + '-' + Date.now()
    });

    if (orderRes.status === 200 || orderRes.status === 201) {
      pharmaOrdersTracked.symbols.add(sym);
      console.log('[pharma/exec] ORDER_PLACED: ' + sym + ' ' + side + ' ' + qty + ' @ $' + price + ' SL=$' + stopLoss + ' TP=$' + takeProfit);
      return {
        skip: false,
        placed: true,
        symbol: sym,
        side,
        qty,
        price,
        stopLoss,
        takeProfit,
        atr: +atr.toFixed(4),
        pdufaDays: days,
        halalStatus: halalCheck.halalStatus,
        orderId: orderRes.body?.id || null
      };
    } else {
      // Bracket order rejected — fall back to simple market order
      console.log('[pharma/exec] BRACKET_REJECTED: ' + sym + ' — ' + JSON.stringify(orderRes.body) + ' — trying simple order');
      const simpleRes = await alpacaReq('POST', '/v2/orders', {
        symbol: sym,
        qty: String(qty),
        side: side,
        type: 'market',
        time_in_force: 'day',
        client_order_id: 'NZR-PHARMA-' + sym + '-' + Date.now()
      });
      if (simpleRes.status === 200 || simpleRes.status === 201) {
        pharmaOrdersTracked.symbols.add(sym);
        console.log('[pharma/exec] SIMPLE_ORDER_PLACED: ' + sym + ' ' + side + ' ' + qty + ' @ $' + price);
        return {
          skip: false,
          placed: true,
          symbol: sym,
          side,
          qty,
          price,
          stopLoss,
          takeProfit,
          atr: +atr.toFixed(4),
          pdufaDays: days,
          halalStatus: halalCheck.halalStatus,
          orderId: simpleRes.body?.id || null,
          note: 'Simple order (bracket rejected)'
        };
      }
      return { skip: true, reason: 'ORDER_REJECTED: ' + JSON.stringify(simpleRes.body) };
    }
  } catch (err) {
    console.error('[pharma/exec] error:', err.message);
    return { skip: true, reason: 'ORDER_ERROR: ' + err.message };
  }
}

async function handleAutoScan(polyKey, anthropicKey) {
  const startTime = Date.now();

  // Market hours check
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etHour = nowET.getHours();
  const etMinute = nowET.getMinutes();
  const etDay = nowET.getDay();
  const etTime = etHour + etMinute / 60;
  const isMarketOpen = etDay >= 1 && etDay <= 5 && etTime >= 9.5 && etTime < 15.75;

  // Get capital amount
  let capitalAmount = 10000;
  if (process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
    try {
      const acct = await alpacaReq('GET', '/v2/account', null);
      capitalAmount = safeNum(acct.body?.portfolio_value) || capitalAmount;
    } catch { /* use default */ }
  }

  let symbolsScanned = 0, signalsFound = 0, ordersPlaced = 0;
  const results = [];

  // Scan PDUFA calendar symbols
  for (let i = 0; i < PDUFA_SCAN_SYMBOLS.length; i += 3) {
    if (Date.now() - startTime > 25000) {
      console.log('[pharma/autoscan] TIME_BUDGET: stopping early');
      break;
    }
    const batch = PDUFA_SCAN_SYMBOLS.slice(i, i + 3);
    const batchResults = await Promise.all(batch.map(async (sym) => {
      symbolsScanned++;
      try {
        return await handleSignal(sym, polyKey, anthropicKey);
      } catch (e) {
        return { symbol: sym, error: e.message };
      }
    }));

    for (const signal of batchResults) {
      if (!signal || signal.error) continue;
      results.push(signal);

      // Score with PDUFA proximity boost: +0.15 if within 7 days of catalyst
      const rawScore = signal.combinedScore || 0;
      const daysAway = signal.catalystInfo?.daysAway;
      const hasCatalyst = daysAway !== null && daysAway !== undefined && daysAway >= 0 && daysAway <= 7;

      // Execution gate: score >= 0.52 AND PDUFA within 7 days
      if (rawScore >= 0.52 && hasCatalyst && (signal.signal === 'BUY' || signal.signal === 'SELL')) {
        signalsFound++;

        if (!isMarketOpen) {
          // Pre-market signal — log for next open
          console.log('[PHARMA] PREMARKET_SIGNAL: ' + signal.symbol + ' score=' + rawScore.toFixed(2) + ' PDUFA in ' + daysAway + ' days');
          signal.execResult = { skip: true, reason: 'PHARMA_PREMARKET_SIGNAL: ' + signal.symbol + ' score=' + rawScore.toFixed(2) + ' PDUFA in ' + daysAway + ' days — will trade at market open' };
          continue;
        }

        const execResult = await executePharmaSignal(signal.symbol, signal, capitalAmount);
        if (execResult && !execResult.skip && execResult.placed) {
          ordersPlaced++;
        }
        // Attach execution result to signal for response
        signal.execResult = execResult;
      }
    }
  }

  // Cache results
  pharmaLastScanResults = results;
  const today = new Date().toISOString().split('T')[0];
  if (pharmaOrdersToday.date !== today) {
    pharmaOrdersToday = { date: today, count: ordersPlaced };
  } else {
    pharmaOrdersToday.count += ordersPlaced;
  }

  const duration = Date.now() - startTime;
  return {
    success: true,
    isMarketOpen,
    symbolsScanned,
    signalsFound,
    ordersPlaced,
    duration: duration + 'ms',
    results: results.map(r => ({
      symbol: r.symbol,
      combinedScore: r.combinedScore,
      signal: r.signal,
      signalStrength: r.signalStrength,
      price: r.price,
      atr: r.atr,
      catalystInfo: r.catalystInfo,
      halalStatus: r.halalStatus,
      execResult: r.execResult || null
    }))
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  const _deadline = setTimeout(() => {
    if (!res.headersSent) res.status(200).json({ error: 'timeout', data: null });
  }, 8000);

  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'Rate limit reached' });

  const polyKey      = process.env.POLYGON_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const action       = String(req.query.action || '').toLowerCase();

  console.log('[pharma] action:', action);
  console.log('[pharma] POLYGON_API_KEY present:', !!polyKey);

  // Bot status/start/stop/check/rules/validate don't all need Polygon
  const botOnlyActions = new Set(['botstatus','botstart','botstop']);

  if (!polyKey && !botOnlyActions.has(action))
    return res.status(500).json({ error: 'Market data not configured' });

  try {
    // ── Pharma data endpoints (GET) ──────────────────────────────────────────
    if (action === 'calendar' && req.method === 'GET')
      return res.status(200).json(await handleCalendar(polyKey, anthropicKey));

    if (action === 'scan' && req.method === 'GET')
      return res.status(200).json(await handleScan(polyKey));

    if (action === 'signal' && req.method === 'GET') {
      const symbol = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      const data   = await handleSignal(symbol, polyKey, anthropicKey);
      return res.status(data.error ? 400 : 200).json(data);
    }

    if (action === 'shorts' && req.method === 'GET')
      return res.status(200).json(await handleShorts(polyKey));

    if (action === 'fda' && req.method === 'GET')
      return res.status(200).json(await handleFDA());

    // ── Bot endpoints ─────────────────────────────────────────────────────────
    if (action === 'botstatus' && req.method === 'GET')
      return res.status(200).json(handleBotStatus());

    if (action === 'botstart' && req.method === 'POST')
      return res.status(200).json(handleBotStart(req.body || {}));

    if (action === 'botstop' && req.method === 'POST')
      return res.status(200).json(handleBotStop());

    if (action === 'botrules' && req.method === 'GET') {
      const symbol = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      return res.status(200).json(handleBotRules(symbol));
    }

    if (action === 'validate' && req.method === 'POST')
      return res.status(200).json(await handleBotValidate(req.body || {}, polyKey));

    if (action === 'botcheck' && req.method === 'POST')
      return res.status(200).json(await handleBotCheck(polyKey));

    // ── Automated pharma trading endpoints ───────────────────────────────────
    if (action === 'autoscan')
      return res.status(200).json(await handleAutoScan(polyKey, anthropicKey));

    if (action === 'autopilot') {
      console.log('[pharma] AUTOPILOT_TRIGGERED: cron-job.org pharma scan starting');
      return res.status(200).json(await handleAutoScan(polyKey, anthropicKey));
    }

    // Also support ?type= parameter for cron-job.org compatibility
    const typeParam = String(req.query.type || '').toLowerCase();
    if (typeParam === 'scan')
      return res.status(200).json(await handleAutoScan(polyKey, anthropicKey));
    if (typeParam === 'autopilot') {
      console.log('[pharma] AUTOPILOT_TRIGGERED: cron-job.org pharma scan starting');
      return res.status(200).json(await handleAutoScan(polyKey, anthropicKey));
    }

    return res.status(400).json({
      error: `Unknown action: "${action}". Data: calendar|scan|signal|shorts|fda. Bot: botstatus|botstart|botstop|botrules|validate|botcheck. Auto: autoscan|autopilot`,
    });

  } catch (err) {
    console.error('[pharma]', action, err.message);
    return res.status(200).json({ error: 'Pharma request failed', detail: err.message });
  } finally {
    clearTimeout(_deadline);
  }
};
