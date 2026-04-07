/**
 * NZR Trading Bot — Dual-Mode Risk Management Engine
 * Supports Day Trading (intraday, 15-min) and Swing Trading (4H/daily, up to 30 days).
 * Capital is split: 40% day / 60% swing. All risk limits derived from capital.
 *
 * NOTE: Vercel serverless functions are stateless between cold starts.
 * State (killSwitch, counters, capital) persists within a warm instance only.
 * For production use, persist state to a database (Supabase, Redis, etc.).
 */

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

// ─── SECTOR MAP ───────────────────────────────────────────────────────────────
// Maps individual symbols to their SPDR sector ETF. Used by the correlation
// guard to prevent over-concentration in correlated positions.
const sectorMap = {
  // XLK — Technology
  AAPL:'XLK', MSFT:'XLK', NVDA:'XLK', AMD:'XLK', TSLA:'XLK',
  META:'XLK', GOOGL:'XLK', AMZN:'XLK', CRM:'XLK', ORCL:'XLK',
  INTC:'XLK', QCOM:'XLK', AVGO:'XLK', MU:'XLK', SMCI:'XLK',
  // XLF — Financials
  JPM:'XLF', BAC:'XLF', GS:'XLF', MS:'XLF', WFC:'XLF',
  C:'XLF', BLK:'XLF', AXP:'XLF', V:'XLF', MA:'XLF',
  // XLV — Health Care
  JNJ:'XLV', UNH:'XLV', PFE:'XLV', ABBV:'XLV', MRK:'XLV',
  LLY:'XLV', BMY:'XLV', AMGN:'XLV', GILD:'XLV',
  // XLE — Energy
  XOM:'XLE', CVX:'XLE', COP:'XLE', SLB:'XLE', OXY:'XLE', MPC:'XLE', PSX:'XLE',
  // XLI — Industrials
  BA:'XLI', CAT:'XLI', GE:'XLI', HON:'XLI', UPS:'XLI', FDX:'XLI', RTX:'XLI', LMT:'XLI',
  // XLB — Materials
  // XLU — Utilities
  // XLRE — Real Estate
  // XLP — Consumer Staples
  // XLY — Consumer Discretionary
  NKE:'XLY', SBUX:'XLY', MCD:'XLY', TGT:'XLY', HD:'XLY', LOW:'XLY', F:'XLY', GM:'XLY',
  // XLC — Communication Services
};

// ─── MODULE-LEVEL STATE ──────────────────────────────────────────────────────

let killSwitch    = false;
let capitalAmount = null;   // Must be set via setcapital before trading

// Day trading bucket (40% of capital)
const dayState = {
  allocation:      0,
  maxPositionSize: 0,   // 10% of day allocation
  maxExposure:     0,   // 80% of day allocation
  maxDailyLoss:    0,   // -2% of total capital
  maxTradesDay:    15,
  stopLossPct:     0.015,  // 1.5%
  minRR:           2,
  cooldownMin:     5,
  trades:          0,
  pnl:             0,
  date:            '',     // ET date — reset daily
  active:          true,
};

// Swing trading bucket (60% of capital)
const swingState = {
  allocation:      0,
  maxPositionSize: 0,   // 15% of swing allocation
  maxExposure:     0,   // 70% of swing allocation
  maxWeeklyLoss:   0,   // -3% of total capital
  maxTradesWeek:   8,
  stopLossPct:     0.05,   // 5%
  minRR:           3,
  cooldownHours:   4,
  trades:          0,
  pnl:             0,
  weekStart:       '',   // Monday date (ET)
  active:          true,
};

// Per-symbol cooldown tracking: symbol → { timestamp, mode }
const recentOrders = new Map();

// ─── MULTI-TIMEFRAME TREND CACHE ─────────────────────────────────────────────
// Keyed as "daily:SYMBOL" or "weekly:SYMBOL" → { ts, bullish, bearish, ... }
const trendCache = {};
const TREND_CACHE_TTL = 60 * 60 * 1000; // 60 minutes

// ─── VOLUME AVERAGE CACHE ────────────────────────────────────────────────────
// Keyed as "vol:day:SYMBOL" or "vol:swing:SYMBOL" → { ts, avgVolume }
const volumeCache = {};
const VOLUME_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// ─── VWAP CACHE ──────────────────────────────────────────────────────────────
// Keyed as "vwap:SYMBOL" → { ts, vwap, currentPrice, aboveVwap }
const vwapCache = {};
const VWAP_CACHE_TTL = 3 * 60 * 1000; // 3 minutes

// Minimum adjusted confidence required to enter a day trade.
// Lunch penalty (-10) will drop a borderline signal (70) below this floor.
const ENTRY_CONFIDENCE_THRESHOLD = 70;

// ─── SENTIMENT CACHE (bot) ───────────────────────────────────────────────────
// Keyed as "sent:SYMBOL" → { ts, result: { score, catalyst, summary } }
const sentimentBotCache = {};
const SENTIMENT_BOT_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// ─── SUPPORT & RESISTANCE CACHE ──────────────────────────────────────────────
// Keyed as "sr:SYMBOL" → { ts, result: { resistance, support } }
const srBotCache = {};
const SR_BOT_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

// ─── OPTIONS FLOW CACHE ───────────────────────────────────────────────────────
// Keyed as "flow:SYMBOL" → { ts, score, signal, volumeRatio, oiRatio, smartMoney }
const optionsFlowBotCache = {};
const OPTIONS_FLOW_BOT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ─── MARKET REGIME CACHE ─────────────────────────────────────────────────────
// { ts, result: { adx, plusDI, minusDI, vix, regime } }
let regimeBotCache = null;
const REGIME_BOT_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ─── ADAPTIVE SIZING CACHE ───────────────────────────────────────────────────
// Stores the last computed Kelly stats so Supabase isn't queried every request.
// { ts, winRate, avgWin, avgLoss, kellyFraction, tradeCount }
let adaptiveSizingStats = null;
const ADAPTIVE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// ─── RELATIVE STRENGTH CACHE ─────────────────────────────────────────────────
// Keyed as "rs:day:SYMBOL" or "rs:swing:SYMBOL" → { ts, rs, symbolChange, spyChange }
const rsCache = {};
const RS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ─── ATR CACHE ───────────────────────────────────────────────────────────────
// Keyed as "atr:day:SYMBOL" or "atr:swing:SYMBOL" → { ts, atr }
const atrCache = {};
const ATR_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ─── TRAILING STOP TRACKER ───────────────────────────────────────────────────
// Keyed as "mode:symbol" → { stage, direction, entryPrice, atr, stopPrice,
//   target1, target2, highestPrice, lowestPrice, updatedAt }
// stage 1 = initial ATR stop, 2 = breakeven, 3 = trailing
const trailingStops = new Map();

// Rate limiting
const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 30;
  const e = rateLimit.get(ip);
  if (!e || now - e.start > w) { rateLimit.set(ip, { count: 1, start: now }); return true; }
  if (e.count >= max) return false;
  e.count++;
  return true;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function safeNum(v, fallback = null) {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

function sanitizeSymbol(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
}

/** Approximate DST check for New York (2nd Sun March – 1st Sun November) */
function isNYDST(d) {
  const y = d.getUTCFullYear();
  const mar2nd = new Date(Date.UTC(y, 2, 1));
  const marOff = 8 + (7 - mar2nd.getUTCDay()) % 7; // 2nd Sunday
  const dstStart = new Date(Date.UTC(y, 2, marOff, 7)); // 2am ET = 7am UTC
  const nov1st = new Date(Date.UTC(y, 10, 1));
  const novOff = (7 - nov1st.getUTCDay()) % 7;        // 1st Sunday
  const dstEnd  = new Date(Date.UTC(y, 10, 1 + novOff, 6)); // 2am ET = 6am UTC
  return d >= dstStart && d < dstEnd;
}

function toETDate(d = new Date()) {
  const offset = isNYDST(d) ? 4 : 5;
  const et = new Date(d.getTime() - offset * 3600000);
  return et.toISOString().slice(0, 10);
}

function getETMinuteOfDay(d = new Date()) {
  const offset = isNYDST(d) ? 4 : 5;
  const et = new Date(d.getTime() - offset * 3600000);
  return et.getUTCHours() * 60 + et.getUTCMinutes();
}

function getMondayET(d = new Date()) {
  const offset = isNYDST(d) ? 4 : 5;
  const et = new Date(d.getTime() - offset * 3600000);
  const day = et.getUTCDay();                        // 0=Sun … 6=Sat
  const diff = day === 0 ? -6 : 1 - day;            // shift to Monday
  et.setUTCDate(et.getUTCDate() + diff);
  return et.toISOString().slice(0, 10);
}

/**
 * Returns the current wall-clock time in US/Eastern as a plain Date object
 * whose UTC fields read as if they were ET local fields.
 * (Re-uses the DST logic already established by isNYDST.)
 */
function getEasternTime(d = new Date()) {
  const offset = isNYDST(d) ? 4 : 5;
  return new Date(d.getTime() - offset * 3600 * 1000);
}

/**
 * Returns the current US Eastern session quality zone for day trade filtering.
 *
 *  "avoid" — 9:30–10:00 AM ET  opening shakeout; block all new entries
 *  "prime" — 10:00–11:30 AM ET best momentum window; +10 confidence bonus
 *  "lunch" — 11:30 AM–1:30 PM ET low-volume chop; −10 confidence penalty
 *  "prime" — 1:30–3:30 PM ET  afternoon trend window; +10 confidence bonus
 *  "close" — 3:30–4:00 PM ET  closing volatility; block all new entries
 *  "closed"— outside market hours
 */
function getSessionQuality() {
  const min = getETMinuteOfDay();
  if (min <  9 * 60 + 30) return 'closed';  // before open
  if (min < 10 * 60)      return 'avoid';   // 9:30–10:00
  if (min < 11 * 60 + 30) return 'prime';   // 10:00–11:30
  if (min < 13 * 60 + 30) return 'lunch';   // 11:30–13:30
  if (min < 15 * 60 + 30) return 'prime';   // 13:30–15:30
  if (min < 16 * 60)      return 'close';   // 15:30–16:00
  return 'closed';
}

/**
 * Checks whether adding a new position in `symbol` would create too much
 * sector concentration among `openPositions`.
 *
 * Rules:
 *  - Symbol not in sectorMap → allowed: true, reason: "unmapped"
 *  - 0 existing sector positions → allowed: true, sectorCount: 0
 *  - 1 existing sector position  → allowed: true, sectorCount: 1 (caller reduces size 40%)
 *  - 2+ existing sector positions → allowed: false (trade blocked)
 *
 * Each element of openPositions should have a `symbol` or `ticker` field.
 */
function checkCorrelationGuard(symbol, openPositions) {
  const sector = sectorMap[symbol];
  if (!sector) return { allowed: true, sectorCount: 0, sector: 'unmapped', reason: 'unmapped' };

  const sectorCount = openPositions.filter(p => {
    const s = sanitizeSymbol(p?.symbol ?? p?.ticker ?? '');
    return s !== symbol && sectorMap[s] === sector;
  }).length;

  return { allowed: sectorCount < 2, sectorCount, sector };
}

/** Recalculate all allocation-derived limits whenever capital changes */
function computeAllocations() {
  if (!capitalAmount || capitalAmount <= 0) return;
  dayState.allocation      = capitalAmount * 0.40;
  dayState.maxPositionSize = dayState.allocation * 0.10;
  dayState.maxExposure     = dayState.allocation * 0.80;
  dayState.maxDailyLoss    = -(capitalAmount * 0.02);

  swingState.allocation      = capitalAmount * 0.60;
  swingState.maxPositionSize = swingState.allocation * 0.15;
  swingState.maxExposure     = swingState.allocation * 0.70;
  swingState.maxWeeklyLoss   = -(capitalAmount * 0.03);
}

/** Reset day counters when ET date changes */
function resetDayIfNeeded() {
  const today = toETDate();
  if (today !== dayState.date) {
    dayState.trades = 0;
    dayState.pnl    = 0;
    dayState.date   = today;
  }
}

/** Reset swing weekly counters when ET Monday changes */
function resetSwingIfNeeded() {
  const monday = getMondayET();
  if (monday !== swingState.weekStart) {
    swingState.trades    = 0;
    swingState.pnl       = 0;
    swingState.weekStart = monday;
  }
}

function roundLimitPrice(price) {
  if (price == null) return null;
  return price > 100
    ? Math.round(price / 0.05) * 0.05
    : Math.round(price * 100) / 100;
}

function calcLimitPrice(lastPrice, direction, slippagePct = 0.001) {
  if (lastPrice == null) return null;
  const raw = direction === 'LONG'
    ? lastPrice * (1 + slippagePct)
    : lastPrice * (1 - slippagePct);
  return roundLimitPrice(raw);
}

function checkCooldown(symbol, mode, cooldownMs) {
  const key = `${mode}:${symbol}`;
  const e = recentOrders.get(key);
  if (!e) return { ok: true };
  const elapsed = Date.now() - e.timestamp;
  if (elapsed < cooldownMs) return { ok: false, remaining: Math.ceil((cooldownMs - elapsed) / 1000) };
  return { ok: true };
}

// ─── EMA CALCULATION ─────────────────────────────────────────────────────────

/**
 * Standard exponential moving average from an ascending array of close prices.
 * Uses SMA of the first `period` values as the seed (same as Polygon's EMA endpoint).
 * Returns null when there are fewer data points than the period.
 */
function calcEMA(closes, period) {
  if (!closes || closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

// ─── ATR CALCULATION ─────────────────────────────────────────────────────────

/**
 * Wilder's ATR over `period` bars (default 14).
 * `bars` must be ascending (oldest first), each with { h, l, c } fields.
 * Requires at least period+1 bars (need prevClose for the first TR).
 * Returns null when data is insufficient.
 */
function calcWilderATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;

  // True ranges starting from bar[1] (bar[0] is used only as prevClose seed)
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].c;
    const { h, l }  = bars[i];
    trs.push(Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose)));
  }

  if (trs.length < period) return null;

  // Seed: simple average of the first `period` TRs
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Wilder's smoothing for the remainder
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  return atr;
}

/**
 * Pure function — builds stop/target levels from a known ATR value.
 * Separated from the async fetch so the cache path can reuse it without
 * repeating the multiplier logic.
 */
function buildATRStop(atr, entryPrice, mode, direction) {
  const stopMult    = mode === 'day' ? 1.5 : 2;
  const target1Mult = mode === 'day' ? 1.5 : 2;
  const target2Mult = mode === 'day' ? 3   : 4;

  let stopPrice, target1, target2;
  if (direction === 'LONG') {
    stopPrice = roundLimitPrice(entryPrice - stopMult    * atr);
    target1   = roundLimitPrice(entryPrice + target1Mult * atr);
    target2   = roundLimitPrice(entryPrice + target2Mult * atr);
  } else {
    stopPrice = roundLimitPrice(entryPrice + stopMult    * atr);
    target1   = roundLimitPrice(entryPrice - target1Mult * atr);
    target2   = roundLimitPrice(entryPrice - target2Mult * atr);
  }

  return { atr: parseFloat(atr.toFixed(4)), stopPrice, target1, target2 };
}

// ─── ADX CALCULATION ─────────────────────────────────────────────────────────

/**
 * Computes ADX14 (Wilder's method) from an ascending OHLC bar array ({ h, l, c }).
 * Requires at least 30 bars. Returns { adx, plusDI, minusDI } or null.
 */
function calcADX14(bars, period = 14) {
  if (!bars || bars.length < period * 2 + 2) return null;

  const pdms = [], mdms = [], trs = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], c = bars[i];
    const up   = c.h - p.h;
    const down = p.l - c.l;
    pdms.push(up > down && up > 0 ? up : 0);
    mdms.push(down > up && down > 0 ? down : 0);
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }

  if (trs.length < period + period) return null;

  let sTR  = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = pdms.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = mdms.slice(0, period).reduce((a, b) => a + b, 0);

  const dxOf = (tr, pdm, mdm) => {
    if (tr === 0) return 0;
    const pdi = 100 * pdm / tr, mdi = 100 * mdm / tr;
    const s = pdi + mdi;
    return s === 0 ? 0 : 100 * Math.abs(pdi - mdi) / s;
  };

  const dxVals = [dxOf(sTR, sPDM, sMDM)];
  for (let i = period; i < trs.length; i++) {
    sTR  = sTR  - sTR  / period + trs[i];
    sPDM = sPDM - sPDM / period + pdms[i];
    sMDM = sMDM - sMDM / period + mdms[i];
    dxVals.push(dxOf(sTR, sPDM, sMDM));
  }

  if (dxVals.length < period) return null;

  let adx = dxVals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxVals.length; i++) {
    adx = (adx * (period - 1) + dxVals[i]) / period;
  }

  return {
    adx:     parseFloat(adx.toFixed(2)),
    plusDI:  sTR === 0 ? 0 : parseFloat((100 * sPDM / sTR).toFixed(2)),
    minusDI: sTR === 0 ? 0 : parseFloat((100 * sMDM / sTR).toFixed(2)),
  };
}

// ─── SUPPORT & RESISTANCE ────────────────────────────────────────────────────

function clusterPivotsBOT(prices, thresholdPct = 0.005) {
  if (!prices.length) return [];
  prices.sort((a, b) => a - b);
  const clusters = [];
  for (const p of prices) {
    const hit = clusters.find(c => Math.abs(c.avg - p) / c.avg <= thresholdPct);
    if (hit) { hit.sum += p; hit.n++; hit.avg = hit.sum / hit.n; }
    else      clusters.push({ avg: p, sum: p, n: 1 });
  }
  return clusters.map(c => parseFloat(c.avg.toFixed(4)));
}

function touchCountBOT(level, bars, thresholdPct = 0.003) {
  return bars.filter(b =>
    Math.abs(b.h - level) / level <= thresholdPct ||
    Math.abs(b.l - level) / level <= thresholdPct ||
    Math.abs(b.c - level) / level <= thresholdPct
  ).length;
}

/**
 * Fetches 60 daily bars for `symbol`, detects pivot highs/lows (±2 bars),
 * clusters within 0.5%, counts touches within 0.3%.
 * Returns { resistance: [{price, strength, touchCount}], support: [...] } or null.
 * Cached per symbol for 4 hours.
 */
async function getSymbolSR(symbol) {
  const cacheKey = `sr:${symbol}`;
  const cached = srBotCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < SR_BOT_CACHE_TTL) {
    console.log(`[bot] S/R cache hit for ${symbol}`);
    return cached.result;
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  const today    = toETDate();
  const fromDate = toETDate(new Date(Date.now() - 90 * 24 * 3600 * 1000));
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${fromDate}/${today}?adjusted=true&sort=asc&limit=60&apiKey=${apiKey}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let resp;
    try { resp = await fetch(url, { signal: ctrl.signal }); }
    finally { clearTimeout(timer); }

    if (!resp.ok) { console.warn(`[bot] S/R fetch HTTP ${resp.status} for ${symbol}`); return null; }

    const data = await resp.json();
    const bars = data?.results;
    if (!Array.isArray(bars) || bars.length < 10) return null;

    const pivotHighs = [], pivotLows = [];
    for (let i = 2; i < bars.length - 2; i++) {
      const b = bars[i];
      if (b.h > bars[i-1].h && b.h > bars[i-2].h && b.h > bars[i+1].h && b.h > bars[i+2].h)
        pivotHighs.push(b.h);
      if (b.l < bars[i-1].l && b.l < bars[i-2].l && b.l < bars[i+1].l && b.l < bars[i+2].l)
        pivotLows.push(b.l);
    }

    const resistance = clusterPivotsBOT(pivotHighs).map(price => {
      const tc = touchCountBOT(price, bars);
      return { price: parseFloat(price.toFixed(2)), strength: tc, touchCount: tc };
    }).sort((a, b) => b.strength - a.strength).slice(0, 3);

    const support = clusterPivotsBOT(pivotLows).map(price => {
      const tc = touchCountBOT(price, bars);
      return { price: parseFloat(price.toFixed(2)), strength: tc, touchCount: tc };
    }).sort((a, b) => a.strength - b.strength).slice(0, 3);

    const result = { resistance, support };
    srBotCache[cacheKey] = { ts: Date.now(), result };
    console.log(`[bot] S/R ${symbol}: ${resistance.length} resistance, ${support.length} support levels`);
    return result;
  } catch (err) {
    console.warn(`[bot] S/R fetch error for ${symbol}:`, err.message);
    return null;
  }
}

// ─── OPTIONS FLOW SCORING ─────────────────────────────────────────────────────

/**
 * Fetches top-50 options contracts for `symbol` from Polygon, aggregates
 * call/put volume and open interest, returns a directional score -20..+20.
 * signal: 'bullish' | 'bearish' | 'neutral'
 * smartMoney: true when call volumeRatio > 0.80 (heavy call skew)
 * Cached per symbol for 10 minutes.
 */
async function getSymbolOptionsFlow(symbol) {
  const cacheKey = `flow:${symbol}`;
  const cached = optionsFlowBotCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < OPTIONS_FLOW_BOT_CACHE_TTL) {
    console.log(`[bot] options flow cache hit for ${symbol}: score=${cached.score}`);
    return cached;
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  const url = `https://api.polygon.io/v3/snapshot/options/${symbol}?limit=50&apiKey=${apiKey}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let resp;
    try { resp = await fetch(url, { signal: ctrl.signal }); }
    finally { clearTimeout(timer); }

    if (!resp.ok) {
      console.warn(`[bot] options flow fetch HTTP ${resp.status} for ${symbol}`);
      return null;
    }

    const data = await resp.json();
    const results = data?.results;
    if (!Array.isArray(results) || results.length === 0) return null;

    let callVol = 0, putVol = 0, callOI = 0, putOI = 0;
    for (const r of results) {
      const ct  = (r.details?.contract_type || '').toLowerCase();
      const vol = r.day?.volume ?? 0;
      const oi  = r.open_interest ?? 0;
      if (ct === 'call')      { callVol += vol; callOI += oi; }
      else if (ct === 'put')  { putVol  += vol; putOI  += oi; }
    }

    const totalVol = callVol + putVol;
    const totalOI  = callOI  + putOI;
    const volumeRatio = totalVol > 0 ? callVol / totalVol : 0.5;
    const oiRatio     = totalOI  > 0 ? callOI  / totalOI  : 0.5;

    const score     = Math.round(Math.max(-20, Math.min(20, (volumeRatio - 0.5) * 20 + (oiRatio - 0.5) * 20)));
    const signal    = score >= 8 ? 'bullish' : score <= -8 ? 'bearish' : 'neutral';
    const smartMoney = volumeRatio > 0.80;

    const entry = { ts: Date.now(), score, signal, volumeRatio, oiRatio, smartMoney };
    optionsFlowBotCache[cacheKey] = entry;
    console.log(`[bot] OPTIONS_FLOW: ${symbol} score=${score} signal=${signal} volRatio=${volumeRatio.toFixed(3)} smartMoney=${smartMoney}`);
    return entry;
  } catch (err) {
    console.warn(`[bot] options flow error for ${symbol}:`, err.message);
    return null;
  }
}

// ─── MULTI-TIMEFRAME TREND FUNCTIONS ─────────────────────────────────────────

/**
 * Fetches ~210 daily bars and computes EMA60 / EMA200 on closes.
 * Results are cached per-symbol for 60 minutes.
 * Returns { bullish, bearish, ema60, ema200 } or null on failure.
 */
async function checkDailyTrend(symbol) {
  const cacheKey = `daily:${symbol}`;
  const cached = trendCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < TREND_CACHE_TTL) {
    console.log(`[bot] MTF daily cache hit for ${symbol}`);
    return cached;
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  const toDate   = toETDate();
  const fromDate = toETDate(new Date(Date.now() - 300 * 24 * 3600 * 1000));
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=210&apiKey=${apiKey}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      console.warn(`[bot] MTF daily fetch HTTP ${resp.status} for ${symbol}`);
      return null;
    }

    const data = await resp.json();
    const bars = data?.results;
    if (!Array.isArray(bars) || bars.length < 200) {
      console.warn(`[bot] MTF daily insufficient bars (${bars?.length ?? 0}) for ${symbol}`);
      return null;
    }

    const closes = bars.map(b => b.c);
    const ema60  = calcEMA(closes, 60);
    const ema200 = calcEMA(closes, 200);

    if (ema60 == null || ema200 == null) return null;

    const result = {
      ts:      Date.now(),
      bullish: ema60 > ema200,
      bearish: ema60 < ema200,
      ema60:   parseFloat(ema60.toFixed(4)),
      ema200:  parseFloat(ema200.toFixed(4)),
    };
    trendCache[cacheKey] = result;
    console.log(`[bot] MTF daily ${symbol}: EMA60 ${result.ema60} vs EMA200 ${result.ema200} → ${result.bullish ? 'BULLISH' : result.bearish ? 'BEARISH' : 'FLAT'}`);
    return result;
  } catch (err) {
    console.warn(`[bot] MTF daily fetch error for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Fetches ~60 weekly bars and computes EMA20 / EMA50 on closes (swing mode only).
 * Results are cached per-symbol for 60 minutes.
 * Returns { bullish, bearish, ema20, ema50 } or null on failure.
 */
async function checkWeeklyTrend(symbol) {
  const cacheKey = `weekly:${symbol}`;
  const cached = trendCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < TREND_CACHE_TTL) {
    console.log(`[bot] MTF weekly cache hit for ${symbol}`);
    return cached;
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  const toDate   = toETDate();
  const fromDate = toETDate(new Date(Date.now() - 300 * 24 * 3600 * 1000));
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/week/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=60&apiKey=${apiKey}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      console.warn(`[bot] MTF weekly fetch HTTP ${resp.status} for ${symbol}`);
      return null;
    }

    const data = await resp.json();
    const bars = data?.results;
    if (!Array.isArray(bars) || bars.length < 50) {
      console.warn(`[bot] MTF weekly insufficient bars (${bars?.length ?? 0}) for ${symbol}`);
      return null;
    }

    const closes = bars.map(b => b.c);
    const ema20  = calcEMA(closes, 20);
    const ema50  = calcEMA(closes, 50);

    if (ema20 == null || ema50 == null) return null;

    const result = {
      ts:      Date.now(),
      bullish: ema20 > ema50,
      bearish: ema20 < ema50,
      ema20:   parseFloat(ema20.toFixed(4)),
      ema50:   parseFloat(ema50.toFixed(4)),
    };
    trendCache[cacheKey] = result;
    console.log(`[bot] MTF weekly ${symbol}: EMA20 ${result.ema20} vs EMA50 ${result.ema50} → ${result.bullish ? 'BULLISH' : result.bearish ? 'BEARISH' : 'FLAT'}`);
    return result;
  } catch (err) {
    console.warn(`[bot] MTF weekly fetch error for ${symbol}:`, err.message);
    return null;
  }
}

// ─── VOLUME CONFIRMATION ─────────────────────────────────────────────────────

/**
 * Fetches the last 20 bars for the symbol at the mode-appropriate timeframe
 * (15-min for day trades, 4-hour for swing trades), computes the 20-bar average
 * volume, and compares it against currentVolume.
 *
 * @param {string}  symbol          - Ticker symbol
 * @param {number}  currentVolume   - Volume of the current (signal) bar
 * @param {string}  mode            - "day" or "swing"
 * @param {boolean} isMacdCrossover - When true, threshold is raised to 1.5×
 * @returns {{ confirmed: boolean, ratio: number, avgVolume: number } | null}
 *   Returns null on API failure (caller should fail-open in that case).
 */
async function checkVolumeConfirmation(symbol, currentVolume, mode, isMacdCrossover = false) {
  if (currentVolume == null || !isFinite(currentVolume) || currentVolume < 0) return null;

  const cacheKey = `vol:${mode}:${symbol}`;
  const cached = volumeCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < VOLUME_CACHE_TTL) {
    console.log(`[bot] VOL cache hit for ${symbol} (${mode}), avgVol=${cached.avgVolume}`);
    const threshold = isMacdCrossover ? 1.5 : 1.2;
    const ratio = parseFloat((currentVolume / cached.avgVolume).toFixed(4));
    return { confirmed: ratio >= threshold, ratio, avgVolume: cached.avgVolume };
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  // Day trades: 15-min bars; fetch 5 calendar days back to guarantee 20 trading bars.
  // Swing trades: 4-hour bars; fetch 30 calendar days back.
  const [multiplier, timespan, lookbackDays] = mode === 'day'
    ? [15, 'minute', 5]
    : [4,  'hour',   30];

  const toDate   = toETDate();
  const fromDate = toETDate(new Date(Date.now() - lookbackDays * 24 * 3600 * 1000));
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${fromDate}/${toDate}?adjusted=true&sort=desc&limit=20&apiKey=${apiKey}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      console.warn(`[bot] VOL fetch HTTP ${resp.status} for ${symbol} (${mode})`);
      return null;
    }

    const data = await resp.json();
    const bars = data?.results;
    if (!Array.isArray(bars) || bars.length === 0) {
      console.warn(`[bot] VOL no bars returned for ${symbol} (${mode})`);
      return null;
    }

    const avgVolume = parseFloat(
      (bars.reduce((sum, b) => sum + (b.v ?? 0), 0) / bars.length).toFixed(0)
    );

    volumeCache[cacheKey] = { ts: Date.now(), avgVolume };

    const threshold = isMacdCrossover ? 1.5 : 1.2;
    const ratio = parseFloat((currentVolume / avgVolume).toFixed(4));
    console.log(`[bot] VOL ${symbol} (${mode}): currentVol=${currentVolume}, avgVol=${avgVolume}, ratio=${ratio}, threshold=${threshold}×`);
    return { confirmed: ratio >= threshold, ratio, avgVolume };
  } catch (err) {
    console.warn(`[bot] VOL fetch error for ${symbol} (${mode}):`, err.message);
    return null;
  }
}

// ─── INTRADAY VWAP ───────────────────────────────────────────────────────────

/**
 * Fetches all 1-minute bars for today's session (9:30 AM ET onward) and
 * computes the session VWAP using typical price × volume weighting.
 *
 * Returns { vwap, currentPrice, aboveVwap } or null when:
 *  - The market has not yet opened (< 9:30 AM ET)
 *  - Fewer than 5 bars are available (too early in session to be meaningful)
 *  - The Polygon request fails
 *
 * A null return signals the caller to skip the filter and allow the trade.
 * Results are cached per symbol for 3 minutes.
 */
async function calculateVWAP(symbol) {
  // Skip before market open (9:30 AM ET = 570 minutes into ET day)
  const MARKET_OPEN_MIN = 9 * 60 + 30;
  if (getETMinuteOfDay() < MARKET_OPEN_MIN) return null;

  const cacheKey = `vwap:${symbol}`;
  const cached = vwapCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < VWAP_CACHE_TTL) {
    console.log(`[bot] VWAP cache hit for ${symbol}: vwap=${cached.vwap}, price=${cached.currentPrice}`);
    return cached;
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  const todayDate = toETDate();
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${todayDate}/${todayDate}?adjusted=true&sort=asc&limit=500&apiKey=${apiKey}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      console.warn(`[bot] VWAP fetch HTTP ${resp.status} for ${symbol}`);
      return null;
    }

    const data = await resp.json();
    const bars = data?.results;

    // Filter to bars at or after 9:30 AM ET (Polygon timestamps are UTC ms)
    const et = getEasternTime();
    const now = new Date();
    const sessionStartMs = Date.UTC(
      et.getUTCFullYear(), et.getUTCMonth(), et.getUTCDate(),
      9 + (isNYDST(now) ? 4 : 5), 30  // 9:30 ET expressed as UTC hours
    );
    const sessionBars = Array.isArray(bars)
      ? bars.filter(b => b.t >= sessionStartMs)
      : [];

    if (sessionBars.length < 5) {
      console.log(`[bot] VWAP skipped for ${symbol} — only ${sessionBars.length} session bars (< 5)`);
      return null;
    }

    let sumTPV = 0;
    let sumV   = 0;
    for (const b of sessionBars) {
      const tp = (b.h + b.l + b.c) / 3;
      sumTPV += tp * b.v;
      sumV   += b.v;
    }

    if (sumV === 0) return null;

    const vwap         = parseFloat((sumTPV / sumV).toFixed(4));
    const currentPrice = parseFloat(sessionBars[sessionBars.length - 1].c.toFixed(4));
    const aboveVwap    = currentPrice > vwap;

    const result = { ts: Date.now(), vwap, currentPrice, aboveVwap };
    vwapCache[cacheKey] = result;
    console.log(`[bot] VWAP ${symbol}: vwap=${vwap}, price=${currentPrice}, aboveVwap=${aboveVwap} (${sessionBars.length} bars)`);
    return result;
  } catch (err) {
    console.warn(`[bot] VWAP fetch error for ${symbol}:`, err.message);
    return null;
  }
}

// ─── NEWS SENTIMENT SCORING ──────────────────────────────────────────────────

/**
 * Fetches the last 5 Polygon headlines for a symbol, then scores their trading
 * sentiment via claude-sonnet-4-6 using the same prompt as news.js.
 *
 * Returns { score: -10..10, catalyst: boolean, summary: string } or null on
 * any failure (caller proceeds without the sentiment filter in that case).
 * Results are cached per symbol for 15 minutes.
 */
async function getSymbolSentiment(symbol) {
  const cacheKey = `sent:${symbol}`;
  const cached = sentimentBotCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < SENTIMENT_BOT_CACHE_TTL) {
    console.log(`[bot] SENTIMENT cache hit for ${symbol}: score=${cached.result.score}`);
    return cached.result;
  }

  const polygonKey   = process.env.POLYGON_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!polygonKey || !anthropicKey) return null;

  try {
    // Step 1: fetch up to 5 recent headlines from Polygon
    const newsCtrl = new AbortController();
    const newsTimer = setTimeout(() => newsCtrl.abort(), 8000);
    let newsResp;
    try {
      newsResp = await fetch(
        `https://api.polygon.io/v2/reference/news?ticker=${symbol}&limit=5&order=desc&sort=published_utc&apiKey=${polygonKey}`,
        { signal: newsCtrl.signal }
      );
    } finally {
      clearTimeout(newsTimer);
    }

    if (!newsResp.ok) {
      console.warn(`[bot] SENTIMENT news fetch HTTP ${newsResp.status} for ${symbol}`);
      return null;
    }

    const newsData  = await newsResp.json();
    const headlines = (newsData.results || []).slice(0, 5).map(n => n.title).filter(Boolean);
    if (headlines.length === 0) return null;

    // Step 2: score via Anthropic
    const headlineStr = headlines.join(' | ');
    const prompt = `You are a trading signal assistant. Rate the overall trading sentiment of these headlines for the stock. Return ONLY valid JSON, no explanation: { "score": <integer from -10 to 10>, "catalyst": <true or false>, "summary": <5 words max> }. Headlines: ${headlineStr}`;

    const aiCtrl  = new AbortController();
    const aiTimer = setTimeout(() => aiCtrl.abort(), 15000);
    let aiResp;
    try {
      aiResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 100,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: aiCtrl.signal,
      });
    } finally {
      clearTimeout(aiTimer);
    }

    if (!aiResp.ok) {
      console.warn(`[bot] SENTIMENT Anthropic HTTP ${aiResp.status} for ${symbol}`);
      return null;
    }

    const aiData = await aiResp.json();
    const text   = aiData.content?.[0]?.text ?? '';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed   = JSON.parse(jsonMatch[0]);
    const scoreRaw = parseInt(parsed.score ?? 0, 10);
    const result   = {
      score:    isNaN(scoreRaw) ? 0 : Math.max(-10, Math.min(10, scoreRaw)),
      catalyst: parsed.catalyst === true,
      summary:  String(parsed.summary ?? 'neutral').slice(0, 60),
    };

    sentimentBotCache[cacheKey] = { ts: Date.now(), result };
    console.log(`[bot] SENTIMENT ${symbol}: score=${result.score} catalyst=${result.catalyst} summary="${result.summary}"`);
    return result;
  } catch (err) {
    console.warn(`[bot] SENTIMENT error for ${symbol}:`, err.message);
    return null;
  }
}

// ─── RELATIVE STRENGTH ───────────────────────────────────────────────────────

/**
 * Fetches the last 6 bars for `symbol` and SPY in parallel at the
 * mode-appropriate timeframe (15-min for day, daily for swing), then computes
 * 5-bar percent change and the RS ratio.
 *
 * pctChange = (close[last] - close[last-5]) / close[last-5] * 100
 * rs        = symbolPctChange / spyPctChange  (1.0 when SPY is flat)
 *
 * Returns { rs, symbolChange, spyChange } or null on failure.
 * Cached per symbol+mode for 10 minutes.
 */
async function getRelativeStrength(symbol, mode) {
  if (symbol === 'SPY') return null; // no self-comparison

  const cacheKey = `rs:${mode}:${symbol}`;
  const cached = rsCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < RS_CACHE_TTL) {
    console.log(`[bot] RS cache hit for ${symbol} (${mode}): rs=${cached.rs}`);
    return cached;
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  const [multiplier, timespan, lookbackDays] = mode === 'day'
    ? [15, 'minute', 5]
    : [1,  'day',    15];

  const toDate   = toETDate();
  const fromDate = toETDate(new Date(Date.now() - lookbackDays * 24 * 3600 * 1000));
  const buildUrl = (ticker) =>
    `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/${multiplier}/${timespan}/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=6&apiKey=${apiKey}`;

  try {
    const fetchBar = async (ticker) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const resp = await fetch(buildUrl(ticker), { signal: controller.signal });
        if (!resp.ok) return null;
        return await resp.json();
      } finally {
        clearTimeout(timer);
      }
    };

    const [symData, spyData] = await Promise.all([fetchBar(symbol), fetchBar('SPY')]);

    const symBars = symData?.results;
    const spyBars = spyData?.results;

    if (!Array.isArray(symBars) || symBars.length < 6 ||
        !Array.isArray(spyBars) || spyBars.length < 6) {
      console.warn(`[bot] RS insufficient bars for ${symbol} (${symBars?.length ?? 0}) or SPY (${spyBars?.length ?? 0})`);
      return null;
    }

    const pct = (bars) => {
      const first = bars[bars.length - 6].c;
      const last  = bars[bars.length - 1].c;
      return ((last - first) / first) * 100;
    };

    const symbolChange = parseFloat(pct(symBars).toFixed(4));
    const spyChange    = parseFloat(pct(spyBars).toFixed(4));
    const rs           = spyChange === 0
      ? 1.0
      : parseFloat((symbolChange / spyChange).toFixed(4));

    const result = { ts: Date.now(), rs, symbolChange, spyChange };
    rsCache[cacheKey] = result;
    console.log(`[bot] RS_FILTER: ${symbol} rs=${rs}, symbolChange=${symbolChange}%, spyChange=${spyChange}%`);
    return result;
  } catch (err) {
    console.warn(`[bot] RS fetch error for ${symbol} (${mode}):`, err.message);
    return null;
  }
}

// ─── ADAPTIVE POSITION SIZING ────────────────────────────────────────────────

/**
 * Queries the last 20 closed trades from the Supabase journal (pnl_pct column),
 * computes a half-Kelly fraction from win rate / avg win / avg loss, then
 * applies a confidence-tier multiplier.
 *
 * Caches the Supabase stats for 5 minutes (module-level) so the DB is not
 * hit on every single order validation request.
 *
 * @param {number} baseSize   - Starting max position size (already correlation-adjusted)
 * @param {number} confidence - NZR signal confidence score (0-100)
 * @param {string} symbol     - Symbol (used only for logging)
 * @returns {number} Adjusted position size, never greater than baseSize
 */
async function getAdaptivePositionSize(baseSize, confidence, symbol) {
  const fallback = parseFloat((baseSize * 0.75).toFixed(2));

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.log(`[bot] ADAPTIVE_SIZE: Supabase not configured, using 0.75× fallback for ${symbol}`);
    return fallback;
  }

  // ── Fetch / use cached Kelly stats ─────────────────────────────────────────
  let stats = adaptiveSizingStats;
  if (!stats || (Date.now() - stats.ts) >= ADAPTIVE_CACHE_TTL) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let resp;
      try {
        resp = await fetch(
          `${supabaseUrl}/rest/v1/journal?select=pnl_pct&pnl_pct=not.is.null&order=id.desc&limit=20`,
          {
            headers: {
              'apikey':         supabaseKey,
              'Authorization':  `Bearer ${supabaseKey}`,
              'Content-Type':   'application/json',
            },
            signal: controller.signal,
          }
        );
      } finally {
        clearTimeout(timer);
      }

      if (!resp.ok) throw new Error(`Supabase HTTP ${resp.status}`);

      const trades = await resp.json();
      if (!Array.isArray(trades)) throw new Error('Unexpected Supabase response shape');

      if (trades.length < 10) {
        console.log(`[bot] ADAPTIVE_SIZE: insufficient history (${trades.length} trades) for ${symbol} — using conservative 0.5×`);
        return parseFloat((baseSize * 0.5).toFixed(2));
      }

      const pnlValues = trades.map(t => parseFloat(t.pnl_pct)).filter(v => isFinite(v));
      const wins      = pnlValues.filter(v => v > 0);
      const losses    = pnlValues.filter(v => v <= 0);

      const winRate = wins.length / pnlValues.length;
      const avgWin  = wins.length  > 0 ? wins.reduce((a, b)  => a + b, 0) / wins.length  : 0;
      const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;

      let kellyFraction;
      if (avgWin === 0) {
        kellyFraction = 0.1;
      } else {
        kellyFraction = (winRate * avgWin - (1 - winRate) * avgLoss) / avgWin;
      }
      kellyFraction = Math.max(0.1, Math.min(1.0, kellyFraction));

      stats = { ts: Date.now(), winRate, avgWin, avgLoss, kellyFraction, tradeCount: pnlValues.length };
      adaptiveSizingStats = stats;
      console.log(`[bot] ADAPTIVE_SIZE: refreshed Kelly stats — winRate=${(winRate*100).toFixed(1)}% avgWin=${avgWin.toFixed(3)}% avgLoss=${avgLoss.toFixed(3)}% kelly=${kellyFraction.toFixed(3)}`);

    } catch (err) {
      console.log(`[bot] ADAPTIVE_SIZE: supabase error, using fallback — ${err.message}`);
      return fallback;
    }
  }

  // ── Apply Kelly fraction ────────────────────────────────────────────────────
  let adjustedSize = baseSize * stats.kellyFraction;

  // ── Apply confidence-tier multiplier ───────────────────────────────────────
  const scoreMult = confidence >= 80 ? 1.0
                  : confidence >= 60 ? 0.75
                  : 0.5;
  adjustedSize = parseFloat((adjustedSize * scoreMult).toFixed(2));

  console.log(`[bot] ADAPTIVE_SIZE: ${symbol} kelly=${stats.kellyFraction.toFixed(3)} scoreMult=${scoreMult} base=$${baseSize} → $${adjustedSize}`);
  return adjustedSize;
}

// ─── ATR-BASED DYNAMIC STOP ──────────────────────────────────────────────────

/**
 * Fetches the last 20 bars at the mode-appropriate timeframe (15-min for day,
 * daily for swing), computes ATR14 with Wilder's smoothing, and returns the
 * dynamic stop and two-stage target levels for the given entry.
 *
 * Day  LONG : stop = entry - 1.5×ATR, target1 = entry + 1.5×ATR, target2 = entry + 3×ATR
 * Day  SHORT: stop = entry + 1.5×ATR, target1 = entry - 1.5×ATR, target2 = entry - 3×ATR
 * Swing LONG : stop = entry - 2×ATR,  target1 = entry + 2×ATR,   target2 = entry + 4×ATR
 * Swing SHORT: stop = entry + 2×ATR,  target1 = entry - 2×ATR,   target2 = entry - 4×ATR
 *
 * Returns null on API failure — caller falls back to fixed-pct stop.
 * ATR value is cached per symbol+mode for 10 minutes.
 */
async function getATRStop(symbol, mode, entryPrice, direction) {
  const cacheKey = `atr:${mode}:${symbol}`;
  const cached = atrCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < ATR_CACHE_TTL) {
    console.log(`[bot] ATR cache hit for ${symbol} (${mode}): atr=${cached.atr}`);
    return buildATRStop(cached.atr, entryPrice, mode, direction);
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  const [multiplier, timespan, lookbackDays] = mode === 'day'
    ? [15, 'minute', 5]
    : [1,  'day',    30];

  const toDate   = toETDate();
  const fromDate = toETDate(new Date(Date.now() - lookbackDays * 24 * 3600 * 1000));
  const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${fromDate}/${toDate}?adjusted=true&sort=asc&limit=20&apiKey=${apiKey}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!resp.ok) {
      console.warn(`[bot] ATR fetch HTTP ${resp.status} for ${symbol} (${mode})`);
      return null;
    }

    const data = await resp.json();
    const bars = data?.results;
    if (!Array.isArray(bars) || bars.length < 15) {
      console.warn(`[bot] ATR insufficient bars (${bars?.length ?? 0}) for ${symbol} (${mode})`);
      return null;
    }

    const atr = calcWilderATR(bars, 14);
    if (atr == null || !isFinite(atr) || atr <= 0) return null;

    atrCache[cacheKey] = { ts: Date.now(), atr };
    console.log(`[bot] ATR computed for ${symbol} (${mode}): atr=${atr.toFixed(4)} from ${bars.length} bars`);
    return buildATRStop(atr, entryPrice, mode, direction);
  } catch (err) {
    console.warn(`[bot] ATR fetch error for ${symbol} (${mode}):`, err.message);
    return null;
  }
}

// ─── MARKET REGIME ───────────────────────────────────────────────────────────

/**
 * Fetches 30 daily SPY bars and current VIX in parallel, computes ADX14, and
 * classifies the market regime. Cached for 30 minutes.
 *
 * Regimes:
 *  "crisis"   — VIX > 30 AND ADX < 20 (high fear + no trend)
 *  "trending" — ADX > 25
 *  "choppy"   — ADX < 20
 *  "neutral"  — ADX 20–25
 *
 * Returns the cached/live result, or a safe neutral default on any failure.
 */
async function getMarketRegime() {
  if (regimeBotCache && (Date.now() - regimeBotCache.ts) < REGIME_BOT_CACHE_TTL) {
    console.log(`[bot] REGIME cache hit: ${regimeBotCache.result.regime}`);
    return regimeBotCache.result;
  }

  const apiKey = process.env.POLYGON_API_KEY;
  const neutral = { adx: null, plusDI: null, minusDI: null, vix: null, regime: 'neutral' };
  if (!apiKey) return neutral;

  const today    = toETDate();
  const fromDate = toETDate(new Date(Date.now() - 45 * 24 * 3600 * 1000));

  const fetchWithTimeout = async (url, opts = {}, ms = 10000) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const [spyResp, vixResp] = await Promise.all([
      fetchWithTimeout(
        `https://api.polygon.io/v2/aggs/ticker/SPY/range/1/day/${fromDate}/${today}?adjusted=true&sort=asc&limit=30&apiKey=${apiKey}`
      ),
      fetchWithTimeout(
        'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d',
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
      ),
    ]);

    const spyJson = spyResp.ok ? await spyResp.json() : null;
    const vixJson = vixResp.ok ? await vixResp.json() : null;

    const bars = spyJson?.results;
    const vix  = vixJson?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;

    if (!Array.isArray(bars) || bars.length < 30) {
      console.warn(`[bot] REGIME: insufficient SPY bars (${bars?.length ?? 0}) — defaulting to neutral`);
      return neutral;
    }

    const adxResult = calcADX14(bars.map(b => ({ h: b.h, l: b.l, c: b.c })));
    if (!adxResult) return neutral;

    const { adx, plusDI, minusDI } = adxResult;
    let regime;
    if (vix != null && vix > 30 && adx < 20) regime = 'crisis';
    else if (adx > 25)                        regime = 'trending';
    else if (adx < 20)                        regime = 'choppy';
    else                                      regime = 'neutral';

    const result = { adx, plusDI, minusDI, vix, regime };
    regimeBotCache = { ts: Date.now(), result };
    console.log(`[bot] REGIME computed: adx=${adx} vix=${vix} → ${regime}`);
    return result;
  } catch (err) {
    console.warn(`[bot] REGIME fetch error:`, err.message, '— defaulting to neutral');
    return neutral;
  }
}

// ─── DIRECTION RECOMMENDATION ─────────────────────────────────────────────────

function recommendDirection(ind) {
  if (!ind) return { direction: 'NEUTRAL', leverage: 1, confidence: 0, reasoning: 'No indicators provided.' };

  const rsi           = safeNum(ind.rsi);
  const macdHist      = safeNum(ind.macdHistogram ?? ind.macd_histogram ?? ind.histogram);
  const ema60         = safeNum(ind.ema60);
  const ema200        = safeNum(ind.ema200);
  const gcSignal      = typeof ind.goldenCross === 'string'
    ? ind.goldenCross
    : (ind.goldenCross?.signal ?? ind.golden_cross?.signal ?? null);

  const isFreshGolden = gcSignal === 'Fresh Golden Cross';
  const isGolden      = gcSignal === 'Golden Cross' || isFreshGolden;
  const isFreshDeath  = gcSignal === 'Fresh Death Cross';
  const isDeath       = gcSignal === 'Death Cross'  || isFreshDeath;

  let bullish = 0, bearish = 0;
  const bReasons = [], dReasons = [];

  if (ema60 !== null && ema200 !== null) {
    if (ema60 > ema200) { bullish++; bReasons.push(`EMA60 ($${ema60.toFixed(2)}) > EMA200 ($${ema200.toFixed(2)})`); }
    else                { bearish++; dReasons.push(`EMA60 ($${ema60.toFixed(2)}) < EMA200 ($${ema200.toFixed(2)})`); }
  }
  if (rsi !== null) {
    if (rsi < 70) { bullish++; bReasons.push(`RSI ${rsi.toFixed(1)} — not overbought`); }
    if (rsi > 30) { bearish++; dReasons.push(`RSI ${rsi.toFixed(1)} — not oversold (room to fall)`); }
  }
  if (macdHist !== null) {
    if (macdHist > 0) { bullish++; bReasons.push(`MACD histogram positive (${macdHist.toFixed(4)})`); }
    else              { bearish++; dReasons.push(`MACD histogram negative (${macdHist.toFixed(4)})`); }
  }

  let direction, confidence, reasoning;

  if (bullish >= 3) {
    direction  = 'LONG';
    confidence = Math.min(100, Math.round((bullish / 3) * 70 + (isFreshGolden ? 25 : isGolden ? 15 : 0)));
    reasoning  = `${bullish}/3 bullish: ${bReasons.join('; ')}.${isFreshGolden ? ' ⚡ Fresh Golden Cross.' : isGolden ? ' Golden Cross.' : ''}`;
  } else if (bearish >= 3) {
    direction  = 'SHORT';
    confidence = Math.min(100, Math.round((bearish / 3) * 70 + (isFreshDeath ? 25 : isDeath ? 15 : 0)));
    reasoning  = `${bearish}/3 bearish: ${dReasons.join('; ')}.${isFreshDeath ? ' ⚡ Fresh Death Cross.' : isDeath ? ' Death Cross.' : ''}`;
  } else {
    return { direction: 'NEUTRAL', leverage: 1, confidence: 0, reasoning: `Mixed: ${bullish} bullish, ${bearish} bearish. Need 3+ aligned signals.` };
  }

  let leverage = 1;
  if (rsi !== null && (rsi > 75 || rsi < 25)) {
    leverage = 1;
  } else if (isFreshGolden && rsi !== null && rsi >= 40 && rsi <= 60 && macdHist !== null && macdHist > 0) {
    leverage = 3;
  } else if ((isGolden || isDeath) && !isFreshGolden && !isFreshDeath) {
    leverage = 2;
  }

  return { direction, leverage: Math.min(leverage, 3), confidence, reasoning };
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'Rate limit reached' });

  const action = (req.query.action || req.body?.action || '').toLowerCase();

  // ── KILL SWITCH ──────────────────────────────────────────────────────────────
  if (action === 'killswitch') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    const body = req.body || {};
    if (typeof body.active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });
    killSwitch = body.active;
    if (killSwitch) { dayState.active = false; swingState.active = false; }
    else            { dayState.active = true;  swingState.active = true;  }
    console.log(`[bot] Kill switch ${killSwitch ? 'ACTIVATED' : 'deactivated'}`);
    return res.status(200).json({ killSwitch, message: killSwitch ? 'Kill switch activated — both modes halted' : 'Kill switch deactivated — trading resumed' });
  }

  // ── SET CAPITAL ──────────────────────────────────────────────────────────────
  if (action === 'setcapital') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    const body = req.body || {};
    const cap = safeNum(body.capital);
    if (!cap || cap <= 0) return res.status(400).json({ error: 'capital must be a positive number' });
    capitalAmount = cap;
    computeAllocations();
    console.log(`[bot] Capital set to $${capitalAmount}. Day alloc: $${dayState.allocation}, Swing alloc: $${swingState.allocation}`);
    return res.status(200).json({
      capital: capitalAmount,
      day:   { allocation: dayState.allocation,   maxPositionSize: dayState.maxPositionSize,   maxExposure: dayState.maxExposure,   maxDailyLoss: dayState.maxDailyLoss },
      swing: { allocation: swingState.allocation, maxPositionSize: swingState.maxPositionSize, maxExposure: swingState.maxExposure, maxWeeklyLoss: swingState.maxWeeklyLoss },
    });
  }

  // ── SET RULES ────────────────────────────────────────────────────────────────
  if (action === 'setrules') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    const body = req.body || {};
    const mode = String(body.mode || 'day').toLowerCase();
    const bucket = mode === 'swing' ? swingState : dayState;
    const allowed = ['maxTradesDay','maxTradesWeek','stopLossPct','minRR','cooldownMin','cooldownHours'];
    const updated = {};
    for (const k of allowed) {
      if (body[k] !== undefined) {
        const v = safeNum(body[k]);
        if (v !== null) { bucket[k] = v; updated[k] = v; }
      }
    }
    return res.status(200).json({ message: `Rules updated for ${mode}`, updated, [mode]: bucket });
  }

  // ── DIRECTION ONLY ───────────────────────────────────────────────────────────
  if (action === 'direction') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    const body = req.body || {};
    const rec = recommendDirection(body.indicators || null);
    return res.status(200).json({ ...rec, killSwitch });
  }

  // ── AUTO-CLOSE LOGIC ─────────────────────────────────────────────────────────
  if (action === 'autoclose') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    const body = req.body || {};
    const mode = String(body.mode || 'day').toLowerCase();
    const positions = Array.isArray(body.positions) ? body.positions : [];
    const now = Date.now();

    if (mode === 'day') {
      const etMin = getETMinuteOfDay();
      const CLOSE_MIN = 15 * 60 + 45; // 3:45 PM ET
      if (etMin < CLOSE_MIN) {
        return res.status(200).json({ closePositions: [], reason: 'Market still open — auto-close not yet triggered', autoCloseAt: '15:45 ET' });
      }
      // Return all positions tagged as day trades for closing
      const toClose = positions.filter(p => {
        const cid = p.client_order_id || '';
        return cid.startsWith('NZR-day-') || p.mode === 'day';
      });
      console.log(`[bot] Day auto-close: ${toClose.length} position(s) at 3:45 PM ET`);
      return res.status(200).json({ closePositions: toClose, reason: 'EOD_AUTO_CLOSE', message: `Closing ${toClose.length} day trade position(s) at 3:45 PM ET` });
    }

    if (mode === 'swing') {
      const MAX_HOLD_DAYS = 30;
      const toClose = positions.filter(p => {
        if (!p.entryDate && !p.created_at) return false;
        const entryMs = new Date(p.entryDate || p.created_at).getTime();
        const ageDays = Math.round((now - entryMs) / 86400000);
        return ageDays >= MAX_HOLD_DAYS;
      }).map(p => {
        const entryMs = new Date(p.entryDate || p.created_at).getTime();
        const ageDays = Math.round((now - entryMs) / 86400000);
        return { ...p, ageDays, reason: `Swing trade auto-closed: ${p.symbol} held ${ageDays} days — max hold period reached` };
      });
      if (toClose.length) toClose.forEach(p => console.log(`[bot] ${p.reason}`));
      return res.status(200).json({ closePositions: toClose, reason: 'MAX_HOLD_PERIOD', message: `${toClose.length} swing position(s) exceed 30-day hold limit` });
    }

    return res.status(400).json({ error: 'mode must be "day" or "swing"' });
  }

  // ── STATUS ───────────────────────────────────────────────────────────────────
  if (action === 'status' || (req.method === 'GET' && !action)) {
    resetDayIfNeeded();
    resetSwingIfNeeded();
    const etMin = getETMinuteOfDay();
    const CLOSE_MIN = 15 * 60 + 45;
    const minsToClose = Math.max(0, CLOSE_MIN - etMin);
    return res.status(200).json({
      killSwitch,
      capitalAmount,
      day: {
        ...dayState,
        maxDailyLossFormatted: dayState.maxDailyLoss ? `$${Math.abs(dayState.maxDailyLoss).toFixed(0)}` : null,
      },
      swing: {
        ...swingState,
        maxWeeklyLossFormatted: swingState.maxWeeklyLoss ? `$${Math.abs(swingState.maxWeeklyLoss).toFixed(0)}` : null,
      },
      autoClose: {
        dayMinsToClose: minsToClose,
        dayCloseAt: '3:45 PM ET',
        swingCheckAt: 'Market open daily',
      },
      trailingStops: Object.fromEntries(
        [...trailingStops.entries()].map(([k, v]) => [k, {
          stage: v.stage, direction: v.direction, entryPrice: v.entryPrice,
          stopPrice: v.stopPrice, target1: v.target1, target2: v.target2,
          atr: v.atr, highestPrice: v.highestPrice, lowestPrice: v.lowestPrice,
        }])
      ),
    });
  }

  // ── SYNC P&L (called by Alpaca position update) ──────────────────────────────
  if (action === 'syncpnl') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    const body = req.body || {};
    if (body.dayPnl !== undefined) { const v = safeNum(body.dayPnl); if (v !== null) dayState.pnl = v; }
    if (body.swingPnl !== undefined) { const v = safeNum(body.swingPnl); if (v !== null) swingState.pnl = v; }
    return res.status(200).json({ dayPnl: dayState.pnl, swingPnl: swingState.pnl });
  }

  // ── UPDATE TRAILING STOP ────────────────────────────────────────────────────
  if (action === 'updatetrailingstop') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    const body = req.body || {};
    const sym  = sanitizeSymbol(body.symbol);
    const md   = String(body.mode || 'day').toLowerCase();
    const currentPrice = safeNum(body.currentPrice);
    if (!sym || !currentPrice) return res.status(400).json({ error: 'symbol and currentPrice required' });

    const key   = `${md}:${sym}`;
    const state = trailingStops.get(key);
    if (!state) return res.status(404).json({ error: `No trailing stop found for ${sym} in ${md} mode` });

    const { direction, entryPrice, atr, target1, target2 } = state;
    let { stage, stopPrice, highestPrice, lowestPrice } = state;
    let moved = false;

    if (direction === 'LONG') {
      highestPrice = Math.max(highestPrice, currentPrice);
      if (stage === 1 && highestPrice >= target1) {
        stage     = 2;
        stopPrice = roundLimitPrice(entryPrice); // move to breakeven
        moved     = true;
        console.log(`[bot] TRAIL ${sym}: stage 1→2 (breakeven) stop=$${stopPrice}`);
      }
      if (stage >= 2 && highestPrice >= target2) {
        stage     = 3;
        stopPrice = roundLimitPrice(highestPrice - atr);
        moved     = true;
        console.log(`[bot] TRAIL ${sym}: stage 2→3 (trailing) stop=$${stopPrice}`);
      } else if (stage === 3) {
        const newStop = roundLimitPrice(highestPrice - atr);
        if (newStop > stopPrice) { stopPrice = newStop; moved = true; }
      }
    } else { // SHORT
      lowestPrice = Math.min(lowestPrice, currentPrice);
      if (stage === 1 && lowestPrice <= target1) {
        stage     = 2;
        stopPrice = roundLimitPrice(entryPrice);
        moved     = true;
        console.log(`[bot] TRAIL ${sym}: stage 1→2 (breakeven) stop=$${stopPrice}`);
      }
      if (stage >= 2 && lowestPrice <= target2) {
        stage     = 3;
        stopPrice = roundLimitPrice(lowestPrice + atr);
        moved     = true;
        console.log(`[bot] TRAIL ${sym}: stage 2→3 (trailing) stop=$${stopPrice}`);
      } else if (stage === 3) {
        const newStop = roundLimitPrice(lowestPrice + atr);
        if (newStop < stopPrice) { stopPrice = newStop; moved = true; }
      }
    }

    const updatedAt = Date.now();
    trailingStops.set(key, { ...state, stage, stopPrice, highestPrice, lowestPrice, updatedAt });
    return res.status(200).json({ symbol: sym, mode: md, stage, stopPrice, target1, target2, highestPrice, lowestPrice, moved, updatedAt });
  }

  // ── ORDER VALIDATION ─────────────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const body = req.body || {};

  if (!body.symbol) return res.status(400).json({ rejected: true, reason: 'symbol is required' });
  const symbol = sanitizeSymbol(body.symbol);
  if (!symbol) return res.status(400).json({ rejected: true, reason: 'Invalid symbol' });

  const mode = String(body.mode || 'day').toLowerCase();
  if (!['day', 'swing'].includes(mode)) {
    return res.status(400).json({ rejected: true, reason: 'mode must be "day" or "swing"' });
  }

  if (!capitalAmount) {
    return res.status(400).json({ rejected: true, reason: 'Capital not set — call POST /api/bot?action=setcapital first' });
  }

  resetDayIfNeeded();
  resetSwingIfNeeded();

  const ts = Date.now();
  function reject(reason) {
    return res.status(200).json({ approved: false, rejected: true, reason, symbol, mode, timestamp: ts });
  }

  const bucket = mode === 'day' ? dayState : swingState;

  // Sync external P&L if provided
  if (body.dayPnl !== undefined && mode === 'day') {
    const v = safeNum(body.dayPnl); if (v !== null) dayState.pnl = v;
  }
  if (body.swingPnl !== undefined && mode === 'swing') {
    const v = safeNum(body.swingPnl); if (v !== null) swingState.pnl = v;
  }

  // 1. KILL SWITCH
  if (killSwitch) return reject('Kill switch active — all trading halted');
  if (!bucket.active) return reject(`${mode} trading mode is halted`);

  // 1b. MARKET REGIME CHECK
  const regime = await getMarketRegime().catch(() => ({ regime: 'neutral', adx: null, vix: null }));
  if (regime.regime === 'crisis') {
    console.log(`[bot] REGIME_BLOCK: crisis regime detected, VIX=${regime.vix} ADX=${regime.adx}`);
    return reject(`REGIME_BLOCK: crisis regime detected (VIX ${regime.vix}, ADX ${regime.adx}) — no new entries, manage existing positions only`);
  }

  // 2. LOSS LIMITS
  if (mode === 'day' && dayState.pnl <= dayState.maxDailyLoss) {
    return reject(`Daily loss limit reached ($${dayState.pnl.toFixed(2)} vs limit $${dayState.maxDailyLoss.toFixed(2)})`);
  }
  if (mode === 'swing' && swingState.pnl <= swingState.maxWeeklyLoss) {
    return reject(`Weekly loss limit reached ($${swingState.pnl.toFixed(2)} vs limit $${swingState.maxWeeklyLoss.toFixed(2)})`);
  }

  // 3. TRADE COUNT LIMITS
  if (mode === 'day' && dayState.trades >= dayState.maxTradesDay) {
    return reject(`Max day trades reached (${dayState.trades}/${dayState.maxTradesDay}) — limit resets midnight ET`);
  }
  if (mode === 'swing' && swingState.trades >= swingState.maxTradesWeek) {
    return reject(`Max swing trades reached (${swingState.trades}/${swingState.maxTradesWeek}) — limit resets Monday ET`);
  }

  // 4. COOLDOWN
  const cooldownMs = mode === 'day'
    ? (dayState.cooldownMin * 60 * 1000)
    : (swingState.cooldownHours * 3600 * 1000);
  const cd = checkCooldown(symbol, mode, cooldownMs);
  if (!cd.ok) return reject(`Cooldown active for ${symbol} in ${mode} mode (${cd.remaining}s remaining)`);

  // 5. EXISTING POSITION CHECK
  const openPositions = Array.isArray(body.openPositions) ? body.openPositions : [];
  const hasPos = openPositions.some(p => {
    const s = sanitizeSymbol(p?.symbol ?? p?.ticker ?? '');
    return s === symbol && (p.mode === mode || !p.mode);
  });
  if (hasPos) return reject(`Position already open for ${symbol} in ${mode} mode`);

  // 5b. SECTOR CORRELATION GUARD
  let effectiveMaxPositionSize = bucket.maxPositionSize;
  const corrGuard = checkCorrelationGuard(symbol, openPositions);
  if (!corrGuard.allowed) {
    console.log(`[bot] CORRELATION_GUARD: blocked ${symbol}, already ${corrGuard.sectorCount} positions in ${corrGuard.sector}`);
    return reject(`CORRELATION_GUARD: already ${corrGuard.sectorCount} positions open in ${corrGuard.sector} sector — max 2 per sector`);
  }
  if (corrGuard.sectorCount === 1) {
    effectiveMaxPositionSize = parseFloat((bucket.maxPositionSize * 0.6).toFixed(2));
    console.log(`[bot] CORRELATION_GUARD: ${symbol} (${corrGuard.sector}) — 1 correlated position open, reducing max size $${bucket.maxPositionSize.toFixed(2)} → $${effectiveMaxPositionSize}`);
  }
  if (regime.regime === 'choppy') {
    effectiveMaxPositionSize = parseFloat((effectiveMaxPositionSize * 0.75).toFixed(2));
    console.log(`[bot] REGIME: choppy market — reducing position size 25% → $${effectiveMaxPositionSize}`);
  }

  // 6. EXPOSURE CHECK
  const currentExposure = safeNum(body.totalExposure) ?? 0;
  if (currentExposure >= bucket.maxExposure) {
    return reject(`Max ${mode} exposure reached ($${currentExposure.toFixed(0)}/$${bucket.maxExposure.toFixed(0)})`);
  }

  // 7. DIRECTION RECOMMENDATION
  const indicators = body.indicators || null;
  const rec = recommendDirection(indicators);
  const rawDir = String(body.direction || '').toUpperCase();
  const direction = (['LONG', 'SHORT'].includes(rawDir)) ? rawDir : rec.direction;

  if (!['LONG', 'SHORT'].includes(direction)) {
    return reject('Neutral signal — no clear trade direction');
  }

  // 7b. SESSION QUALITY FILTER (day trades only)
  if (mode === 'day') {
    const session = getSessionQuality();

    if (session === 'avoid') {
      console.log(`[bot] SESSION_FILTER: avoid zone, skipping ${symbol}`);
      return reject('SESSION_FILTER: opening shakeout zone (9:30–10:00 AM ET) — no new day trade entries');
    }

    if (session === 'close') {
      console.log(`[bot] SESSION_FILTER: close zone, skipping ${symbol}`);
      return reject('SESSION_FILTER: closing volatility zone (3:30–4:00 PM ET) — no new day trade entries');
    }

    const sessionAdj = session === 'prime' ? 10 : session === 'lunch' ? -10 : 0;
    if (sessionAdj !== 0) {
      const rawConfidence    = rec.confidence ?? 0;
      const adjConfidence    = rawConfidence + sessionAdj;
      if (session === 'lunch' && adjConfidence < ENTRY_CONFIDENCE_THRESHOLD) {
        console.log(`[bot] SESSION_FILTER: lunch zone dropped confidence ${rawConfidence} → ${adjConfidence} below threshold (${ENTRY_CONFIDENCE_THRESHOLD}), skipping ${symbol}`);
        return reject(`SESSION_FILTER: lunch zone penalty — adjusted confidence ${adjConfidence} below entry threshold ${ENTRY_CONFIDENCE_THRESHOLD}`);
      }
      rec.confidence = Math.min(100, Math.max(0, adjConfidence));
      console.log(`[bot] SESSION_FILTER: ${session} zone ${sessionAdj > 0 ? '+' : ''}${sessionAdj} confidence → ${rec.confidence} for ${symbol}`);
    }
  }

  // 7b.5 REGIME LEVERAGE CAP (choppy only — applied after direction is resolved)
  if (regime.regime === 'choppy' && rec.leverage > 1) {
    console.log(`[bot] REGIME: choppy market — capping leverage at 1× for ${symbol} (was ${rec.leverage}×)`);
    rec.leverage = 1;
  }

  // 7c. NEWS SENTIMENT GATE (day and swing trades)
  try {
    const sentiment = await getSymbolSentiment(symbol);
    if (sentiment) {
      if (sentiment.score <= -5) {
        console.log(`[bot] SENTIMENT_BLOCK: ${symbol} score=${sentiment.score}`);
        return reject(`SENTIMENT_BLOCK: strongly negative news sentiment (score ${sentiment.score}/10) — "${sentiment.summary}"`);
      }

      let sentimentAdj = 0;
      if      (sentiment.score >= 7)  sentimentAdj += 15;
      else if (sentiment.score >= 4)  sentimentAdj += 8;
      else if (sentiment.score <= -2) sentimentAdj -= 8;
      if (sentiment.catalyst)         sentimentAdj += 10;

      if (sentimentAdj !== 0) {
        const prev = rec.confidence ?? 0;
        rec.confidence = Math.min(100, Math.max(0, prev + sentimentAdj));
        console.log(`[bot] SENTIMENT: ${symbol} score=${sentiment.score} catalyst=${sentiment.catalyst} adj=${sentimentAdj > 0 ? '+' : ''}${sentimentAdj} confidence ${prev}→${rec.confidence}`);
      }
    }
  } catch (sentErr) {
    console.warn(`[bot] Sentiment gate error for ${symbol}:`, sentErr.message, '— proceeding without filter');
  }

  // 7d. RELATIVE STRENGTH FILTER (day and swing trades)
  try {
    const rsResult = await getRelativeStrength(symbol, mode);
    if (rsResult) {
      const { rs, symbolChange, spyChange } = rsResult;
      let rsAdj = 0;

      if (direction === 'LONG') {
        if      (rs > 2.0) rsAdj = +15;
        else if (rs > 1.5) rsAdj = +10;
        else if (rs < 0.8) rsAdj = -10;
      } else { // SHORT
        if      (rs < 0.5) rsAdj = +15;
        else if (rs > 1.2) rsAdj = -10;
      }

      if (rsAdj !== 0) {
        const prev = rec.confidence ?? 0;
        rec.confidence = Math.min(100, Math.max(0, prev + rsAdj));
        console.log(`[bot] RS_FILTER: ${symbol} rs=${rs}, symbolChange=${symbolChange}%, spyChange=${spyChange}% → adj=${rsAdj > 0 ? '+' : ''}${rsAdj} confidence ${prev}→${rec.confidence}`);
      } else {
        console.log(`[bot] RS_FILTER: ${symbol} rs=${rs}, symbolChange=${symbolChange}%, spyChange=${spyChange}% → no adjustment`);
      }
    }
  } catch (rsErr) {
    console.warn(`[bot] RS filter error for ${symbol}:`, rsErr.message, '— proceeding without filter');
  }

  // 7e. OPTIONS FLOW GATE
  // score ≥ +15 → strong bullish flow (+20 confidence)
  // score ≥  +8 → mild bullish flow  (+10 confidence)
  // score ≤ -15 → strong bearish flow (block LONG; +20 SHORT)
  // score ≤  -8 → mild bearish flow  (-10 LONG; +10 SHORT)
  // smartMoney tag appended to rec.note when call volumeRatio > 0.80
  try {
    const flow = await getSymbolOptionsFlow(symbol);
    if (flow) {
      const { score: flowScore, signal: flowSignal, volumeRatio, smartMoney } = flow;
      const prev = rec.confidence ?? 0;
      let flowAdj = 0;

      if (direction === 'LONG') {
        if      (flowScore <= -15) {
          console.log(`[bot] OPTIONS_FLOW_BLOCK: ${symbol} strong bearish flow (score=${flowScore}) → blocking LONG`);
          return reject(`OPTIONS_FLOW: Strong bearish options flow (score=${flowScore}) conflicts with LONG direction`);
        } else if (flowScore <= -8) { flowAdj = -10; }
        else if  (flowScore >=  15) { flowAdj = +20; }
        else if  (flowScore >=   8) { flowAdj = +10; }
      } else { // SHORT
        if      (flowScore >= 15) { flowAdj = -10; }
        else if (flowScore >= 8)  { flowAdj = -5; }
        else if (flowScore <= -15){ flowAdj = +20; }
        else if (flowScore <= -8) { flowAdj = +10; }
      }

      if (flowAdj !== 0) {
        rec.confidence = Math.min(100, Math.max(0, prev + flowAdj));
        console.log(`[bot] OPTIONS_FLOW: ${symbol} score=${flowScore} signal=${flowSignal} → adj=${flowAdj > 0 ? '+' : ''}${flowAdj} confidence ${prev}→${rec.confidence}`);
      } else {
        console.log(`[bot] OPTIONS_FLOW: ${symbol} score=${flowScore} signal=${flowSignal} → no adjustment`);
      }

      if (smartMoney) {
        rec.note = (rec.note ? rec.note + ' | ' : '') + `Smart money: heavy call flow (${(volumeRatio * 100).toFixed(0)}% calls)`;
        console.log(`[bot] OPTIONS_FLOW: ${symbol} smart money detected — call volumeRatio=${(volumeRatio * 100).toFixed(1)}%`);
      }
    }
  } catch (flowErr) {
    console.warn(`[bot] options flow gate error for ${symbol}:`, flowErr.message, '— proceeding without filter');
  }

  // 8. MULTI-TIMEFRAME CONFLUENCE
  try {
    const dailyTrend = await checkDailyTrend(symbol);
    if (dailyTrend) {
      if (direction === 'LONG' && !dailyTrend.bullish) {
        console.log(`[bot] MTF_CONFLICT: skipping ${symbol} — LONG signal but daily EMA60 (${dailyTrend.ema60}) < EMA200 (${dailyTrend.ema200})`);
        return reject(`MTF_CONFLICT: LONG signal conflicts with daily downtrend (EMA60 $${dailyTrend.ema60} < EMA200 $${dailyTrend.ema200})`);
      }
      if (direction === 'SHORT' && !dailyTrend.bearish) {
        console.log(`[bot] MTF_CONFLICT: skipping ${symbol} — SHORT signal but daily EMA60 (${dailyTrend.ema60}) > EMA200 (${dailyTrend.ema200})`);
        return reject(`MTF_CONFLICT: SHORT signal conflicts with daily uptrend (EMA60 $${dailyTrend.ema60} > EMA200 $${dailyTrend.ema200})`);
      }
    }
    if (mode === 'swing') {
      const weeklyTrend = await checkWeeklyTrend(symbol);
      if (weeklyTrend) {
        if (direction === 'LONG' && !weeklyTrend.bullish) {
          console.log(`[bot] MTF_CONFLICT: skipping ${symbol} — LONG signal but weekly EMA20 (${weeklyTrend.ema20}) < EMA50 (${weeklyTrend.ema50})`);
          return reject(`MTF_CONFLICT: LONG signal conflicts with weekly downtrend (EMA20 $${weeklyTrend.ema20} < EMA50 $${weeklyTrend.ema50})`);
        }
        if (direction === 'SHORT' && !weeklyTrend.bearish) {
          console.log(`[bot] MTF_CONFLICT: skipping ${symbol} — SHORT signal but weekly EMA20 (${weeklyTrend.ema20}) > EMA50 (${weeklyTrend.ema50})`);
          return reject(`MTF_CONFLICT: SHORT signal conflicts with weekly uptrend (EMA20 $${weeklyTrend.ema20} > EMA50 $${weeklyTrend.ema50})`);
        }
      }
    }
  } catch (mtfErr) {
    console.warn(`[bot] MTF check error for ${symbol}:`, mtfErr.message, '— proceeding without filter');
  }

  // 9. VOLUME CONFIRMATION GATE
  const currentVolume   = safeNum(body.currentVolume ?? body.indicators?.volume);
  const isMacdCrossover = body.isMacdCrossover === true || body.signalType === 'macd';
  if (currentVolume != null) {
    try {
      const vol = await checkVolumeConfirmation(symbol, currentVolume, mode, isMacdCrossover);
      if (vol) {
        const ratioStr = vol.ratio.toFixed(2);
        if (!vol.confirmed) {
          const threshold = isMacdCrossover ? '1.5' : '1.2';
          console.log(`[bot] VOLUME_GATE: rejected ${symbol}, ratio=${ratioStr} (need ${threshold}×, avgVol=${vol.avgVolume})`);
          return reject(`VOLUME_GATE: insufficient volume for ${symbol} — ratio ${ratioStr}× vs required ${threshold}× (avgVol ${vol.avgVolume})`);
        }
        console.log(`[bot] VOLUME_GATE: passed ${symbol}, ratio=${ratioStr}`);
      }
      // null return = API failure → fail-open (do not block the trade)
    } catch (volErr) {
      console.warn(`[bot] Volume gate error for ${symbol}:`, volErr.message, '— proceeding without filter');
    }
  }

  // 10. VWAP DIRECTIONAL FILTER (day trades only)
  if (mode === 'day') {
    try {
      const vwapResult = await calculateVWAP(symbol);
      if (vwapResult) {
        // null = pre-open or < 5 bars → skip filter
        if (direction === 'LONG' && !vwapResult.aboveVwap) {
          console.log(`[bot] VWAP_FILTER: rejected LONG ${symbol}, price=${vwapResult.currentPrice}, vwap=${vwapResult.vwap}`);
          return reject(`VWAP_FILTER: LONG rejected — price $${vwapResult.currentPrice} is below VWAP $${vwapResult.vwap}`);
        }
        if (direction === 'SHORT' && vwapResult.aboveVwap) {
          console.log(`[bot] VWAP_FILTER: rejected SHORT ${symbol}, price=${vwapResult.currentPrice}, vwap=${vwapResult.vwap}`);
          return reject(`VWAP_FILTER: SHORT rejected — price $${vwapResult.currentPrice} is above VWAP $${vwapResult.vwap}`);
        }
      }
    } catch (vwapErr) {
      console.warn(`[bot] VWAP filter error for ${symbol}:`, vwapErr.message, '— proceeding without filter');
    }
  }

  // 11. LIMIT PRICE
  const lastPrice  = safeNum(body.lastPrice ?? body.price ?? indicators?.price);
  let   limitPrice = safeNum(body.limitPrice);
  let   autoSet    = false;
  let   srLevelUsed = null; // set when S/R anchors the limit price

  if (limitPrice != null) {
    // Caller-provided explicit limit — honour it, no S/R override
    limitPrice = roundLimitPrice(limitPrice);
  } else if (lastPrice != null) {
    // Try S/R-anchored limit first (only when auto-calculating)
    try {
      const sr = await getSymbolSR(symbol);
      if (sr) {
        if (direction === 'LONG' && sr.support.length) {
          // Find nearest support within 2% below current price
          const nearest = sr.support
            .filter(s => s.price < lastPrice && (lastPrice - s.price) / lastPrice <= 0.02)
            .sort((a, b) => b.price - a.price)[0]; // highest (closest) support first
          if (nearest) {
            const srPrice = roundLimitPrice(nearest.price * 1.001); // +0.1% above support
            if (srPrice > 0 && isFinite(srPrice)) {
              limitPrice  = srPrice;
              srLevelUsed = nearest.price;
              autoSet     = true;
              console.log(`[bot] SR_ORDER: ${symbol} limit set at ${limitPrice} based on support level at ${srLevelUsed}`);
            }
          }
        } else if (direction === 'SHORT' && sr.resistance.length) {
          // Find nearest resistance within 2% above current price
          const nearest = sr.resistance
            .filter(r => r.price > lastPrice && (r.price - lastPrice) / lastPrice <= 0.02)
            .sort((a, b) => a.price - b.price)[0]; // lowest (closest) resistance first
          if (nearest) {
            const srPrice = roundLimitPrice(nearest.price * 0.999); // -0.1% below resistance
            if (srPrice > 0 && isFinite(srPrice)) {
              limitPrice  = srPrice;
              srLevelUsed = nearest.price;
              autoSet     = true;
              console.log(`[bot] SR_ORDER: ${symbol} limit set at ${limitPrice} based on resistance level at ${srLevelUsed}`);
            }
          }
        }
      }
    } catch (srErr) {
      console.warn(`[bot] S/R limit lookup error for ${symbol}:`, srErr.message);
    }

    // Fallback: standard slippage-based limit
    if (limitPrice == null) {
      limitPrice = calcLimitPrice(lastPrice, direction);
      autoSet    = true;
    }
  } else {
    return reject('limitPrice or lastPrice required — market orders not permitted');
  }

  if (!limitPrice || !isFinite(limitPrice) || limitPrice <= 0) {
    return reject('Could not calculate a valid limit price');
  }

  // 12. POSITION SIZE
  const quantity      = safeNum(body.quantity) ?? 1;
  const positionValue = limitPrice * quantity;

  // Adaptive sizing: Kelly-based + confidence tier, computed BEFORE the hard cap
  const adaptiveRaw = await getAdaptivePositionSize(
    effectiveMaxPositionSize, rec.confidence ?? 0, symbol
  ).catch(err => {
    console.warn(`[bot] ADAPTIVE_SIZE: unexpected error for ${symbol}:`, err.message, '— using 0.75× fallback');
    return parseFloat((effectiveMaxPositionSize * 0.75).toFixed(2));
  });
  // Hard cap: adaptive result can never exceed the correlation-adjusted bucket max
  const adaptiveMax = Math.min(adaptiveRaw, effectiveMaxPositionSize);

  if (positionValue > adaptiveMax) {
    const notes = [
      corrGuard.sectorCount === 1 ? '40% correlation reduction' : '',
      adaptiveRaw < effectiveMaxPositionSize ? `Kelly/score adaptive sizing` : '',
    ].filter(Boolean).join(', ');
    return reject(`Position size $${positionValue.toFixed(2)} exceeds adaptive max $${adaptiveMax.toFixed(2)} for ${mode} mode${notes ? ` (${notes})` : ''}`);
  }

  // ── APPROVED ──────────────────────────────────────────────────────────────────
  recentOrders.set(`${mode}:${symbol}`, { timestamp: ts });
  if (mode === 'day') dayState.trades++;
  else swingState.trades++;

  // ATR-based dynamic stop (falls back to fixed-pct if Polygon unavailable)
  let stopLoss, target, target2, atrValue = null;
  const atrResult = await getATRStop(symbol, mode, limitPrice, direction).catch(() => null);

  if (atrResult) {
    stopLoss  = atrResult.stopPrice;
    target    = atrResult.target1;
    target2   = atrResult.target2;
    atrValue  = atrResult.atr;
    console.log(`[bot] ATR_STOP: ${symbol} entry=$${limitPrice} stop=$${stopLoss} atr=${atrValue}`);

    // Register position in trailing stop tracker (stage 1)
    const tsKey = `${mode}:${symbol}`;
    trailingStops.set(tsKey, {
      stage:        1,
      direction,
      mode,
      entryPrice:   limitPrice,
      atr:          atrValue,
      stopPrice:    stopLoss,
      target1:      target,
      target2,
      highestPrice: limitPrice,
      lowestPrice:  limitPrice,
      updatedAt:    ts,
    });
  } else {
    // Fallback: fixed-percentage stop from bucket rules
    stopLoss = direction === 'LONG'
      ? roundLimitPrice(limitPrice * (1 - bucket.stopLossPct))
      : roundLimitPrice(limitPrice * (1 + bucket.stopLossPct));
    const riskPerShare = Math.abs(limitPrice - stopLoss);
    target  = direction === 'LONG'
      ? roundLimitPrice(limitPrice + riskPerShare * bucket.minRR)
      : roundLimitPrice(limitPrice - riskPerShare * bucket.minRR);
    target2 = null;
    console.log(`[bot] ATR unavailable for ${symbol} — using fixed ${(bucket.stopLossPct * 100).toFixed(1)}% stop`);
  }

  const clientOrderId = `NZR-${mode}-${symbol}-${ts}`;

  console.log(`[bot] ${mode.toUpperCase()} order approved: ${direction} ${quantity}x ${symbol} @ $${limitPrice} | stop $${stopLoss} | T1 $${target}${target2 ? ` | T2 $${target2}` : ''}`);

  return res.status(200).json({
    approved: true,
    symbol,
    mode,
    direction,
    type:           'limit',
    limitPrice,
    stopLoss,
    target,
    target2:        target2 ?? undefined,
    atr:            atrValue ?? undefined,
    stopMethod:     atrValue != null ? 'atr' : 'fixed-pct',
    riskReward:     atrValue != null ? '2:1' : `${bucket.minRR}:1`,
    quantity,
    positionValue:  parseFloat(positionValue.toFixed(2)),
    autoLimitSet:   autoSet,
    srAnchor:       srLevelUsed ?? undefined,
    leverage:       rec.leverage ?? 1,
    confidence:     rec.confidence ?? 0,
    reasoning:      rec.reasoning ?? '',
    clientOrderId,
    timestamp:      ts,
    riskChecks: {
      killSwitch:    'inactive',
      lossLimit:     'passed',
      tradeCount:    `passed (${mode === 'day' ? dayState.trades : swingState.trades}/${mode === 'day' ? dayState.maxTradesDay : swingState.maxTradesWeek})`,
      cooldown:      'passed',
      positionLimit: 'passed',
      exposure:      'passed',
      positionSize:  'passed',
      correlation:   corrGuard.sector === 'unmapped'
        ? 'unmapped — no sector limit applied'
        : `passed — ${corrGuard.sectorCount} existing position(s) in ${corrGuard.sector}${corrGuard.sectorCount === 1 ? ' (size reduced 40%)' : ''}`,
    },
    marketRegime:  { regime: regime.regime, adx: regime.adx, vix: regime.vix },
    sectorInfo: {
      sector:        corrGuard.sector,
      sectorCount:   corrGuard.sectorCount,
      sizeReduced:   corrGuard.sectorCount === 1,
      effectiveMax:  effectiveMaxPositionSize,
      adaptiveMax,
      kellyFraction: adaptiveSizingStats?.kellyFraction ?? null,
    },
  });
};
