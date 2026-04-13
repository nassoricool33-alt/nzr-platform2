// REQUIRED SUPABASE TABLE: bot_state (key text PRIMARY KEY, value text, updated_at timestamptz)
/**
 * NZR Trading Bot — Dual-Mode Risk Management Engine
 * Supports Day Trading (intraday, 15-min) and Swing Trading (4H/daily, up to 30 days).
 * Capital is split: 40% day / 60% swing. All risk limits derived from capital.
 *
 * State persistence: trading state (kill switch, cooldowns, P&L, trailing stops,
 * consecutive losses, stopped-out symbols) is written through to the Supabase
 * bot_state table on every mutation and loaded on cold start.
 *
 * Required table (run once in Supabase SQL editor):
 *   CREATE TABLE IF NOT EXISTS bot_state (
 *     key        text PRIMARY KEY,
 *     value      text NOT NULL,
 *     updated_at timestamptz DEFAULT now()
 *   );
 */

const { createClient } = require('@supabase/supabase-js');
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

// ─── SCAN UNIVERSE ────────────────────────────────────────────────────────────
// 30 liquid symbols — scanned in parallel batches within the 25s budget.
// Supabase watchlist symbols are appended at scan time.
const SCAN_UNIVERSE = [...new Set([
  // MEGA CAP TECH
  'AAPL', 'MSFT', 'NVDA', 'AMD', 'TSLA', 'META', 'GOOGL', 'AMZN',
  'ARM', 'PLTR', 'COIN', 'MSTR', 'NFLX', 'CRM', 'ORCL', 'SNOW',

  // HIGH BETA GROWTH
  'CRWD', 'DKNG', 'RBLX', 'UBER', 'SHOP', 'SQ', 'PYPL', 'SOFI',
  'HOOD', 'UPST', 'MELI', 'DASH', 'ABNB', 'LYFT', 'RIVN', 'LCID',

  // SEMICONDUCTORS
  'AVGO', 'QCOM', 'MU', 'INTC', 'AMAT', 'LRCX', 'KLAC', 'ASML',
  'TSM', 'SMCI', 'ON', 'MRVL',

  // AI & CLOUD
  'MSFT', 'GOOGL', 'AMZN', 'ORCL', 'NOW', 'DDOG', 'NET', 'ZS',
  'PANW', 'MDB', 'GTLB',

  // FINANCIALS
  'JPM', 'GS', 'MS', 'BAC', 'V', 'MA', 'PYPL', 'SQ',

  // ENERGY & COMMODITIES
  'XOM', 'CVX', 'OXY', 'SLB', 'FCX', 'NEM',

  // ETFs
  'SPY', 'QQQ', 'IWM', 'XLK', 'XLF', 'ARKK',

  // BIOTECH
  'MRNA', 'BNTX', 'REGN', 'VRTX', 'GILD', 'AMGN',
])];

// Auto-scan interval tracker
let lastScanTime = 0;
const SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// ── Live-trading gate — set BOT_LIVE_TRADING=true in Vercel env to enable ────
const BOT_LIVE_TRADING = process.env.BOT_LIVE_TRADING === 'true';

const ALPACA_BASE = 'https://paper-api.alpaca.markets';

// ─── SECTOR MAP ───────────────────────────────────────────────────────────────
// Maps individual symbols to their SPDR sector ETF. Used by the correlation
// guard to prevent over-concentration in correlated positions.
const sectorMap = {
  // XLK — Technology
  AAPL:'XLK', MSFT:'XLK', NVDA:'XLK', AMD:'XLK', TSLA:'XLK',
  META:'XLK', GOOGL:'XLK', AMZN:'XLK', CRM:'XLK', ORCL:'XLK',
  INTC:'XLK', QCOM:'XLK', AVGO:'XLK', MU:'XLK', SMCI:'XLK',
  NOW:'XLK', DDOG:'XLK', NET:'XLK', ZS:'XLK', PANW:'XLK', MDB:'XLK', GTLB:'XLK',
  AMAT:'XLK', LRCX:'XLK', KLAC:'XLK', ASML:'XLK', TSM:'XLK', ON:'XLK', MRVL:'XLK',
  ARM:'XLK', PLTR:'XLK', SNOW:'XLK', CRWD:'XLK',
  // XLF — Financials
  JPM:'XLF', BAC:'XLF', GS:'XLF', MS:'XLF', WFC:'XLF',
  C:'XLF', BLK:'XLF', AXP:'XLF', V:'XLF', MA:'XLF',
  COIN:'XLF', SOFI:'XLF', HOOD:'XLF', SQ:'XLF', PYPL:'XLF',
  // XLV — Health Care / Biotech
  JNJ:'XLV', UNH:'XLV', PFE:'XLV', ABBV:'XLV', MRK:'XLV',
  LLY:'XLV', BMY:'XLV', AMGN:'XLV', GILD:'XLV',
  MRNA:'XLV', BNTX:'XLV', REGN:'XLV', VRTX:'XLV',
  // XLE — Energy & Commodities
  XOM:'XLE', CVX:'XLE', COP:'XLE', SLB:'XLE', OXY:'XLE', MPC:'XLE', PSX:'XLE',
  FCX:'XLE', NEM:'XLE',
  // XLI — Industrials
  BA:'XLI', CAT:'XLI', GE:'XLI', HON:'XLI', UPS:'XLI', FDX:'XLI', RTX:'XLI', LMT:'XLI',
  // XLY — Consumer Discretionary / High Beta Growth
  NKE:'XLY', SBUX:'XLY', MCD:'XLY', TGT:'XLY', HD:'XLY', LOW:'XLY', F:'XLY', GM:'XLY',
  DKNG:'XLY', RBLX:'XLY', UBER:'XLY', SHOP:'XLY', DASH:'XLY', ABNB:'XLY',
  LYFT:'XLY', RIVN:'XLY', LCID:'XLY', UPST:'XLY', MELI:'XLY',
  NFLX:'XLY', MSTR:'XLY',
  // XLC — Communication Services
};

// ─── MODULE-LEVEL STATE ──────────────────────────────────────────────────────

let killSwitch    = false;
let capitalAmount = null;   // Must be set via setcapital before trading
const DEFAULT_CAPITAL = 10000;

// ─── ANOMALY DETECTION — prevents duplicate orders within short windows ──────
const recentOrderTracker = new Map();

/** Returns capitalAmount if set, otherwise DEFAULT_CAPITAL. Never returns null/0. */
function getEffectiveCapital() {
  return (capitalAmount && capitalAmount > 0) ? capitalAmount : parseFloat(process.env.DEFAULT_CAPITAL || String(DEFAULT_CAPITAL));
}

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

// ─── PERSISTENT TRADING STATE ─────────────────────────────────────────────────
// These variables are the in-memory hot cache. They are written through to the
// Supabase bot_state table on every mutation and restored on cold start.
let consecutiveLosses  = 0;
let stoppedOutSymbols  = []; // [{ symbol: 'AAPL', expiresAt: <ms timestamp> }]
let weeklyPnl          = 0;  // week-to-date P&L as % of capital; stored under getWeeklyPnlKey()
let weeklyHalt         = false; // true once weeklyPnl hits -3%
let _stateLoaded       = false;

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

// ─── GAP CACHE ────────────────────────────────────────────────────────────────
// Keyed as "gap:SYMBOL" → { ts, gapPct, prevClose, preMarketPrice, gapType, dayOpen, currentPrice }
const gapCache = {};
const GAP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Screener watchlist for gap scanning — derived from the sector map
// (all symbols the bot is aware of and can trade)
const SCREENER_WATCHLIST = Object.keys(sectorMap);

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

// ─── BOT LOG BUFFER ──────────────────────────────────────────────────────────
const botLogBuffer = [];
const BOT_LOG_MAX  = 200;

/**
 * Appends a structured entry to the in-memory log buffer.
 * type: 'pass' | 'block' | 'warn' | 'info'
 */
function pushLog(message, type = 'info') {
  const entry = { timestamp: new Date().toISOString(), message, type };
  botLogBuffer.unshift(entry);
  if (botLogBuffer.length > 200) botLogBuffer.pop();
  console.log('[BOT]', type.toUpperCase(), message);

  // Persist to Supabase non-blocking
  if (supabase && message) {
    supabase.from('bot_logs').insert({ message, type }).then(() => {}).catch(() => {});
  }
}

// ─── SAFE NOTIFICATION INSERT ────────────────────────────────────────────────
// Uses service role key to bypass RLS. Never crashes the caller.
async function safeNotify(message, type = 'info') {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) return;
    fetch(`${url}/rest/v1/notifications`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        key,
        'Authorization': `Bearer ${key}`,
        'Prefer':        'return=minimal',
      },
      body: JSON.stringify({
        user_id: '00000000-0000-0000-0000-000000000000',
        message,
        type,
        read: false,
        created_at: new Date().toISOString(),
      }),
    }).catch(() => {});
  } catch(e) {
    console.log('NOTIFY_SKIP:', e.message);
  }
}

// ─── MACRO RISK CACHE ────────────────────────────────────────────────────────
let macroRiskCache = null;
const MACRO_RISK_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// ─── SECTOR ROTATION BOT CACHE ───────────────────────────────────────────────
let sectorRotationBotCache = null;
const SECTOR_ROTATION_BOT_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const SECTOR_ETF_NAMES_BOT = {
  XLK:'Technology', XLF:'Financials', XLV:'Healthcare', XLE:'Energy',
  XLI:'Industrials', XLB:'Materials', XLU:'Utilities', XLRE:'Real Estate',
  XLP:'Consumer Staples', XLY:'Consumer Discretionary', XLC:'Communication',
};

// ─── WEEK52 CACHE ────────────────────────────────────────────────────────────
const week52Cache = {};
const WEEK52_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ─── STRATEGY WEIGHTS CACHE ──────────────────────────────────────────────────
// { ts, result: { MACD, RSI, EMA2050, EMA60200, COMBINED, perfStats, computedAt, tradeCount } }
let strategyWeightsCache = null;
const STRATEGY_WEIGHTS_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

// ─── NEWS INTELLIGENCE CACHES ────────────────────────────────────────────────
// breaking: { ts, result: { headlines, marketPauseRecommended, highImpactCount, ... } }
let breakingNewsBotCache = null;
const BREAKING_NEWS_BOT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// georisk: { ts, result: { geoRiskScore, overallMarketRisk, recommendation, ... } }
let geoRiskBotCache = null;
const GEO_RISK_BOT_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// flash_news_halt: expiry timestamp in ms (0 = not active)
let flashHaltExpiry = 0;

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

// ─── SUPABASE STATE MANAGEMENT ───────────────────────────────────────────────

function _sbHeaders() {
  const key = process.env.SUPABASE_ANON_KEY;
  return key ? {
    'apikey':        key,
    'Authorization': `Bearer ${key}`,
    'Content-Type':  'application/json',
  } : null;
}

/** Reads capital_amount from Supabase bot_state. Returns 10000 as fallback. */
async function getCapital() {
  try {
    const url  = process.env.SUPABASE_URL;
    const hdrs = _sbHeaders();
    if (!url || !hdrs) return 10000;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    let r;
    try { r = await fetch(`${url}/rest/v1/bot_state?key=eq.capital_amount&select=value`, { headers: hdrs, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
    if (!r.ok) return 10000;
    const rows = await r.json().catch(() => []);
    if (Array.isArray(rows) && rows.length && rows[0].value) {
      const v = parseFloat(rows[0].value);
      return (isFinite(v) && v > 0) ? v : 10000;
    }
    return 10000;
  } catch(e) {
    return 10000;
  }
}

/** Fire-and-forget upsert of a single key into bot_state. Never awaited. */
function writeBotState(key, value) {
  const url  = process.env.SUPABASE_URL;
  const hdrs = _sbHeaders();
  if (!url || !hdrs) return;
  fetch(`${url}/rest/v1/bot_state`, {
    method:  'POST',
    headers: { ...hdrs, 'Prefer': 'resolution=merge-duplicates' },
    body:    JSON.stringify({ key, value: String(value), updated_at: new Date().toISOString() }),
  }).catch(() => {});
}

/** Batch fire-and-forget upsert of multiple [key, value] pairs. */
function writeManyBotState(entries) {
  const url  = process.env.SUPABASE_URL;
  const hdrs = _sbHeaders();
  if (!url || !hdrs || !entries.length) return;
  const rows = entries.map(([k, v]) => ({ key: k, value: String(v), updated_at: new Date().toISOString() }));
  fetch(`${url}/rest/v1/bot_state`, {
    method:  'POST',
    headers: { ...hdrs, 'Prefer': 'resolution=merge-duplicates' },
    body:    JSON.stringify(rows),
  }).catch(() => {});
}

/**
 * Loads all trading state from Supabase bot_state into module-level variables.
 * Called once per warm instance via ensureStateLoaded().
 */
async function loadStateFromSupabase() {
  const url  = process.env.SUPABASE_URL;
  const hdrs = _sbHeaders();
  if (!url || !hdrs) { _stateLoaded = true; return; }

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    let resp;
    try { resp = await fetch(`${url}/rest/v1/bot_state?select=key,value`, { headers: hdrs, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const rows = await resp.json();
    if (!Array.isArray(rows)) throw new Error('Unexpected shape');

    const s = {};
    for (const r of rows) s[r.key] = r.value;

    // Kill switch
    if (s.kill_switch === 'true') {
      killSwitch = true; dayState.active = false; swingState.active = false;
    }

    // Capital
    const cap = parseFloat(s.capital_amount);
    if (isFinite(cap) && cap > 0 && !capitalAmount) { capitalAmount = cap; computeAllocations(); }

    // Day state (only restore if same calendar day)
    const today = toETDate();
    if (s.day_date === today) {
      const pnl = parseFloat(s.day_pnl), trades = parseInt(s.day_trades, 10);
      if (isFinite(pnl))    dayState.pnl    = pnl;
      if (isFinite(trades)) dayState.trades = trades;
      dayState.date = today;
    }

    // Swing state (only restore if same week)
    const monday = getMondayET();
    if (s.swing_week_start === monday) {
      const pnl = parseFloat(s.swing_pnl), trades = parseInt(s.swing_trades, 10);
      if (isFinite(pnl))    swingState.pnl    = pnl;
      if (isFinite(trades)) swingState.trades = trades;
      swingState.weekStart = monday;
    }

    // Cooldowns
    if (s.cooldowns) {
      try {
        for (const [k, ts] of Object.entries(JSON.parse(s.cooldowns)))
          recentOrders.set(k, { timestamp: ts });
      } catch {}
    }

    // Trailing stops (open position tracker)
    if (s.trailing_stops) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(s.trailing_stops)))
          trailingStops.set(k, v);
      } catch {}
    }

    // Consecutive loss counter
    const cl = parseInt(s.consecutive_losses, 10);
    if (isFinite(cl) && cl >= 0) consecutiveLosses = cl;

    // Stopped-out symbols
    if (s.stopped_out_symbols) {
      try {
        const sos = JSON.parse(s.stopped_out_symbols);
        if (Array.isArray(sos)) stoppedOutSymbols = sos;
      } catch {}
    }

    // Flash news halt expiry
    const fnh = parseInt(s.flash_news_halt ?? '0', 10);
    if (isFinite(fnh) && fnh > Date.now()) flashHaltExpiry = fnh;

    // Weekly P&L and halt flag (keyed by current Monday)
    const wpKey = getWeeklyPnlKey();
    const wpRaw = s[wpKey];
    if (wpRaw) {
      try {
        const parsed = JSON.parse(wpRaw);
        const wp = parseFloat(parsed.pct);
        if (isFinite(wp)) weeklyPnl = wp;
        if (parsed.halt === true) weeklyHalt = true;
      } catch {}
    }

    console.log(`[bot] State restored — killSwitch=${killSwitch} capital=${capitalAmount} dayTrades=${dayState.trades} consecutiveLosses=${consecutiveLosses} stoppedOut=${stoppedOutSymbols.length} weeklyPnl=${weeklyPnl.toFixed(2)}% weeklyHalt=${weeklyHalt}`);
  } catch (err) {
    console.warn('[bot] loadStateFromSupabase error:', err.message);
  }
  _stateLoaded = true;
}

/** Ensures state has been loaded from Supabase at least once per warm instance. */
let _testCleanupDone = false;
async function ensureStateLoaded() {
  if (!_stateLoaded) await loadStateFromSupabase();
  // One-time cleanup of TEST entries from journal
  if (!_testCleanupDone && supabase) {
    _testCleanupDone = true;
    try { await supabase.from('journal').delete().eq('symbol', 'TEST'); } catch {}
  }
}

/** Marks a symbol as stopped-out for 2 hours and increments consecutive loss counter. */
function markStoppedOut(symbol) {
  const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
  stoppedOutSymbols = stoppedOutSymbols.filter(s => s.symbol !== symbol);
  stoppedOutSymbols.push({ symbol, expiresAt });
  consecutiveLosses++;
  writeManyBotState([
    ['stopped_out_symbols', JSON.stringify(stoppedOutSymbols)],
    ['consecutive_losses',  String(consecutiveLosses)],
  ]);
  pushLog(`STOPPED_OUT: ${symbol} blocked 2h, consecutive losses now ${consecutiveLosses}`, 'warn');
}

/** Returns true if the symbol is currently in the stopped-out list. */
function isStoppedOut(symbol) {
  const now = Date.now();
  stoppedOutSymbols = stoppedOutSymbols.filter(s => s.expiresAt > now);
  return stoppedOutSymbols.some(s => s.symbol === symbol);
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

/** Returns the Supabase bot_state key for the current week's P&L tracking. */
function getWeeklyPnlKey() {
  return `weekly_pnl_${getMondayET()}`;
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
  const cap = getEffectiveCapital();
  if (!capitalAmount || capitalAmount <= 0) {
    pushLog('CAPITAL_WARNING: no capital set, using default $' + cap, 'warn');
  }
  dayState.allocation      = cap * 0.40;
  dayState.maxPositionSize = dayState.allocation * 0.10;
  dayState.maxExposure     = dayState.allocation * 0.80;
  dayState.maxDailyLoss    = -(cap * 0.02);

  swingState.allocation      = cap * 0.60;
  swingState.maxPositionSize = swingState.allocation * 0.15;
  swingState.maxExposure     = swingState.allocation * 0.70;
  swingState.maxWeeklyLoss   = -(cap * 0.03);
}

/** Reset day counters when ET date changes; write-through to Supabase. */
function resetDayIfNeeded() {
  const today = toETDate();
  if (today !== dayState.date) {
    dayState.trades = 0;
    dayState.pnl    = 0;
    dayState.date   = today;
    consecutiveLosses = 0; // reset consecutive losses each new day
    writeManyBotState([
      ['day_pnl',            '0'],
      ['day_trades',         '0'],
      ['day_date',           today],
      ['consecutive_losses', '0'],
    ]);
  }
}

/** Reset swing weekly counters when ET Monday changes; write-through to Supabase. */
function resetSwingIfNeeded() {
  const monday = getMondayET();
  if (monday !== swingState.weekStart) {
    swingState.trades    = 0;
    swingState.pnl       = 0;
    swingState.weekStart = monday;
    weeklyPnl  = 0;
    weeklyHalt = false;
    writeManyBotState([
      ['swing_pnl',        '0'],
      ['swing_trades',     '0'],
      ['swing_week_start', monday],
      [getWeeklyPnlKey(),  JSON.stringify({ pct: 0, halt: false })],
    ]);
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

// ─── MACRO RISK ──────────────────────────────────────────────────────────────

const HIGH_IMPACT_KW = ['FOMC', 'Federal Reserve', 'CPI', 'Non-Farm', 'NFP', 'GDP', 'PCE', 'Unemployment', 'Interest Rate Decision', 'Jackson Hole'];

async function getMacroRisk() {
  if (macroRiskCache && (Date.now() - macroRiskCache.ts) < MACRO_RISK_CACHE_TTL) return macroRiskCache.result;

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) return { hasHighImpactToday: false, hasHighImpactTomorrow: false, events: [], nextEvent: null };

  try {
    const today    = toETDate();
    const to       = toETDate(new Date(Date.now() + 7 * 86400000));
    const ctrl     = new AbortController();
    const timer    = setTimeout(() => ctrl.abort(), 8000);
    let resp;
    try { resp = await fetch(`https://finnhub.io/api/v1/calendar/economic?from=${today}&to=${to}&token=${finnhubKey}`, { signal: ctrl.signal }); }
    finally { clearTimeout(timer); }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data   = await resp.json();
    const all    = data?.economicCalendar || [];
    const events = all.filter(e => {
      const hi  = e.impact === 'high' || (e.importance != null && e.importance >= 3);
      const kw  = HIGH_IMPACT_KW.some(k => (e.event || '').includes(k));
      return hi || kw;
    });

    const tomorrow         = toETDate(new Date(Date.now() + 86400000));
    const hasHighImpactToday    = events.some(e => (e.time || e.date || '').slice(0, 10) === today);
    const hasHighImpactTomorrow = events.some(e => (e.time || e.date || '').slice(0, 10) === tomorrow);
    const nextEvent = events.length
      ? { name: events[0].event, date: events[0].time || events[0].date, impact: 'high' }
      : null;

    const result = { hasHighImpactToday, hasHighImpactTomorrow, events, nextEvent };
    macroRiskCache = { ts: Date.now(), result };
    return result;
  } catch (err) {
    console.warn('[bot] MACRO_RISK fetch error:', err.message);
    return { hasHighImpactToday: false, hasHighImpactTomorrow: false, events: [], nextEvent: null };
  }
}

// ─── SECTOR ROTATION ─────────────────────────────────────────────────────────

/** Returns a map of ETF → 'leading'|'lagging'|'neutral' based on 30-day momentum. */
async function getSectorRotationBot() {
  if (sectorRotationBotCache && (Date.now() - sectorRotationBotCache.ts) < SECTOR_ROTATION_BOT_CACHE_TTL) {
    return sectorRotationBotCache.result;
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  const today    = toETDate();
  const fromDate = toETDate(new Date(Date.now() - 35 * 24 * 3600 * 1000));
  const etfs     = Object.keys(SECTOR_ETF_NAMES_BOT);

  const fetches = await Promise.all(etfs.map(async (etf) => {
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      let resp;
      try { resp = await fetch(`https://api.polygon.io/v2/aggs/ticker/${etf}/range/1/day/${fromDate}/${today}?adjusted=true&sort=asc&limit=30&apiKey=${apiKey}`, { signal: ctrl.signal }); }
      finally { clearTimeout(timer); }
      if (!resp.ok) return null;
      const data = await resp.json();
      const bars = data?.results;
      if (!Array.isArray(bars) || bars.length < 5) return null;
      const latest  = bars[bars.length - 1];
      const prev    = bars[bars.length - 2];
      const bar5ago = bars.length >= 6 ? bars[bars.length - 6] : bars[0];
      const r1d  = (latest.c - prev.c) / prev.c * 100;
      const r5d  = (latest.c - bar5ago.c) / bar5ago.c * 100;
      const r30d = (latest.c - bars[0].c) / bars[0].c * 100;
      return { etf, momentum: r1d * 0.2 + r5d * 0.3 + r30d * 0.5 };
    } catch { return null; }
  }));

  const valid = fetches.filter(Boolean).sort((a, b) => b.momentum - a.momentum);
  const n     = valid.length;
  const tagMap = {};
  valid.forEach((s, i) => { tagMap[s.etf] = i < 3 ? 'leading' : i >= n - 3 ? 'lagging' : 'neutral'; });

  sectorRotationBotCache = { ts: Date.now(), result: tagMap };
  console.log(`[bot] SECTOR_ROTATION loaded: leading=${valid.slice(0,3).map(s=>s.etf).join(',')}`);
  return tagMap;
}

// ─── 52-WEEK HIGH/LOW ────────────────────────────────────────────────────────

async function getWeek52Data(symbol) {
  const cacheKey = `w52:${symbol}`;
  const cached   = week52Cache[cacheKey];
  if (cached && (Date.now() - cached.ts) < WEEK52_CACHE_TTL) return cached.result;

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  const today    = toETDate();
  const fromDate = toETDate(new Date(Date.now() - 365 * 24 * 3600 * 1000));

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let resp;
    try { resp = await fetch(`https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${fromDate}/${today}?adjusted=true&sort=asc&limit=252&apiKey=${apiKey}`, { signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (!resp.ok) return null;

    const data = await resp.json();
    const bars = data?.results;
    if (!Array.isArray(bars) || bars.length < 10) return null;

    const week52High   = Math.max(...bars.map(b => b.h));
    const week52Low    = Math.min(...bars.map(b => b.l));
    const currentPrice = bars[bars.length - 1].c;
    const pctFrom52High = parseFloat(((currentPrice - week52High) / week52High * 100).toFixed(2));
    const pctFrom52Low  = parseFloat(((currentPrice - week52Low)  / week52Low  * 100).toFixed(2));
    const nearHigh = pctFrom52High > -1;
    const nearLow  = pctFrom52Low  < 5;

    const result = { week52High, week52Low, currentPrice, pctFrom52High, pctFrom52Low, nearHigh, nearLow };
    week52Cache[cacheKey] = { ts: Date.now(), result };
    console.log(`[bot] WEEK52 ${symbol}: high=${week52High.toFixed(2)} pctFromHigh=${pctFrom52High}%`);
    return result;
  } catch (err) {
    console.warn(`[bot] WEEK52 error for ${symbol}:`, err.message);
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
    pushLog(`OPTIONS_FLOW: ${symbol} score=${score} signal=${signal} volRatio=${volumeRatio.toFixed(3)} smartMoney=${smartMoney}`, score > 0 ? 'pass' : score < 0 ? 'warn' : 'info');
    return entry;
  } catch (err) {
    console.warn(`[bot] options flow error for ${symbol}:`, err.message);
    return null;
  }
}

// ─── PRE-MARKET GAP FUNCTIONS ────────────────────────────────────────────────

/**
 * Fetches the Polygon stock snapshot for `symbol` and computes the pre-market
 * gap versus the previous day's close.
 *
 * prevClose      = snapshot.ticker.prevDay.c
 * preMarketPrice = snapshot.ticker.day.o  (if market has opened)
 *                  OR snapshot.ticker.min.c (last-minute close, covers pre-market)
 * currentPrice   = snapshot.ticker.min.c  (used for gap-fade detection)
 * dayOpen        = snapshot.ticker.day.o  (null before market open)
 *
 * gapPct  = (preMarketPrice − prevClose) / prevClose × 100
 * gapType = "gap_up"   if gapPct >  1.5
 *           "gap_down" if gapPct < −1.5
 *           "flat"     otherwise
 *
 * Cached per symbol for 5 minutes.
 */
async function getPreMarketGap(symbol) {
  const cacheKey = `gap:${symbol}`;
  const cached = gapCache[cacheKey];
  if (cached && (Date.now() - cached.ts) < GAP_CACHE_TTL) {
    console.log(`[bot] gap cache hit for ${symbol}: gap=${cached.gapPct}% type=${cached.gapType}`);
    return cached;
  }

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) return null;

  const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${apiKey}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let resp;
    try { resp = await fetch(url, { signal: ctrl.signal }); }
    finally { clearTimeout(timer); }

    if (!resp.ok) {
      console.warn(`[bot] gap fetch HTTP ${resp.status} for ${symbol}`);
      return null;
    }

    const data = await resp.json();
    const ticker = data?.ticker;
    if (!ticker) return null;

    const prevClose      = ticker.prevDay?.c  ?? null;
    const dayOpen        = ticker.day?.o       ?? null;
    const minClose       = ticker.min?.c       ?? null;
    // Prefer actual open once market has opened; fall back to last-minute trade price
    const preMarketPrice = dayOpen || minClose || null;
    const currentPrice   = minClose;

    if (!prevClose || !preMarketPrice) return null;

    const gapPct = ((preMarketPrice - prevClose) / prevClose) * 100;
    const gapType = gapPct > 1.5 ? 'gap_up' : gapPct < -1.5 ? 'gap_down' : 'flat';

    const result = {
      ts: Date.now(),
      symbol,
      gapPct:         parseFloat(gapPct.toFixed(2)),
      prevClose,
      preMarketPrice: parseFloat(preMarketPrice.toFixed(4)),
      gapType,
      dayOpen,
      currentPrice,
    };
    gapCache[cacheKey] = result;
    console.log(`[bot] GAP_SCAN: ${symbol} gap=${gapPct.toFixed(2)}% type=${gapType}`);
    return result;
  } catch (err) {
    console.warn(`[bot] gap fetch error for ${symbol}:`, err.message);
    return null;
  }
}

// ─── NEWS INTELLIGENCE ───────────────────────────────────────────────────────

/**
 * Shared Claude helper for news analysis (bot-side copy — avoids cross-module import).
 * Returns the parsed JSON object/array or null on any failure.
 */
async function callClaudeForNews(prompt, maxTokens = 3000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
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
          model:      'claude-sonnet-4-6',
          max_tokens: maxTokens,
          messages:   [{ role: 'user', content: prompt }],
        }),
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!resp.ok) { console.warn('[bot/news] Claude HTTP', resp.status); return null; }
    const data = await resp.json();
    const text = data.content?.[0]?.text ?? '';
    const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    return m ? JSON.parse(m[0]) : null;
  } catch (err) {
    console.warn('[bot/news] Claude error:', err.message);
    return null;
  }
}

/**
 * Fetches and analyses the latest 50 Polygon news headlines.
 * Returns { headlines, marketPauseRecommended, pauseReason, highImpactCount,
 *           flashNewsItems, bullishSectors, bearishSectors, analyzedAt }
 * Cached 5 minutes.
 */
async function getBreakingNewsIntelligence() {
  if (breakingNewsBotCache && (Date.now() - breakingNewsBotCache.ts) < BREAKING_NEWS_BOT_CACHE_TTL) {
    return breakingNewsBotCache.result;
  }

  const key = process.env.POLYGON_API_KEY;
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!key) return null;

  // Fetch Polygon + Finnhub in parallel
  const [polyRes, finnRes] = await Promise.allSettled([
    (async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch(
          `https://api.polygon.io/v2/reference/news?limit=50&order=desc&sort=published_utc&apiKey=${key}`,
          { signal: ctrl.signal }
        );
        return r.ok ? r.json() : null;
      } finally { clearTimeout(t); }
    })(),
    finnhubKey
      ? (async () => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 6000);
          try {
            const r = await fetch(
              `https://finnhub.io/api/v1/news?category=general&token=${finnhubKey}`,
              { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal }
            );
            return r.ok ? r.json() : null;
          } finally { clearTimeout(t); }
        })()
      : Promise.resolve(null),
  ]);

  const polyItems = ((polyRes.status === 'fulfilled' ? polyRes.value?.results : null) ?? [])
    .map(n => ({ title: n.title, datetime: n.published_utc, source: n.publisher?.name ?? 'Polygon', tickers: n.tickers ?? [] }));
  const finnItems = (finnRes.status === 'fulfilled' && Array.isArray(finnRes.value) ? finnRes.value : [])
    .map(n => ({ title: n.headline, datetime: new Date(n.datetime * 1000).toISOString(), source: n.source ?? 'Finnhub', tickers: [] }));

  // Combine + deduplicate
  const seen = new Set();
  const combined = [];
  for (const item of [...polyItems, ...finnItems]) {
    if (!item.title) continue;
    const key2 = item.title.slice(0, 60).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!seen.has(key2)) { seen.add(key2); combined.push(item); }
  }
  combined.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  const top50 = combined.slice(0, 50);

  // Single Claude batch analysis
  const fallback = top50.map(() => ({
    impact: 'low', direction: 'neutral', affectedSectors: [], affectedSymbols: [],
    isGeopolitical: false, isFlashNews: false, pauseTrading: false, reason: 'unavailable',
  }));

  let analyses = fallback;
  if (top50.length > 0) {
    const headlineList = top50.map((h, i) => `${i + 1}. ${h.title}`).join('\n');
    const prompt = `You are a trading risk monitor. Analyze these ${top50.length} news headlines and return ONLY a valid JSON array (same order, no markdown):
[{"impact":"high"|"medium"|"low"|"none","direction":"bullish"|"bearish"|"neutral","affectedSectors":[],"affectedSymbols":[],"isGeopolitical":bool,"isFlashNews":bool,"pauseTrading":bool,"reason":"one sentence"}]
pauseTrading=true ONLY for: war/conflict escalation, major central bank surprise, circuit breaker trigger, sovereign default, pandemic declaration, major natural disaster.
Headlines:\n${headlineList}`;
    const parsed = await callClaudeForNews(prompt, 3000);
    if (Array.isArray(parsed)) {
      analyses = top50.map((_, i) => parsed[i] ?? fallback[i]);
    }
  }

  const headlines = top50.map((item, i) => ({ ...item, analysis: analyses[i] ?? fallback[i] }));
  const now10Min  = Date.now() - 10 * 60 * 1000;
  const highImpact = headlines.filter(h => h.analysis.impact === 'high');
  const marketPauseRecommended = headlines.some(h => h.analysis.pauseTrading);
  const flashNewsItems = headlines.filter(h =>
    h.analysis.impact === 'high' && h.analysis.isFlashNews && new Date(h.datetime).getTime() > now10Min
  );

  const sectorB = {}, sectorBear = {};
  for (const h of headlines) {
    const { direction, affectedSectors } = h.analysis;
    if (!Array.isArray(affectedSectors)) continue;
    for (const s of affectedSectors) {
      if (direction === 'bullish') sectorB[s] = (sectorB[s] ?? 0) + 1;
      if (direction === 'bearish') sectorBear[s] = (sectorBear[s] ?? 0) + 1;
    }
  }

  const result = {
    headlines,
    marketPauseRecommended,
    pauseReason: marketPauseRecommended ? (headlines.find(h => h.analysis.pauseTrading)?.title ?? 'Breaking news') : null,
    highImpactCount: highImpact.length,
    flashNewsItems:  flashNewsItems.map(h => ({ title: h.title, datetime: h.datetime, reason: h.analysis.reason })),
    bullishSectors:  Object.entries(sectorB).sort((a,b)=>b[1]-a[1]).map(([s])=>s),
    bearishSectors:  Object.entries(sectorBear).sort((a,b)=>b[1]-a[1]).map(([s])=>s),
    analyzedAt: new Date().toISOString(),
  };

  breakingNewsBotCache = { ts: Date.now(), result };
  console.log(`[bot/news] breaking: ${headlines.length} headlines, ${highImpact.length} high-impact, pause=${marketPauseRecommended}`);
  return result;
}

/**
 * Fetches 100 headlines from Polygon and asks Claude to assess geopolitical risk.
 * Returns { geoRiskScore, tradeWarRisk, conflictRisk, centralBankRisk,
 *           overallMarketRisk, keyThemes, recommendation, analyzedAt }
 * Cached 15 minutes.
 */
async function getGeoRiskIntelligence() {
  if (geoRiskBotCache && (Date.now() - geoRiskBotCache.ts) < GEO_RISK_BOT_CACHE_TTL) {
    return geoRiskBotCache.result;
  }

  const key = process.env.POLYGON_API_KEY;
  if (!key) return null;

  const fallback = {
    geoRiskScore: 30, tradeWarRisk: 20, conflictRisk: 20, centralBankRisk: 25,
    overallMarketRisk: 'low', keyThemes: ['Markets operating normally'],
    recommendation: 'trade normally', analyzedAt: new Date().toISOString(),
  };

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    let resp;
    try {
      resp = await fetch(
        `https://api.polygon.io/v2/reference/news?limit=100&order=desc&sort=published_utc&apiKey=${key}`,
        { signal: ctrl.signal }
      );
    } finally { clearTimeout(t); }
    if (!resp.ok) { geoRiskBotCache = { ts: Date.now(), result: fallback }; return fallback; }

    const data  = await resp.json().catch(() => ({}));
    const items = (data.results ?? []).map(n => n.title).filter(Boolean).slice(0, 100);
    if (items.length === 0) { geoRiskBotCache = { ts: Date.now(), result: fallback }; return fallback; }

    const prompt = `Analyze these ${items.length} recent financial news headlines and return ONLY valid JSON (no markdown):
{"geoRiskScore":<0-100>,"tradeWarRisk":<0-100>,"conflictRisk":<0-100>,"centralBankRisk":<0-100>,"overallMarketRisk":"low"|"elevated"|"high"|"extreme","keyThemes":["theme1","theme2","theme3"],"recommendation":"trade normally"|"reduce size"|"avoid new entries"|"exit all positions"}
Headlines: ${items.join(' | ')}`;

    const parsed = await callClaudeForNews(prompt, 400);
    const result = (parsed && !Array.isArray(parsed))
      ? {
          geoRiskScore:      Math.max(0, Math.min(100, Number(parsed.geoRiskScore) || 30)),
          tradeWarRisk:      Math.max(0, Math.min(100, Number(parsed.tradeWarRisk) || 20)),
          conflictRisk:      Math.max(0, Math.min(100, Number(parsed.conflictRisk) || 20)),
          centralBankRisk:   Math.max(0, Math.min(100, Number(parsed.centralBankRisk) || 25)),
          overallMarketRisk: ['low','elevated','high','extreme'].includes(parsed.overallMarketRisk) ? parsed.overallMarketRisk : 'low',
          keyThemes:         Array.isArray(parsed.keyThemes) ? parsed.keyThemes.slice(0,3).map(String) : fallback.keyThemes,
          recommendation:    ['trade normally','reduce size','avoid new entries','exit all positions'].includes(parsed.recommendation) ? parsed.recommendation : 'trade normally',
          analyzedAt:        new Date().toISOString(),
        }
      : fallback;

    geoRiskBotCache = { ts: Date.now(), result };
    console.log(`[bot/news] georisk: ${result.overallMarketRisk} score=${result.geoRiskScore} rec="${result.recommendation}"`);
    return result;
  } catch (err) {
    console.warn('[bot/news] georisk error:', err.message);
    geoRiskBotCache = { ts: Date.now(), result: fallback };
    return fallback;
  }
}

/**
 * Fetches Finnhub news for a specific symbol.
 * Returns { score, catalyst, summary } — same shape as getSymbolSentiment.
 */

/**
 * Fetch with a hard timeout. Returns parsed JSON or null on timeout/error.
 * Replaces direct fetch() calls inside the scan loop so a single slow Polygon
 * endpoint never holds the entire scan hostage.
 */
async function fetchWithTimeout(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return r.ok ? await r.json() : null;
  } catch (e) {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * Fetches RSI-14, MACD (12/26/9), EMA-60, and EMA-200 from Polygon for one symbol.
 * Returns { rsi, macdHist, ema60, ema200 } or nulls on any failure.
 * Uses fetchWithTimeout (3 s each) so stalled requests don't block the scan.
 */
async function fetchSymbolIndicators(symbol, key) {
  const base   = `https://api.polygon.io/v1/indicators`;

  const [rsiD, macdD, ema60D, ema200D] = await Promise.all([
    fetchWithTimeout(`${base}/rsi/${symbol}?timespan=day&adjusted=true&series_type=close&order=desc&limit=2&apiKey=${key}&window=14`, 3000),
    fetchWithTimeout(`${base}/macd/${symbol}?timespan=day&adjusted=true&series_type=close&order=desc&limit=2&apiKey=${key}&short_window=12&long_window=26&signal_window=9`, 3000),
    fetchWithTimeout(`${base}/ema/${symbol}?timespan=day&adjusted=true&series_type=close&order=desc&limit=3&apiKey=${key}&window=60`, 3000),
    fetchWithTimeout(`${base}/ema/${symbol}?timespan=day&adjusted=true&series_type=close&order=desc&limit=3&apiKey=${key}&window=200`, 3000),
  ]);

  return {
    rsi:      rsiD?.results?.values?.[0]?.value      ?? null,
    macdHist: macdD?.results?.values?.[0]?.histogram ?? null,
    ema60:    ema60D?.results?.values?.[0]?.value     ?? null,
    ema200:   ema200D?.results?.values?.[0]?.value    ?? null,
  };
}

/**
 * Autonomous full-universe scan: fetches indicators for each symbol in
 * SCAN_UNIVERSE, scores with resolveSignalScore, executes signals that pass.
 *
 * Processes in batches of 5 to avoid burst rate limits on Polygon.
 * Returns { symbolsScanned, signalsPassed, tradesPlaced, signals, durationMs }
 */
async function runFullScan(testMode = false) {
  const startMs = Date.now();
  const key = process.env.POLYGON_API_KEY;
  if (!key) throw new Error('POLYGON_API_KEY not configured');

  try { await ensureStateLoaded(); } catch(e) { pushLog('STATE_LOAD_ERROR: ' + e.message, 'warn'); }
  try { resetDayIfNeeded(); } catch(e) { pushLog('RESET_DAY_ERROR: ' + e.message, 'warn'); }
  try { resetSwingIfNeeded(); } catch(e) { pushLog('RESET_SWING_ERROR: ' + e.message, 'warn'); }

  // Ensure allocations are computed — uses fallback capital if not set
  if (dayState.allocation <= 0 || swingState.allocation <= 0) {
    pushLog('SCAN_FIX: allocations were zero, computing with $' + getEffectiveCapital(), 'warn');
    computeAllocations();
  }

  // ── 1. Build scan universe: SCAN_UNIVERSE + Supabase watchlist ──────────────
  let universe = [...SCAN_UNIVERSE];
  const sbUrl  = process.env.SUPABASE_URL;
  const sbHdrs = _sbHeaders();
  if (sbUrl && sbHdrs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      let wr;
      try { wr = await fetch(`${sbUrl}/rest/v1/watchlist?select=symbol`, { headers: sbHdrs, signal: ctrl.signal }); }
      finally { clearTimeout(t); }
      if (wr.ok) {
        const rows = await wr.json().catch(() => []);
        if (Array.isArray(rows)) {
          for (const r of rows) {
            const s = sanitizeSymbol(r.symbol || '');
            if (s && !universe.includes(s)) universe.push(s);
          }
        }
      }
    } catch {}
  }

  pushLog(`SCAN_START: ${universe.length} symbols (${SCAN_UNIVERSE.length} base + ${universe.length - SCAN_UNIVERSE.length} watchlist)`, 'info');

  // ── Pre-scan diagnostics ──────────────────────────────────────────────────
  pushLog(`PRE_SCAN: BOT_LIVE_TRADING=${process.env.BOT_LIVE_TRADING === 'true'}`, 'info');
  pushLog(`PRE_SCAN: symbols to scan=${universe.length}`, 'info');
  pushLog(`PRE_SCAN: market status=checking...`, 'info');
  pushLog(`PRE_SCAN: Alpaca connected=${process.env.ALPACA_API_KEY ? 'yes' : 'NO KEY FOUND'}`, 'info');
  if (testMode) pushLog('SCAN_TEST_MODE: market closed, signals evaluated but no orders placed', 'warn');

  // ── Pre-scan shared data: regime, macro risk, strategy weights ────────────
  // Must be computed BEFORE effectiveThreshold is derived below.
  let regime = { regime: 'neutral' };
  try { regime = await getMarketRegime(); } catch(e) { pushLog('REGIME_ERROR: ' + e.message, 'warn'); }

  let macroRisk = { hasHighImpactToday: false };
  try { macroRisk = await getMacroRisk(); } catch(e) { pushLog('MACRO_ERROR: ' + e.message, 'warn'); }

  let strategyWeights = null;
  try { strategyWeights = await getOptimizedStrategyWeights(); } catch(e) { pushLog('STRATEGY_WEIGHTS_ERROR: ' + e.message, 'warn'); }

  const threshold = macroRisk.hasHighImpactToday ? 85 : ENTRY_CONFIDENCE_THRESHOLD;

  // ── 2. News intelligence — Steps A, B, D (fetched once before any symbol eval) ─

  // Step A: Breaking news
  let newsHalt         = false;
  let newsThresholdAdj = 0;          // extra points added to entry threshold
  let sectorPenalties  = {};         // sector ETF → negative point penalty per symbol
  let sectorBoosts     = {};         // sector ETF → positive point boost per symbol
  let newsPauseReason  = null;

  const breakingNews = await getBreakingNewsIntelligence().catch(() => null);
  if (breakingNews) {
    if (breakingNews.marketPauseRecommended) {
      newsHalt = true;
      newsPauseReason = breakingNews.pauseReason ?? 'Breaking news';
      pushLog(`NEWS_HALT: trading paused — ${newsPauseReason}`, 'block');
      safeNotify(`BREAKING NEWS HALT: ${newsPauseReason}`, 'alert');
    }

    if (breakingNews.highImpactCount >= 3) {
      newsThresholdAdj += 10;
      pushLog(`NEWS_THRESHOLD: ${breakingNews.highImpactCount} high-impact headlines — raising threshold +10`, 'warn');
    }

    for (const sector of (breakingNews.bearishSectors ?? [])) {
      sectorPenalties[sector] = -15;
      pushLog(`NEWS_SECTOR_BEARISH: ${sector} -15 pts this scan cycle`, 'warn');
    }
    for (const sector of (breakingNews.bullishSectors ?? [])) {
      sectorBoosts[sector] = 10;
      pushLog(`NEWS_SECTOR_BULLISH: ${sector} +10 pts this scan cycle`, 'info');
    }

    // Step D: Flash news detection
    if (Array.isArray(breakingNews.flashNewsItems) && breakingNews.flashNewsItems.length > 0) {
      const flash = breakingNews.flashNewsItems[0];
      const haltUntil = Date.now() + 20 * 60 * 1000;
      flashHaltExpiry = haltUntil;
      writeBotState('flash_news_halt', String(haltUntil));
      newsHalt = true;
      pushLog(`FLASH_HALT: ${flash.title} — trading paused 20 minutes`, 'block');
      safeNotify(`FLASH NEWS: ${flash.title} — trading paused 20 minutes`, 'alert');
    } else if (flashHaltExpiry > Date.now()) {
      newsHalt = true;
      const minsLeft = Math.ceil((flashHaltExpiry - Date.now()) / 60000);
      pushLog(`FLASH_HALT: active (${minsLeft} min remaining) — no new entries`, 'warn');
    }
  }

  // Step B: Geo risk
  let geoSizeMultiplier = 1.0;
  const geoRisk = await getGeoRiskIntelligence().catch(() => null);
  if (geoRisk) {
    if (geoRisk.overallMarketRisk === 'extreme') {
      newsHalt = true;
      pushLog(`GEORISK_HALT: extreme geopolitical risk (score=${geoRisk.geoRiskScore}) — blocking all new entries`, 'block');
    } else if (geoRisk.overallMarketRisk === 'high') {
      geoSizeMultiplier = 0.5;
      newsThresholdAdj += 15;
      pushLog(`GEORISK_HIGH: position sizes -50%, threshold +15 (score=${geoRisk.geoRiskScore})`, 'warn');
    } else if (geoRisk.overallMarketRisk === 'elevated') {
      geoSizeMultiplier = 0.75;
      newsThresholdAdj += 5;
      pushLog(`GEORISK_ELEVATED: position sizes -25%, threshold +5 (score=${geoRisk.geoRiskScore})`, 'warn');
    }
  }

  // Effective threshold for this scan cycle
  const effectiveThreshold = threshold + newsThresholdAdj;

  if (newsHalt) {
    pushLog(`SCAN_END: 0 signals found, 0 trades placed — news/geo halt active`, 'warn');
    return {
      scannedAt: Date.now(), symbolsScanned: universe.length,
      signalsPassed: 0, tradesPlaced: 0,
      threshold: effectiveThreshold, regime: regime.regime,
      durationMs: Date.now() - startMs, session,
      newsHalt: true, newsPauseReason,
      geoRisk: geoRisk?.overallMarketRisk ?? 'unknown',
      signals: [],
    };
  }

  // ── 3. Shared pre-scan data (fetched once for all symbols) ──────────────────

  // Open Alpaca positions — used for duplicate-position guard and exposure total
  let openPositions = [];
  const alpacaKey    = process.env.ALPACA_API_KEY;
  const alpacaSecret = process.env.ALPACA_SECRET_KEY;
  if (alpacaKey && alpacaSecret) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      let pr;
      try {
        pr = await fetch(`${ALPACA_BASE}/v2/positions`, {
          headers: { 'APCA-API-KEY-ID': alpacaKey, 'APCA-API-SECRET-KEY': alpacaSecret, Accept: 'application/json' },
          signal: ctrl.signal,
        });
      } finally { clearTimeout(t); }
      if (pr.ok) openPositions = (await pr.json().catch(() => [])) || [];
    } catch {}
  }
  const totalExposure = openPositions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value || 0)), 0);

  // Session quality — evaluated once for the whole scan cycle
  let session = 'normal';
  try { session = getSessionQuality(); } catch(e) { pushLog('SESSION_ERROR: ' + e.message, 'warn'); }
  if (session === 'avoid' || session === 'close') {
    pushLog(`SCAN_END: 0 signals found, 0 trades placed — session zone "${session}" blocks new entries`, 'warn');
    return {
      scannedAt: Date.now(), symbolsScanned: universe.length,
      signalsPassed: 0, tradesPlaced: 0, threshold: effectiveThreshold, regime: regime.regime,
      durationMs: Date.now() - startMs, session, signals: [],
    };
  }
  // session prime/lunch applies scoring bonus/penalty inside resolveSignalScore
  const sessionPrime = session === 'prime' ? true : session === 'lunch' ? false : null;

  const results = [];
  let signalsPassed = 0;
  let tradesPlaced  = 0;

  // ── 3. Per-symbol evaluation in batches of 5 ────────────────────────────────
  const BATCH = 5;
  for (let i = 0; i < universe.length; i += BATCH) {
    // ── 8 s global scan timeout warning ──────────────────────────────────────
    if (Date.now() - startMs > 8000) {
      pushLog(`SCAN_TIMEOUT_WARNING: approaching time limit, stopping early at ${universe[i]}`, 'warn');
      break;
    }

    const batch = universe.slice(i, i + BATCH);
    const batchResults = await Promise.allSettled(
      batch.map(async (symbol) => {
        try {
        const symbolStartMs = Date.now();

        // Hard guards — skip immediately (no API calls)
        if (killSwitch || weeklyHalt)
          return { symbol, skipped: true, reason: killSwitch ? 'kill_switch' : 'weekly_halt' };
        if (openPositions.some(p => sanitizeSymbol(p.symbol) === symbol))
          return { symbol, skipped: true, reason: 'position_exists' };
        if (isStoppedOut(symbol))
          return { symbol, skipped: true, reason: 'stopped_out' };
        if (regime.regime === 'crisis')
          return { symbol, skipped: true, reason: 'crisis_regime' };

        // ── Phase 1: Quote only (1 call, 3 s timeout) ────────────────────────
        const sd = await fetchWithTimeout(
          `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}?apiKey=${key}`,
          3000
        );
        const ticker       = sd?.ticker;
        const currentPrice = ticker?.day?.c ?? ticker?.prevDay?.c ?? null;
        const currentVolume = ticker?.day?.v ?? null;
        if (!currentPrice) return { symbol, skipped: true, reason: 'price_unavailable' };

        if (Date.now() - symbolStartMs > 4000) {
          pushLog(`TIMEOUT_SKIP: ${symbol}`, 'warn');
          return { symbol, skipped: true, reason: 'timeout' };
        }

        // ── Phase 2: Indicators (4 calls in parallel, 3 s each) ──────────────
        const ind = await fetchSymbolIndicators(symbol, key)
          .catch(() => ({ rsi: null, macdHist: null, ema60: null, ema200: null }));

        const rsiVal   = ind.rsi;
        const macdHist = ind.macdHist;
        const ema60v   = ind.ema60;
        const ema200v  = ind.ema200;

        // Determine direction: EMA alignment takes priority over MACD histogram
        let direction = null;
        if (ema60v != null && ema200v != null) {
          direction = ema60v > ema200v ? 'LONG' : 'SHORT';
        } else if (macdHist != null) {
          direction = macdHist > 0 ? 'LONG' : 'SHORT';
        }
        if (!direction) return { symbol, skipped: true, reason: 'no_direction' };

        // Early exit: neither EMA nor MACD aligns with direction — skip deeper calls
        const emaAligned  = ema60v != null && ema200v != null &&
          (direction === 'LONG' ? ema60v > ema200v : ema60v < ema200v);
        const macdAligned = macdHist != null &&
          (direction === 'LONG' ? macdHist > 0 : macdHist < 0);
        if (!emaAligned && !macdAligned) {
          return { symbol, skipped: true, reason: 'low_score' };
        }

        if (Date.now() - symbolStartMs > 4000) {
          pushLog(`TIMEOUT_SKIP: ${symbol}`, 'warn');
          return { symbol, skipped: true, reason: 'timeout' };
        }

        // ── Phase 3: Deep checks — VWAP + daily trend + volume (parallel) ────
        const isMacdCrossover = macdHist != null && (
          (direction === 'LONG'  && macdHist > 0 && ind.macdHistPrev != null && ind.macdHistPrev <= 0) ||
          (direction === 'SHORT' && macdHist < 0 && ind.macdHistPrev != null && ind.macdHistPrev >= 0)
        );
        const [dailyTrendResult, volDataResult, vwapDataResult] = await Promise.allSettled([
          checkDailyTrend(symbol).catch(() => null),
          currentVolume != null
            ? checkVolumeConfirmation(symbol, currentVolume, 'day', isMacdCrossover).catch(() => null)
            : Promise.resolve(null),
          calculateVWAP(symbol).catch(() => null),
        ]);
        const dailyTrend = dailyTrendResult.status === 'fulfilled' ? dailyTrendResult.value : null;
        const volData    = volDataResult.status    === 'fulfilled' ? volDataResult.value    : null;
        const vwapData   = vwapDataResult.status   === 'fulfilled' ? vwapDataResult.value   : null;

        const dailyTrendAligned = dailyTrend
          ? (direction === 'LONG' ? dailyTrend.bullish : dailyTrend.bearish)
          : null;
        const volumeConfirmed = volData ? volData.confirmed : null;
        const aboveVwap = vwapData
          ? (direction === 'LONG' ? vwapData.aboveVwap : !vwapData.aboveVwap)
          : null;

        // ── 3f. resolveSignalScore — composite NZR score ─────────────────────
        const macdCross     = macdHist != null ? (direction === 'LONG' ? macdHist > 0 : macdHist < 0) : null;
        const rsiNotExtreme = rsiVal   != null ? (rsiVal >= 30 && rsiVal <= 70) : null;
        const emaAlignment  = (ema60v != null && ema200v != null)
          ? (direction === 'LONG' ? ema60v > ema200v : ema60v < ema200v)
          : null;

        const baseComposite = resolveSignalScore(symbol, direction, {
          macdCross, rsiNotExtreme, emaAlignment, dailyTrendAligned,
          volumeConfirmed, aboveVwap, sessionPrime, regimeOk: true,
          strategyWeights: strategyWeights
            ? { MACD: strategyWeights.MACD, RSI: strategyWeights.RSI,
                EMA2050: strategyWeights.EMA2050, EMA60200: strategyWeights.EMA60200,
                COMBINED: strategyWeights.COMBINED }
            : null,
        }, 'day');

        // Apply sector-level news boost/penalty
        const symbolSector = sectorMap[symbol] ?? null;
        let sectorAdj = 0;
        if (symbolSector) {
          sectorAdj += sectorPenalties[symbolSector] ?? 0;
          sectorAdj += sectorBoosts[symbolSector]    ?? 0;
        }
        const roughScore = baseComposite.score + sectorAdj;
        if (sectorAdj !== 0) {
          pushLog(`NEWS_SECTOR_ADJ: ${symbol} (${symbolSector}) score ${baseComposite.score} → ${roughScore} (${sectorAdj > 0 ? '+' : ''}${sectorAdj} news adj)`, 'info');
        }

        if (Date.now() - symbolStartMs > 4000) {
          pushLog(`TIMEOUT_SKIP: ${symbol}`, 'warn');
          return { symbol, skipped: true, reason: 'timeout' };
        }

        // ── Phase 4: Sentiment — only if score has potential ─────────────────
        // Skipped when score is well below threshold to cut Claude API calls
        let sentimentScore = 0;
        let topHeadline    = null;
        if (roughScore >= 60) {
          const sentimentData = await getSymbolSentiment(symbol).catch(() => null);
          sentimentScore = sentimentData?.score ?? 0;
          topHeadline = breakingNews?.headlines?.find(h =>
            Array.isArray(h.tickers) && h.tickers.includes(symbol)
          )?.title ?? null;
        }

        const composite = { ...baseComposite, score: roughScore };
        const passed = !composite.blocked && composite.score >= effectiveThreshold;

        const newsContext = {
          geoRiskLevel: geoRisk?.overallMarketRisk ?? 'unknown',
          sentimentScore,
          sectorAdj:    sectorAdj !== 0 ? { sector: symbolSector, points: sectorAdj } : null,
          topHeadline,
          analyzedAt:   breakingNews?.analyzedAt ?? null,
        };

        const entry = {
          symbol, direction,
          score:        composite.score,
          passed,
          blocked:      composite.blocked,
          reason:       composite.blockReason ?? (passed ? null : `score ${composite.score} < threshold ${effectiveThreshold}`),
          rsi:          rsiVal != null  ? parseFloat(rsiVal.toFixed(2))  : null,
          ema60:        ema60v != null  ? parseFloat(ema60v.toFixed(2))  : null,
          ema200:       ema200v != null ? parseFloat(ema200v.toFixed(2)) : null,
          volume:       currentVolume,
          vwap:         vwapData?.vwap ?? null,
          session,
          sentimentScore,
          geoRiskLevel: geoRisk?.overallMarketRisk ?? 'unknown',
          executed:     false,
          orderId:      null,
        };

        if (!passed) return entry;

        // ── 3g. Pre-execution risk checks (unchanged) ─────────────────────────
        // Ensure allocations are computed (uses fallback capital if not set)
        if (dayState.allocation <= 0 || dayState.maxPositionSize <= 0) computeAllocations();
        if (dayState.pnl <= dayState.maxDailyLoss)    return { ...entry, reason: 'daily_loss_limit' };
        if (dayState.trades >= dayState.maxTradesDay) return { ...entry, reason: 'max_trades' };
        const cd = checkCooldown(symbol, 'day', dayState.cooldownMin * 60 * 1000);
        if (!cd.ok)                                   return { ...entry, reason: `cooldown_${cd.remaining}s` };
        if (currentExposureExceeds(totalExposure, dayState.maxExposure))
                                                      return { ...entry, reason: 'max_exposure' };

        // ── 3h. executeSignal ─────────────────────────────────────────────────
        const effectiveDayAlloc = dayState.allocation > 0 ? dayState.allocation : getEffectiveCapital() * 0.4;
        const effectiveDayMaxPos = dayState.maxPositionSize > 0 ? dayState.maxPositionSize : effectiveDayAlloc * 0.10;
        const positionSize = Math.min(effectiveDayMaxPos, effectiveDayAlloc * 0.10) * geoSizeMultiplier;
        const atrStop      = await getATRStop(symbol, 'day', currentPrice, direction).catch(() => null);
        const stopPrice    = atrStop?.stopPrice
          ?? roundLimitPrice(direction === 'LONG' ? currentPrice * 0.985 : currentPrice * 1.015);
        const target1      = atrStop?.target1
          ?? roundLimitPrice(direction === 'LONG' ? currentPrice * 1.025 : currentPrice * 0.975);
        const atr          = atrStop?.atr ?? currentPrice * 0.015;

        const signal = {
          symbol, direction, mode: 'day', strategy: 'SCAN',
          nrzScore:   composite.score,
          entryPrice: parseFloat(currentPrice.toFixed(2)),
          stopPrice:  parseFloat(stopPrice.toFixed(2)),
          target1:    parseFloat(target1.toFixed(2)),
          positionSize, atr,
        };

        let execResult;
        if (testMode) {
          pushLog(`SCAN_TEST_MODE: ${symbol} NZR=${composite.score} — no order (market closed)`, 'info');
          execResult = { executed: false, reason: 'test_mode' };
        } else {
          execResult = await executeSignal(signal, newsContext)
            .catch(e => ({ executed: false, reason: e.message }));
        }

        if (execResult.executed) {
          tradesPlaced++;
          dayState.trades++;
          writeBotState('day_trades', String(dayState.trades));
          recentOrders.set(`day:${symbol}`, { timestamp: Date.now() });
          pushLog(`SCAN_TRADE: ${symbol} ${direction} NZR=${composite.score} @ $${currentPrice.toFixed(2)} stop=$${stopPrice.toFixed(2)} geo=${geoRisk?.overallMarketRisk ?? 'n/a'} sent=${sentimentScore}`, 'pass');
        }

        return { ...entry, executed: execResult.executed, orderId: execResult.orderId ?? null, reason: execResult.reason ?? null };
        } catch (e) {
          pushLog(`SCAN_ERROR: ${symbol} — ${e.message}`, 'warn');
          return { symbol, skipped: true, reason: `error: ${e.message}` };
        }
      })
    );

    for (const r of batchResults) {
      const val = r.status === 'fulfilled' ? r.value : { symbol: '?', error: r.reason?.message };
      if (val && !val.skipped) results.push(val);
      if (val?.passed) signalsPassed++;
    }
  }

  const durationMs = Date.now() - startMs;
  pushLog(`SCAN_END: ${signalsPassed} signals found, ${tradesPlaced} trades placed — ${universe.length} symbols in ${(durationMs / 1000).toFixed(1)}s geo=${geoRisk?.overallMarketRisk ?? 'n/a'}`, 'info');

  // Persist result so the ?type=scanresult endpoint can serve it without re-running
  const scanPayload = {
    success: true, symbolsScanned: universe.length, signalsPassed, tradesPlaced,
    durationMs, threshold: effectiveThreshold, regime: regime.regime, session,
    geoRisk: geoRisk?.overallMarketRisk ?? 'unknown', geoRiskScore: geoRisk?.geoRiskScore ?? null,
    newsThresholdAdj, scannedAt: Date.now(), completedAt: new Date().toISOString(),
    signals: results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
  };
  writeBotState('last_scan_result', JSON.stringify(scanPayload));

  return scanPayload;
}

/** Helper for runFullScan: checks if totalExposure is at or above the max. */
function currentExposureExceeds(totalExposure, maxExposure) {
  return isFinite(totalExposure) && isFinite(maxExposure) && totalExposure >= maxExposure;
}

/**
 * Scans all SCREENER_WATCHLIST symbols for pre-market gaps.
 * Intended for the 8:00–9:30 AM ET pre-market window, but also returns
 * results during the first 2 hours of the session (9:30–11:30 AM ET).
 *
 * Returns { scannedAt, etMin, symbolCount, candidates: [{...gap, tag}] }
 * where tag is one of: "STRONG_GAP_UP" | "GAP_UP_PLAY" | "GAP_DOWN_SHORT"
 *
 * Fetches in batches of 8 to stay well under Polygon's burst rate limits.
 */
async function runGapScan() {
  const now   = new Date();
  const etMin = getETMinuteOfDay(now);

  // Available 8:00 AM ET through end of gap window (11:30 AM ET)
  if (etMin < 8 * 60 || etMin >= 11 * 60 + 30) {
    return {
      error:    'Gap scan available 8:00–11:30 AM ET only',
      etMin,
      isPreMarket: etMin >= 8 * 60 && etMin < 9 * 60 + 30,
    };
  }

  const isPreMarket = etMin < 9 * 60 + 30;

  // Build scan universe: hardcoded base + user watchlist from Supabase
  let universe = [...SCAN_UNIVERSE];
  try {
    const url  = process.env.SUPABASE_URL;
    const hdrs = _sbHeaders();
    if (url && hdrs) {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      let wResp;
      try { wResp = await fetch(`${url}/rest/v1/watchlist?select=symbol`, { headers: hdrs, signal: ctrl.signal }); }
      finally { clearTimeout(timer); }
      if (wResp.ok) {
        const wRows = await wResp.json();
        if (Array.isArray(wRows)) {
          for (const r of wRows) {
            const s = sanitizeSymbol(r.symbol);
            if (s && !universe.includes(s)) universe.push(s);
          }
        }
      }
    }
  } catch {}
  console.log(`[bot] GAP_SCAN universe: ${universe.length} symbols (${SCAN_UNIVERSE.length} base + extras)`);

  const BATCH = 8;
  const allResults = [];

  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH);
    const settled = await Promise.allSettled(batch.map(sym => getPreMarketGap(sym)));
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value) allResults.push(r.value);
    }
  }

  const candidates = allResults
    .filter(r => r.gapType !== 'flat')
    .map(r => {
      const abs = Math.abs(r.gapPct);
      let tag = null;
      if      (r.gapType === 'gap_up'   && abs >= 4) tag = 'STRONG_GAP_UP';
      else if (r.gapType === 'gap_up'   && abs >= 2) tag = 'GAP_UP_PLAY';
      else if (r.gapType === 'gap_down' && abs >= 2) tag = 'GAP_DOWN_SHORT';
      return tag ? { ...r, tag } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));

  console.log(`[bot] GAP_SCAN complete: ${allResults.length} symbols scanned, ${candidates.length} candidates`);
  return { scannedAt: Date.now(), etMin, isPreMarket, symbolCount: allResults.length, candidates };
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

// ─── STRATEGY PERFORMANCE OPTIMIZER ─────────────────────────────────────────

/**
 * Queries the last 50 closed bot trades from Supabase, parses the strategy name
 * from the notes field (format: "Bot: MACD NZR=82"), computes per-strategy
 * win rate / avg P&L / score, normalises into weights summing to 1.0.
 *
 * Rules:
 *  - < 5 trades for a strategy → neutral weight seed of 0.2
 *  - avgPnl < −1% → weight capped at 0.05 before normalisation
 *  - winRate > 60% AND avgPnl > 1% → score boosted 1.5× before normalisation
 *
 * Returns { MACD, RSI, EMA2050, EMA60200, COMBINED, perfStats, computedAt, tradeCount }
 * Cached for 4 hours.
 */
async function getOptimizedStrategyWeights() {
  if (strategyWeightsCache && (Date.now() - strategyWeightsCache.ts) < STRATEGY_WEIGHTS_CACHE_TTL) {
    console.log('[bot] STRATEGY_WEIGHTS cache hit');
    return strategyWeightsCache.result;
  }

  const STRATEGIES = ['MACD', 'RSI', 'EMA2050', 'EMA60200', 'COMBINED'];
  const neutral = {
    MACD: 0.2, RSI: 0.2, EMA2050: 0.2, EMA60200: 0.2, COMBINED: 0.2,
    perfStats: Object.fromEntries(STRATEGIES.map(s => [s, { trades: 0, winRate: null, avgPnl: null }])),
    computedAt: null,
    tradeCount: 0,
  };

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return neutral;

  try {
    // Fetch last 50 trades — no strategy filter, include open trades
    const { data: trades, error: tradeErr } = await supabase
      .from('journal')
      .select('symbol, pnl_pct, notes, trade_date')
      .not('pnl_pct', 'is', null)
      .order('trade_date', { ascending: false })
      .limit(50);

    if (tradeErr) throw new Error('Supabase: ' + tradeErr.message);
    if (!Array.isArray(trades)) throw new Error('Unexpected response shape');

    // If fewer than 5 closed trades, also count open trades for tradeCount
    let totalTradeCount = trades.length;
    if (trades.length < 5) {
      const { data: openTrades } = await supabase
        .from('journal')
        .select('id')
        .is('pnl_pct', null)
        .limit(50);
      totalTradeCount = trades.length + (openTrades ? openTrades.length : 0);
    }

    // ── Parse strategy from notes field ────────────────────────────────────
    function parseStrategy(notes) {
      if (!notes) return 'COMBINED';
      const n = notes.toUpperCase();
      if (n.includes('MACD'))                          return 'MACD';
      if (n.includes('RSI'))                           return 'RSI';
      if (n.includes('EMA2050') || n.includes('EMA 20/50'))   return 'EMA2050';
      if (n.includes('EMA60200') || n.includes('EMA 60/200')) return 'EMA60200';
      if (n.includes('COMBINED'))                      return 'COMBINED';
      if (n.includes('BACKFILLED') || n.includes('BOT:'))     return 'COMBINED';
      return 'COMBINED';
    }

    // ── Aggregate per strategy ──────────────────────────────────────────────
    const agg = {};
    for (const s of STRATEGIES) agg[s] = { wins: 0, total: 0, sumPnl: 0 };

    for (const t of trades) {
      const pnl = parseFloat(t.pnl_pct);
      if (!isFinite(pnl)) continue;
      const s = parseStrategy(t.notes);
      if (!agg[s]) continue;
      agg[s].total++;
      agg[s].sumPnl += pnl;
      if (pnl > 0) agg[s].wins++;
    }

    // ── Compute raw weights ─────────────────────────────────────────────────
    const rawWeights = {};
    const perfStats  = {};

    for (const s of STRATEGIES) {
      const st = agg[s];
      const winRate = st.total > 0 ? st.wins / st.total : null;
      const avgPnl  = st.total > 0 ? st.sumPnl / st.total : null;

      perfStats[s] = {
        trades:  st.total,
        winRate: winRate != null ? parseFloat((winRate * 100).toFixed(1)) : null,
        avgPnl:  avgPnl  != null ? parseFloat(avgPnl.toFixed(3))         : null,
      };

      if (st.total < 5) {
        rawWeights[s] = 0.2;           // insufficient data — neutral seed
      } else if (avgPnl < -1) {
        rawWeights[s] = 0.05;          // severely underperforming — cap
      } else {
        let score = winRate * avgPnl;
        if (winRate > 0.6 && avgPnl > 1) score *= 1.5; // outperformance boost
        rawWeights[s] = Math.max(0.01, score);          // floor so it stays in the mix
      }
    }

    // ── Normalise to sum to 1.0 ─────────────────────────────────────────────
    const total   = Object.values(rawWeights).reduce((a, b) => a + b, 0);
    const weights = {};
    for (const s of STRATEGIES) {
      weights[s] = total > 0 ? parseFloat((rawWeights[s] / total).toFixed(4)) : 0.2;
    }

    const result = {
      ...weights,
      perfStats,
      computedAt: new Date().toISOString(),
      tradeCount: totalTradeCount,
    };
    strategyWeightsCache = { ts: Date.now(), result };
    console.log(`[bot] STRATEGY_WEIGHTS computed from ${trades.length} trades (total=${totalTradeCount}): ${STRATEGIES.map(s => `${s}=${weights[s]}`).join(' ')}`);
    return result;
  } catch (err) {
    console.warn('[bot] STRATEGY_WEIGHTS error:', err.message);
    return neutral;
  }
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

// ─── WEIGHTED SIGNAL SCORER ──────────────────────────────────────────────────

/**
 * Combines all available trade signals into a single transparent NZR composite
 * score.  Hard requirements (volume, daily trend alignment for day trades, regime)
 * short-circuit immediately and return blocked=true.  Everything else is additive.
 *
 * Max theoretical score (all signals positive):
 *   30+20+20+20+15+15+10+10+10+20+20 = 190
 * Entry threshold: score >= 70
 *
 * @param {string} symbol
 * @param {'LONG'|'SHORT'} direction
 * @param {object} inputs   — all fields optional/nullable
 * @param {'day'|'swing'}  mode
 * @returns {{ score:number, blocked:boolean, blockReason:string|null, breakdown:object }}
 */
function resolveSignalScore(symbol, direction, inputs, mode) {
  const bd  = {};   // breakdown (key → points contributed, null = signal unavailable)
  let score = 0;

  // ── Hard requirements ────────────────────────────────────────────────────────
  // Check these BEFORE adding any positive points so the reason is always clear.

  if (inputs.regimeOk === false) {
    pushLog(`REGIME_BLOCK: ${symbol} market regime does not allow new entries`, 'block');
    return { score: 0, blocked: true, blockReason: 'REGIME_BLOCK: market regime does not allow new entries', breakdown: bd };
  }

  if (inputs.volumeConfirmed === false) {
    pushLog(`VOLUME_GATE: ${symbol} insufficient volume — hard requirement not met`, 'block');
    return { score: 0, blocked: true, blockReason: 'VOLUME_GATE: insufficient volume — hard requirement not met', breakdown: bd };
  }

  if (mode === 'day' && inputs.dailyTrendAligned === false) {
    pushLog(`MTF_CONFLICT: ${symbol} daily trend not aligned for day trade`, 'block');
    return { score: 0, blocked: true, blockReason: 'MTF_CONFLICT: daily trend alignment is a hard requirement for day trades', breakdown: bd };
  }

  // ── Per-strategy weight multipliers (neutral weight = 0.2 → multiplier 1.0) ─
  // Passed via inputs.strategyWeights from getOptimizedStrategyWeights().
  // A strategy with weight 0.4 gets a 2× multiplier vs neutral 0.2.
  const wm      = inputs.strategyWeights || {};
  const wMACD   = wm.MACD     != null ? wm.MACD     / 0.2 : 1.0;
  const wRSI    = wm.RSI      != null ? wm.RSI      / 0.2 : 1.0;
  const wE6200  = wm.EMA60200 != null ? wm.EMA60200 / 0.2 : 1.0;
  const wE2050  = wm.EMA2050  != null ? wm.EMA2050  / 0.2 : 1.0;
  const wCOMB   = wm.COMBINED != null ? wm.COMBINED / 0.2 : 1.0;

  // ── Weighted contributions ───────────────────────────────────────────────────

  // MACD crossover confirmed: base +30 scaled by MACD weight
  {
    const base = Math.round(30 * wMACD);
    if      (inputs.macdCross === true)  { bd.macdCross = +base; score += base; }
    else if (inputs.macdCross === false) { bd.macdCross =     0; }
    else                                 { bd.macdCross =  null; }
  }

  // RSI not extreme (30–70): base +20; extreme: base −20; scaled by RSI weight
  {
    const base = Math.round(20 * wRSI);
    if      (inputs.rsiNotExtreme === true)  { bd.rsiNotExtreme = +base; score += base; }
    else if (inputs.rsiNotExtreme === false) { bd.rsiNotExtreme = -base; score -= base; }
    else                                     { bd.rsiNotExtreme =  null; }
  }

  // EMA alignment (EMA60 vs EMA200): base +20, scaled by EMA60200 weight
  {
    const base = Math.round(20 * wE6200);
    if      (inputs.emaAlignment === true)  { bd.emaAlignment = +base; score += base; }
    else if (inputs.emaAlignment === false) { bd.emaAlignment =     0; }
    else                                    { bd.emaAlignment =  null; }
  }

  // Volume confirmed: base +20, scaled by COMBINED weight (hard requirement already cleared)
  {
    const base = Math.round(20 * wCOMB);
    if      (inputs.volumeConfirmed === true) { bd.volumeConfirmed = +base; score += base; }
    else                                      { bd.volumeConfirmed = inputs.volumeConfirmed === null ? null : 0; }
  }

  // VWAP alignment (day trades only): base +15, scaled by COMBINED weight
  if (mode === 'day') {
    const base = Math.round(15 * wCOMB);
    if      (inputs.aboveVwap === true)  { bd.aboveVwap = +base; score += base; }
    else if (inputs.aboveVwap === false) { bd.aboveVwap =     0; }
    else                                 { bd.aboveVwap =  null; }
  } else {
    bd.aboveVwap = null; // N/A for swing
  }

  // Daily trend aligned: base +15, scaled by EMA2050 weight
  // (hard block only for day — swing is soft)
  {
    const base = Math.round(15 * wE2050);
    if      (inputs.dailyTrendAligned === true)  { bd.dailyTrendAligned = +base; score += base; }
    else if (inputs.dailyTrendAligned === false) { bd.dailyTrendAligned =     0; }
    else                                         { bd.dailyTrendAligned =  null; }
  }

  // Weekly trend aligned (swing mode only): +10 if aligned, −5 if not; EMA2050 weight
  if (mode === 'swing' && inputs.weeklyTrendAligned != null) {
    const pts = inputs.weeklyTrendAligned
      ? Math.round(10 * wE2050)
      : -Math.round(5 * wE2050);
    bd.weeklyTrendAligned = pts; score += pts;
  } else {
    bd.weeklyTrendAligned = null;
  }

  // Session quality (day trades): prime → base +10, lunch → base −10; COMBINED weight
  {
    const base = Math.round(10 * wCOMB);
    if      (inputs.sessionPrime === true)  { bd.sessionPrime = +base; score += base; }
    else if (inputs.sessionPrime === false) { bd.sessionPrime = -base; score -= base; }
    else                                    { bd.sessionPrime =  null; }
  }

  // News sentiment: −10..+10 scaled by COMBINED weight
  if (inputs.sentimentScore != null) {
    const raw = Math.max(-10, Math.min(10, Math.round(inputs.sentimentScore)));
    const pts = raw >= 0 ? Math.round(raw * wCOMB) : -Math.round(Math.abs(raw) * wCOMB);
    bd.sentimentScore = pts; score += pts;
  } else {
    bd.sentimentScore = null;
  }

  // Relative strength vs SPY: ±10 base scaled by COMBINED weight
  if (inputs.relativeStrength != null) {
    let rsBase = 0;
    if (direction === 'LONG') {
      if      (inputs.relativeStrength > 1.5) rsBase = +10;
      else if (inputs.relativeStrength < 0.8) rsBase = -10;
    } else {
      if      (inputs.relativeStrength < 0.5) rsBase = +10;
      else if (inputs.relativeStrength > 1.2) rsBase = -10;
    }
    const rsPoints = rsBase >= 0 ? Math.round(rsBase * wCOMB) : -Math.round(Math.abs(rsBase) * wCOMB);
    bd.relativeStrength = rsPoints; score += rsPoints;
  } else {
    bd.relativeStrength = null;
  }

  // Options flow: −20..+20 scaled by COMBINED weight
  if (inputs.optionsFlowScore != null) {
    const raw = Math.max(-20, Math.min(20, Math.round(inputs.optionsFlowScore)));
    const pts = raw >= 0 ? Math.round(raw * wCOMB) : -Math.round(Math.abs(raw) * wCOMB);
    bd.optionsFlowScore = pts; score += pts;
  } else {
    bd.optionsFlowScore = null;
  }

  // Gap boost: scaled by COMBINED weight
  if (inputs.gapBoost != null) {
    const pts = inputs.gapBoost >= 0
      ? Math.round(inputs.gapBoost * wCOMB)
      : -Math.round(Math.abs(inputs.gapBoost) * wCOMB);
    bd.gapBoost = pts; score += pts;
  } else {
    bd.gapBoost = null;
  }

  // Sector rotation: ±10 base scaled by COMBINED weight
  if (inputs.sectorTag != null) {
    let sectorBase = 0;
    if      (inputs.sectorTag === 'leading') sectorBase = direction === 'LONG' ? +10 : -5;
    else if (inputs.sectorTag === 'lagging') sectorBase = direction === 'LONG' ? -10 : +10;
    const sectorPts = sectorBase >= 0
      ? Math.round(sectorBase * wCOMB)
      : -Math.round(Math.abs(sectorBase) * wCOMB);
    bd.sectorRotation = sectorPts; score += sectorPts;
  } else {
    bd.sectorRotation = null;
  }

  // 52-week proximity scoring scaled by COMBINED weight
  {
    let w52Base = 0;
    const pctHigh = inputs.pctFrom52High ?? null;
    if (inputs.nearHigh === true) {
      w52Base = direction === 'LONG' ? +15 : -15;
    } else if (pctHigh !== null && pctHigh >= -5 && pctHigh <= -1) {
      if (direction === 'LONG') w52Base = +8;
    }
    if (inputs.nearLow === true && inputs.rsiValue != null && inputs.rsiValue < 35 && direction === 'LONG') {
      w52Base += +15;
    }
    const w52Pts = w52Base >= 0
      ? Math.round(w52Base * wCOMB)
      : -Math.round(Math.abs(w52Base) * wCOMB);
    bd.week52 = w52Base !== 0 ? w52Pts : (inputs.nearHigh != null ? 0 : null);
    if (w52Pts !== 0) score += w52Pts;
  }

  const available = Object.values(bd).filter(v => v !== null).length;
  const bkStr = Object.entries(bd)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}:${v > 0 ? '+' : ''}${v}`)
    .join(' ');
  console.log(`[bot] SIGNAL_SCORE: ${symbol} ${direction} mode=${mode} score=${score} (${available} signals) — ${bkStr}`);

  return { score, blocked: false, blockReason: null, breakdown: bd };
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

// ─── DYNAMIC POSITION MANAGEMENT ─────────────────────────────────────────────

/**
 * Runs every scan cycle BEFORE evaluating new signals.
 * Fetches all open Alpaca positions, evaluates fresh indicators, and makes
 * close / hold / trail-stop decisions.  Also cancels stale open orders.
 *
 * Returns { positionsManaged, closed, held, trailUpdated, staleOrdersCancelled,
 *           openCount, totalUnrealizedPct, newEntriesAllowed }
 */
async function manageOpenPositions() {
  const alpacaKey    = process.env.ALPACA_API_KEY;
  const alpacaSecret = process.env.ALPACA_SECRET_KEY;
  if (!alpacaKey || !alpacaSecret) {
    pushLog('POS_MGMT_SKIP: Alpaca keys not configured', 'warn');
    return { positionsManaged: 0, closed: 0, held: 0, trailUpdated: 0, staleOrdersCancelled: 0, openCount: 0, totalUnrealizedPct: 0, newEntriesAllowed: true };
  }

  const alpacaHeaders = {
    'APCA-API-KEY-ID':     alpacaKey,
    'APCA-API-SECRET-KEY': alpacaSecret,
    'Content-Type':        'application/json',
    'Accept':              'application/json',
  };

  const polyKey = process.env.POLYGON_API_KEY;
  const raceFetchFast = (url) => Promise.race([
    fetch(url).then(r => r.ok ? r.json() : null),
    new Promise(resolve => setTimeout(() => resolve(null), 2000))
  ]).catch(() => null);

  // ── 1. Fetch all open positions + account in parallel ─────────────────────
  let positions = [];
  let portfolioValue = 0;
  let totalUnrealizedPl = 0;
  try {
    const [posResult, acctResult] = await Promise.all([
      Promise.race([
        fetch(`${ALPACA_BASE}/v2/positions`, { headers: alpacaHeaders }).then(r => r.ok ? r.json() : []),
        new Promise(resolve => setTimeout(() => resolve([]), 5000))
      ]).catch(() => []),
      Promise.race([
        fetch(`${ALPACA_BASE}/v2/account`, { headers: alpacaHeaders }).then(r => r.ok ? r.json() : null),
        new Promise(resolve => setTimeout(() => resolve(null), 5000))
      ]).catch(() => null),
    ]);
    positions = Array.isArray(posResult) ? posResult : [];
    if (acctResult) portfolioValue = parseFloat(acctResult.portfolio_value) || 0;
  } catch (e) {
    pushLog('POS_MGMT_FETCH_ERR: ' + e.message, 'warn');
    return { positionsManaged: 0, closed: 0, held: 0, trailUpdated: 0, staleOrdersCancelled: 0, openCount: 0, totalUnrealizedPct: 0, newEntriesAllowed: true };
  }

  for (const p of positions) {
    totalUnrealizedPl += parseFloat(p.unrealized_pl) || 0;
  }
  const totalUnrealizedPct = portfolioValue > 0 ? totalUnrealizedPl / portfolioValue : 0;

  // ── Position limit & drawdown gate ─────────────────────────────────────────
  let newEntriesAllowed = true;
  if (positions.length >= 25) {
    pushLog('MAX_POSITIONS: ' + positions.length + ' positions open (limit 25), skipping new signals', 'warn');
    newEntriesAllowed = false;
  }
  if (totalUnrealizedPct < -0.05) {
    pushLog('DRAWDOWN_PAUSE: portfolio down ' + (totalUnrealizedPct * 100).toFixed(2) + '%, no new entries', 'warn');
    newEntriesAllowed = false;
  }

  pushLog('POS_MGMT_START: ' + positions.length + ' open positions, unrealized=' + (totalUnrealizedPct * 100).toFixed(2) + '%', 'info');

  // ── 2. Load all position tracking states from Supabase in one batch ───────
  const posTrackMap = {};
  try {
    const sbUrl = process.env.SUPABASE_URL;
    const sbHdrs = _sbHeaders();
    if (sbUrl && sbHdrs && positions.length > 0) {
      const keys = positions.map(p => 'position_' + p.symbol);
      const keyFilter = keys.map(k => `"${k}"`).join(',');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      let sr;
      try { sr = await fetch(`${sbUrl}/rest/v1/bot_state?key=in.(${keyFilter})&select=key,value`, { headers: sbHdrs, signal: ctrl.signal }); }
      finally { clearTimeout(t); }
      if (sr.ok) {
        const rows = await sr.json().catch(() => []);
        if (Array.isArray(rows)) {
          for (const row of rows) {
            try { posTrackMap[row.key] = JSON.parse(row.value); } catch {}
          }
        }
      }
    }
  } catch { /* no tracking data */ }

  // ── 3. Determine which positions need RSI — only those held > 1 day ───────
  const needsRsi = [];
  const positionData = [];

  for (const pos of positions) {
    const symbol = pos.symbol;
    const currentPrice = parseFloat(pos.current_price) || 0;
    const entryPrice   = parseFloat(pos.avg_entry_price) || 0;
    const qty          = parseFloat(pos.qty) || 0;
    const unrealizedPct = parseFloat(pos.unrealized_plpc) || 0;
    const side         = pos.side;
    const stateKey     = 'position_' + symbol;
    const posTrack     = posTrackMap[stateKey] || null;
    const entryDate    = posTrack?.entryDate || new Date().toISOString().split('T')[0];
    const daysHeld     = Math.max(0, Math.floor((Date.now() - new Date(entryDate).getTime()) / 86400000));

    const pd = { symbol, currentPrice, entryPrice, qty, unrealizedPct, side, stateKey, posTrack, entryDate, daysHeld };
    positionData.push(pd);

    // P&L threshold decisions don't need RSI
    if (unrealizedPct >= 0.08 || unrealizedPct <= -0.04) continue;
    // Positions held < 1 day: skip RSI, just hold
    if (daysHeld < 1) continue;
    // Older positions need RSI for nuanced decisions
    needsRsi.push(symbol);
  }

  pushLog('POS_RSI_PLAN: ' + positions.length + ' positions, ' + needsRsi.length + ' need RSI fetch (skipping ' + (positions.length - needsRsi.length) + ' — threshold/new)', 'info');

  // ── 4. Batch fetch RSI for symbols that need it (parallel with 2s timeout) ──
  const rsiMap = {};
  if (polyKey && needsRsi.length > 0) {
    const rsiPromises = needsRsi.map(async (symbol) => {
      const data = await raceFetchFast('https://api.polygon.io/v1/indicators/rsi/' + symbol + '?timespan=hour&adjusted=true&window=14&series_type=close&order=desc&limit=1&apiKey=' + polyKey);
      return { symbol, rsi: data?.results?.values?.[0]?.value || null };
    });
    const rsiResults = await Promise.all(rsiPromises);
    for (const r of rsiResults) {
      rsiMap[r.symbol] = r.rsi;
    }
  }

  let closed = 0, held = 0, trailUpdated = 0;
  const closedThisCycle = new Set(); // Prevent duplicate close orders within same scan

  // ── 5. Evaluate each position ──────────────────────────────────────────────
  for (const pd of positionData) {
    const { symbol, currentPrice, entryPrice, qty, unrealizedPct, side, stateKey, posTrack, entryDate, daysHeld } = pd;

    if (!currentPrice || !entryPrice) {
      pushLog('POS_MGMT_SKIP_NODATA: ' + symbol, 'warn');
      held++;
      continue;
    }

    // Use fetched RSI or fall back to P&L-based decision
    const rsi = rsiMap[symbol] ?? 50;
    const hasRealRsi = rsiMap[symbol] != null;
    const macdHist = 0; // Skip MACD fetch to save time — use RSI + P&L only
    const macdHistPrev = 0;

    // Initialize or update tracking data
    const highestPrice = posTrack ? Math.max(posTrack.highestPrice || currentPrice, currentPrice) : currentPrice;
    const lowestPrice  = posTrack ? Math.min(posTrack.lowestPrice || currentPrice, currentPrice) : currentPrice;
    const entryMacdPositive = posTrack?.entryMacdPositive ?? false;

    // Persist updated tracking data (fire-and-forget)
    writeBotState(stateKey, JSON.stringify({
      entryPrice, entryDate, highestPrice, lowestPrice,
      lastRsi: rsi, lastMacd: macdHist, entryMacdPositive,
      updatedAt: new Date().toISOString()
    }));

    // ── Decision logic ───────────────────────────────────────────────────────
    let action = 'HOLD';
    let reason = '';

    // --- CLOSE conditions (checked first, order matters) ---
    if (unrealizedPct >= 0.08) {
      action = 'CLOSE'; reason = 'PROFIT_TARGET: +' + (unrealizedPct * 100).toFixed(1) + '% (>=8%)';
    } else if (unrealizedPct <= -0.04) {
      action = 'CLOSE'; reason = 'STOP_LOSS: ' + (unrealizedPct * 100).toFixed(1) + '% (<=-4%)';
    } else if (hasRealRsi && rsi >= 75 && unrealizedPct > 0) {
      action = 'CLOSE'; reason = 'OVERBOUGHT_PROFIT: RSI=' + rsi.toFixed(1) + ' pnl=+' + (unrealizedPct * 100).toFixed(1) + '%';
    } else if (hasRealRsi && rsi <= 25 && unrealizedPct < 0) {
      action = 'CLOSE'; reason = 'OVERSOLD_LOSING: RSI=' + rsi.toFixed(1) + ' pnl=' + (unrealizedPct * 100).toFixed(1) + '%';
    } else if (daysHeld > 7 && unrealizedPct > 0) {
      action = 'CLOSE'; reason = 'TIME_LIMIT_PROFIT: held ' + daysHeld + 'd with +' + (unrealizedPct * 100).toFixed(1) + '%';
    } else if (daysHeld > 3 && unrealizedPct < -0.02) {
      action = 'CLOSE'; reason = 'UNDERPERFORMER_CUT: held ' + daysHeld + 'd at ' + (unrealizedPct * 100).toFixed(1) + '%';
    }

    // --- HOLD conditions ---
    if (action === 'HOLD') {
      if (daysHeld < 1) {
        reason = 'NEW_POSITION: held <1d, giving time';
      } else if (hasRealRsi && rsi >= 50 && rsi <= 70 && unrealizedPct > 0) {
        reason = 'MOMENTUM_INTACT: RSI=' + rsi.toFixed(1) + ' pnl=+' + (unrealizedPct * 100).toFixed(1) + '%';
      } else if (unrealizedPct > 0.02 && unrealizedPct < 0.08) {
        reason = 'WINNER_RUNNING: +' + (unrealizedPct * 100).toFixed(1) + '% with positive momentum';
      } else {
        reason = 'DEFAULT_HOLD: pnl=' + (unrealizedPct * 100).toFixed(1) + '% RSI=' + rsi.toFixed(1) + (hasRealRsi ? '' : '(est)');
      }
    }

    // --- TRAIL STOP — progressive trailing for bigger winners (#7) ---
    if (action === 'HOLD' && unrealizedPct >= 0.05) {
      let trailStop = 0;
      let trailLabel = '';

      if (unrealizedPct >= 0.15) {
        trailStop = +(highestPrice * (1 - 0.01)).toFixed(2);
        trailLabel = 'TRAIL_1PCT';
      } else if (unrealizedPct >= 0.12) {
        trailStop = +(highestPrice * (1 - 0.015)).toFixed(2);
        trailLabel = 'TRAIL_1.5PCT';
      } else if (unrealizedPct >= 0.08) {
        trailStop = +(highestPrice * (1 - 0.02)).toFixed(2);
        trailLabel = 'TRAIL_2PCT';
      } else {
        trailStop = entryPrice;
        trailLabel = 'BREAKEVEN';
      }

      if (currentPrice <= trailStop) {
        action = 'CLOSE';
        reason = trailLabel + '_HIT: price $' + currentPrice.toFixed(2) + ' <= trail $' + trailStop + ' (high=$' + highestPrice.toFixed(2) + ' pnl=' + (unrealizedPct * 100).toFixed(1) + '%)';
      } else {
        pushLog('TRAIL_STOP_UPDATE: ' + symbol + ' ' + trailLabel + ' stop=$' + trailStop + ' high=$' + highestPrice.toFixed(2) + ' price=$' + currentPrice.toFixed(2) + ' pnl=+' + (unrealizedPct * 100).toFixed(1) + '%', 'info');
        trailUpdated++;
      }
    }

    // ── Execute decision ─────────────────────────────────────────────────────
    if (action === 'CLOSE') {
      // Guard: skip if already closed this cycle
      if (closedThisCycle.has(symbol)) {
        pushLog('POSITION_ALREADY_CLOSED: ' + symbol + ' skipping duplicate close', 'warn');
        continue;
      }

      // Guard: verify position still exists on Alpaca before placing close order
      let posStillExists = true;
      try {
        const checkCtrl = new AbortController();
        const checkTimer = setTimeout(() => checkCtrl.abort(), 2000);
        let checkResp;
        try { checkResp = await fetch(`${ALPACA_BASE}/v2/positions/${encodeURIComponent(symbol)}`, { headers: alpacaHeaders, signal: checkCtrl.signal }); }
        finally { clearTimeout(checkTimer); }
        posStillExists = checkResp.ok;
      } catch { posStillExists = false; }

      if (!posStillExists) {
        pushLog('POSITION_GONE: ' + symbol + ' already closed, skipping', 'warn');
        closedThisCycle.add(symbol);
        continue;
      }

      // Anomaly detection: block duplicate close within 2 minutes
      const closeKey = symbol + '_close';
      const lastClose = recentOrderTracker.get(closeKey);
      const closeNow = Date.now();
      if (lastClose && (closeNow - lastClose) < 120000) {
        pushLog('DUPLICATE_CLOSE_BLOCKED: ' + symbol + ' already closed within 2 minutes (' + Math.round((closeNow - lastClose) / 1000) + 's ago)', 'warn');
        continue;
      }
      recentOrderTracker.set(closeKey, closeNow);

      pushLog('POSITION_CLOSE: ' + symbol + ' reason=' + reason + ' pnl=' + (unrealizedPct * 100).toFixed(1) + '%', unrealizedPct >= 0 ? 'pass' : 'warn');
      try {
        const closeSide = side === 'long' ? 'sell' : 'buy';
        const closeCtrl = new AbortController();
        const closeTimer = setTimeout(() => closeCtrl.abort(), 10000);
        let closeResp;
        try {
          closeResp = await fetch(`${ALPACA_BASE}/v2/orders`, {
            method: 'POST',
            headers: alpacaHeaders,
            body: JSON.stringify({
              symbol: symbol,
              qty: String(Math.abs(qty)),
              side: closeSide,
              type: 'market',
              time_in_force: 'day',
              client_order_id: ('NZR-CLOSE-' + symbol + '-' + Date.now()).slice(0, 48)
            }),
            signal: closeCtrl.signal,
          });
        } finally { clearTimeout(closeTimer); }

        if (closeResp.ok) {
          closed++;
          closedThisCycle.add(symbol);
          pushLog('POSITION_CLOSED_OK: ' + symbol + ' ' + closeSide + ' ' + Math.abs(qty) + ' shares', 'pass');

          // Update journal entry
          if (supabase) {
            try {
              const { data: journalEntries } = await supabase.from('journal')
                .select('*')
                .eq('symbol', symbol)
                .is('exit_price', null)
                .order('trade_date', { ascending: false })
                .limit(1);
              if (journalEntries && journalEntries.length > 0) {
                const entry = journalEntries[0];
                const pnlPct = ((currentPrice - parseFloat(entry.entry_price)) / parseFloat(entry.entry_price) * 100).toFixed(2);
                await supabase.from('journal').update({
                  exit_price: currentPrice,
                  pnl_pct: parseFloat(pnlPct),
                  notes: (entry.notes || '') + ' | CLOSED: ' + reason
                }).eq('id', entry.id);
                pushLog('JOURNAL_EXIT_UPDATED: ' + symbol + ' pnl=' + pnlPct + '%', 'info');
              }
            } catch (je) {
              pushLog('JOURNAL_EXIT_ERR: ' + symbol + ' ' + je.message, 'warn');
            }
          }

          // Clean up position tracking state
          writeBotState(stateKey, JSON.stringify({ closed: true, closedAt: new Date().toISOString(), reason }));
        } else {
          const errBody = await closeResp.text().catch(() => 'unknown');
          pushLog('POSITION_CLOSE_FAILED: ' + symbol + ' — ' + errBody, 'warn');
          held++;
        }
      } catch (e) {
        pushLog('POSITION_CLOSE_ERR: ' + symbol + ' — ' + e.message, 'warn');
        held++;
      }
    } else {
      pushLog('POSITION_HOLD: ' + symbol + ' reason=' + reason + ' pnl=' + (unrealizedPct * 100).toFixed(1) + '% rsi=' + rsi.toFixed(1), 'info');
      held++;
    }
  }

  // ── 6. Cancel stale open orders (> 30 minutes old) ─────────────────────────
  let staleOrdersCancelled = 0;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    let ordResp;
    try { ordResp = await fetch(`${ALPACA_BASE}/v2/orders?status=open`, { headers: alpacaHeaders, signal: ctrl.signal }); }
    finally { clearTimeout(t); }

    if (ordResp.ok) {
      const openOrders = await ordResp.json();
      if (Array.isArray(openOrders)) {
        const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
        for (const order of openOrders) {
          const submittedAt = new Date(order.submitted_at || order.created_at).getTime();
          if (submittedAt < thirtyMinAgo) {
            try {
              const cancelCtrl = new AbortController();
              const cancelTimer = setTimeout(() => cancelCtrl.abort(), 2000);
              try {
                await fetch(`${ALPACA_BASE}/v2/orders/${order.id}`, { method: 'DELETE', headers: alpacaHeaders, signal: cancelCtrl.signal });
              } finally { clearTimeout(cancelTimer); }
              staleOrdersCancelled++;
              pushLog('STALE_ORDER_CANCELLED: ' + (order.symbol || 'unknown') + ' id=' + order.id + ' age=' + Math.round((Date.now() - submittedAt) / 60000) + 'min', 'info');
            } catch (ce) {
              pushLog('STALE_CANCEL_ERR: ' + order.id + ' — ' + ce.message, 'warn');
            }
          }
        }
      }
    }
  } catch (e) {
    pushLog('STALE_ORDERS_CHECK_ERR: ' + e.message, 'warn');
  }

  pushLog('POS_MGMT_DONE: managed=' + positions.length + ' closed=' + closed + ' held=' + held + ' trail=' + trailUpdated + ' stale_cancelled=' + staleOrdersCancelled, 'info');

  return {
    positionsManaged: positions.length,
    closed, held, trailUpdated, staleOrdersCancelled,
    openCount: positions.length - closed,
    totalUnrealizedPct: +(totalUnrealizedPct * 100).toFixed(2),
    newEntriesAllowed
  };
}

// ─── JOURNAL P&L UPDATE FOR CLOSED TRADES ────────────────────────────────────

/**
 * Fetches today's closed Alpaca orders and updates matching journal entries
 * with exit_price and pnl_pct.  Called at the start of every cron scan cycle.
 */
async function updateClosedTrades() {
  try {
    pushLog('UPDATE_PNL: starting', 'info');

    // Fetch all orders from Alpaca
    const alpacaRes = await fetch('https://paper-api.alpaca.markets/v2/orders?status=all&limit=500&direction=desc', {
      headers: {
        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY
      }
    });
    const orders = await alpacaRes.json();
    if (!Array.isArray(orders)) { pushLog('UPDATE_PNL: no orders from Alpaca', 'warn'); return; }

    // Get all filled sell orders
    const sellOrders = orders.filter(o =>
      o.side === 'sell' &&
      o.status === 'filled' &&
      o.filled_avg_price &&
      parseFloat(o.filled_avg_price) > 0
    );

    pushLog('UPDATE_PNL: found ' + sellOrders.length + ' filled sell orders', 'info');

    // Get all journal entries with no exit_price
    const { data: openEntries, error: fetchError } = await supabase
      .from('journal')
      .select('*')
      .is('exit_price', null)
      .order('trade_date', { ascending: true });

    if (fetchError) { pushLog('UPDATE_PNL: supabase error: ' + fetchError.message, 'warn'); return; }
    if (!openEntries || openEntries.length === 0) { pushLog('UPDATE_PNL: no open journal entries to update', 'info'); return; }

    pushLog('UPDATE_PNL: ' + openEntries.length + ' open journal entries to check', 'info');

    let updated = 0;

    for (const entry of openEntries) {
      // Find matching sell order for this symbol
      const matchingSell = sellOrders.find(o =>
        o.symbol === entry.symbol &&
        new Date(o.filled_at) > new Date(entry.trade_date)
      );

      if (matchingSell) {
        const entryPrice = parseFloat(entry.entry_price);
        const exitPrice = parseFloat(matchingSell.filled_avg_price);
        const pnlPct = ((exitPrice - entryPrice) / entryPrice * 100);

        const { error: updateError } = await supabase
          .from('journal')
          .update({
            exit_price: exitPrice,
            pnl_pct: parseFloat(pnlPct.toFixed(2))
          })
          .eq('id', entry.id);

        if (!updateError) {
          updated++;
          pushLog('PNL_UPDATED: ' + entry.symbol + ' entry=$' + entryPrice + ' exit=$' + exitPrice + ' pnl=' + pnlPct.toFixed(2) + '%', pnlPct > 0 ? 'pass' : 'warn');
        } else {
          pushLog('PNL_UPDATE_ERROR: ' + entry.symbol + ' — ' + updateError.message, 'warn');
        }
      }
    }

    pushLog('UPDATE_PNL_DONE: updated ' + updated + ' entries', 'info');

  } catch(e) {
    pushLog('UPDATE_PNL_FATAL: ' + e.message, 'warn');
  }
}

// ─── ALPACA ORDER EXECUTION ───────────────────────────────────────────────────

/**
 * Writes a journal row and a notification row to Supabase after a successful
 * order placement.  Fail-silent: any error is caught and warned.
 */
async function writeSupabaseRecord(signal, qty, newsContext = null, orderData = null, stopPrice = 0, target1 = 0) {
  const supabaseUrl = process.env.SUPABASE_URL || 'https://chfdvmtnditebmlmyihr.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  const headers = {
    'Content-Type':  'application/json',
    'apikey':        supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Prefer':        'return=minimal',
  };

  const direction = signal.direction || 'LONG';
  const notes = 'Bot: ' + (signal.strategy || 'COMBINED') +
    ' | NZR=' + signal.nrzScore +
    ' | Dir=' + direction.toUpperCase() +
    ' | RSI=' + (signal.rsi ? signal.rsi.toFixed(1) : 'n/a') +
    ' | MACD=' + (signal.macdHist ? signal.macdHist.toFixed(3) : 'n/a') +
    ' | EMA=' + (signal.emaTrend || 'n/a') +
    ' | Stop=$' + (stopPrice > 0 ? stopPrice.toFixed(2) : 'n/a') +
    ' | Target=$' + (target1 > 0 ? target1.toFixed(2) : 'n/a') +
    ' | Qty=' + qty +
    ' | OrderID=' + (orderData?.id || 'unknown');

  const journalRow = {
    symbol:      signal.symbol,
    entry_price: parseFloat(signal.entryPrice) || 0,
    exit_price:  null,
    pnl_pct:     null,
    avg_cost:    parseFloat(signal.entryPrice) || 0,
    trade_date:  toETDate(),
    notes:       notes,
    user_id:     '00000000-0000-0000-0000-000000000000',
  };
  if (newsContext) {
    journalRow.news_context = JSON.stringify(newsContext);
  }

  try {
    await Promise.allSettled([
      fetch(`${supabaseUrl}/rest/v1/journal`, {
        method: 'POST', headers,
        body: JSON.stringify(journalRow),
      }),
      safeNotify(
        `Bot opened ${direction.toLowerCase()} on ${signal.symbol} @ $${(parseFloat(signal.entryPrice) || 0).toFixed(2)} (NZR ${signal.nrzScore})`,
        'trade'
      ),
    ]);
    pushLog('JOURNAL_WRITTEN: ' + signal.symbol + ' trade logged', 'info');
  } catch(journalErr) {
    pushLog('JOURNAL_ERROR: ' + journalErr.message, 'warn');
  }
}

/**
 * Submits a bracket limit order to Alpaca Paper Trading for an approved signal.
 *
 * @param {object} signal  — { symbol, direction, mode, strategy, nrzScore,
 *                            entryPrice, stopPrice, target1, positionSize, atr }
 * @returns {{ executed: boolean, orderId?: string, qty?: number, reason?: string }}
 */
async function executeSignal(signal, newsContext = null) {
  try {
  // ── Parse and guard all price values ──────────────────────────────────────
  const entryPrice  = parseFloat(signal.entryPrice) || 0;
  const positionSize = parseFloat(signal.positionSize) || 0;
  const atr         = parseFloat(signal.atr) || entryPrice * 0.015;

  console.log('[EXECUTE] Starting for', signal.symbol, 'score=', signal.nrzScore, 'dir=', signal.direction, 'price=', entryPrice, 'posSize=', positionSize);
  pushLog('EXEC_START: ' + signal.symbol + ' score=' + (signal.nrzScore || 0) + ' price=$' + entryPrice + ' posSize=$' + positionSize, 'info');

  if (!entryPrice || entryPrice <= 0) {
    pushLog('EXEC_SKIP: ' + signal.symbol + ' — invalid entry price: ' + signal.entryPrice, 'warn');
    return { executed: false, reason: 'invalid_entry_price' };
  }
  if (!positionSize || positionSize <= 0) {
    pushLog('EXEC_SKIP: ' + signal.symbol + ' — invalid position size: ' + signal.positionSize, 'warn');
    return { executed: false, reason: 'invalid_position_size' };
  }

  // Calculate stop and target if not provided
  const stopPrice = (parseFloat(signal.stopPrice) || 0) > 0 ? parseFloat(signal.stopPrice)
    : signal.direction === 'LONG' ? entryPrice - (1.5 * atr) : entryPrice + (1.5 * atr);
  const target1 = (parseFloat(signal.target1) || 0) > 0 ? parseFloat(signal.target1)
    : signal.direction === 'LONG' ? entryPrice + (2 * atr) : entryPrice - (2 * atr);

  // Gate: paper-mode when BOT_LIVE_TRADING is not explicitly enabled
  console.log('[EXECUTE] BOT_LIVE_TRADING=', process.env.BOT_LIVE_TRADING, 'parsed=', BOT_LIVE_TRADING);
  pushLog('EXEC_GATE: ' + signal.symbol + ' BOT_LIVE_TRADING=' + process.env.BOT_LIVE_TRADING + ' killSwitch=' + killSwitch, 'info');
  if (!BOT_LIVE_TRADING) {
    pushLog('PAPER_MODE: live trading disabled (BOT_LIVE_TRADING=' + process.env.BOT_LIVE_TRADING + '), signal logged only — ' + signal.symbol, 'warn');
    return { executed: false, reason: 'paper_mode' };
  }

  // Market hours gate: 9:31 AM – 3:44 PM ET only
  const etMinNow = getETMinuteOfDay();
  const etHH = Math.floor(etMinNow / 60), etMM = String(etMinNow % 60).padStart(2, '0');
  pushLog('EXEC_HOURS: ' + signal.symbol + ' ET=' + etHH + ':' + etMM + ' (min=' + etMinNow + ', need 571-944)', 'info');
  if (etMinNow < 9 * 60 + 31 || etMinNow > 15 * 60 + 44) {
    pushLog(`EXEC_SKIP: ${signal.symbol} outside market hours (ET ${etHH}:${etMM})`, 'warn');
    return { executed: false, reason: 'outside_market_hours' };
  }

  // Respect kill switch
  if (killSwitch) {
    pushLog(`EXEC_SKIP: ${signal.symbol} kill switch active`, 'warn');
    return { executed: false, reason: 'kill_switch' };
  }

  const alpacaKey    = process.env.ALPACA_API_KEY;
  const alpacaSecret = process.env.ALPACA_SECRET_KEY;
  if (!alpacaKey || !alpacaSecret) {
    pushLog(`EXEC_SKIP: ${signal.symbol} Alpaca keys not configured`, 'warn');
    return { executed: false, reason: 'no_credentials' };
  }

  const alpacaHeaders = {
    'APCA-API-KEY-ID':     alpacaKey,
    'APCA-API-SECRET-KEY': alpacaSecret,
    'Content-Type':        'application/json',
    'Accept':              'application/json',
  };

  // 1. Calculate share quantity
  const qty = Math.floor(positionSize / entryPrice);
  console.log('[EXECUTE] Capital=', capitalAmount, 'qty=', qty, 'posSize=', positionSize, 'price=', entryPrice);
  pushLog('EXEC_QTY: ' + signal.symbol + ' qty=' + qty + ' (posSize=$' + positionSize.toFixed(2) + ' / price=$' + entryPrice.toFixed(2) + ')', 'info');
  if (qty < 1) {
    pushLog(`EXEC_SKIP: ${signal.symbol} qty=${qty} too small (posSize=${positionSize} price=${entryPrice})`, 'warn');
    return { executed: false, reason: 'qty_too_small' };
  }

  // 2. Check for an existing open Alpaca position in the same direction
  pushLog('EXEC_CHECK_POS: ' + signal.symbol + ' checking existing position...', 'info');
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let posResp;
    try {
      posResp = await fetch(
        `${ALPACA_BASE}/v2/positions/${encodeURIComponent(signal.symbol)}`,
        { headers: alpacaHeaders, signal: ctrl.signal }
      );
    } finally { clearTimeout(timer); }

    if (posResp.status === 200) {
      const pos = await posResp.json();
      const existingDir = pos.side === 'long' ? 'LONG' : 'SHORT';
      pushLog('EXEC_POS_FOUND: ' + signal.symbol + ' has ' + pos.side + ' position, signal=' + signal.direction, 'info');
      if (existingDir === signal.direction) {
        pushLog(`EXEC_SKIP: ${signal.symbol} position already open (${pos.side})`, 'warn');
        return { executed: false, reason: 'position_exists' };
      }
    } else {
      pushLog('EXEC_POS_CLEAR: ' + signal.symbol + ' no existing position (status=' + posResp.status + ')', 'info');
    }
  } catch (err) {
    pushLog('EXEC_POS_CHECK_ERR: ' + signal.symbol + ' ' + err.message + ' (proceeding)', 'warn');
  }

  // 3. Buying power check
  pushLog('EXEC_CHECK_BP: ' + signal.symbol + ' checking buying power...', 'info');
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let acctResp;
    try {
      acctResp = await fetch(`${ALPACA_BASE}/v2/account`, { headers: alpacaHeaders, signal: ctrl.signal });
    } finally { clearTimeout(timer); }

    if (acctResp.ok) {
      const acct = await acctResp.json().catch(() => ({}));
      const buyingPower  = parseFloat(acct.buying_power ?? acct.cash ?? '0');
      const orderValue   = qty * entryPrice;
      pushLog('EXEC_BP: ' + signal.symbol + ' buyingPower=$' + buyingPower.toFixed(2) + ' orderValue=$' + orderValue.toFixed(2) + ' (' + (orderValue / buyingPower * 100).toFixed(1) + '%)', 'info');
      if (isFinite(buyingPower) && buyingPower > 0 && orderValue > buyingPower * 0.95) {
        pushLog(`BUYING_POWER_SKIP: ${signal.symbol} order $${orderValue.toFixed(2)} > 95% of buying power $${buyingPower.toFixed(2)}`, 'warn');
        return { executed: false, reason: 'insufficient_buying_power', orderValue, buyingPower };
      }
    } else {
      pushLog('EXEC_BP_FAIL: ' + signal.symbol + ' account fetch status=' + acctResp.status + ' (proceeding)', 'warn');
    }
  } catch (err) {
    pushLog('EXEC_BP_ERR: ' + signal.symbol + ' ' + err.message + ' (proceeding)', 'warn');
  }

  // 4. Anomaly detection — block rapid duplicate orders
  const orderKey = signal.symbol + '_' + (signal.direction === 'LONG' ? 'buy' : 'sell');
  const lastOrderTime = recentOrderTracker.get(orderKey);
  const orderNow = Date.now();
  if (lastOrderTime && (orderNow - lastOrderTime) < 60000) {
    pushLog('ANOMALY_DETECTED: ' + signal.symbol + ' order attempted twice within 60s — BLOCKED (last=' + Math.round((orderNow - lastOrderTime) / 1000) + 's ago)', 'warn');
    return { executed: false, reason: 'anomaly_duplicate_order' };
  }
  recentOrderTracker.set(orderKey, orderNow);

  // 5. Position size sanity check
  const positionValue = qty * entryPrice;
  const portfolioPct = capitalAmount > 0 ? (positionValue / capitalAmount) * 100 : 0;
  if (portfolioPct > 15) {
    pushLog('SIZE_ALERT: ' + signal.symbol + ' position is ' + portfolioPct.toFixed(1) + '% of portfolio ($' + positionValue.toFixed(0) + '/$' + capitalAmount + ') — oversized', 'warn');
    if (supabase) {
      try { await supabase.from('bot_state').upsert({ key: 'size_alert', value: JSON.stringify({ symbol: signal.symbol, portfolioPct: +portfolioPct.toFixed(1), timestamp: new Date().toISOString() }) }); } catch {}
    }
  }

  // 6. Submit bracket limit order
  const side          = signal.direction === 'LONG' ? 'buy' : 'sell';
  const clientOrderId = `NZR-${(signal.mode || 'day').toUpperCase()}-${signal.strategy || 'SCAN'}-${signal.symbol}-${Date.now()}`
    .slice(0, 48);

  const orderBody = {
    symbol:          signal.symbol,
    qty:             qty.toString(),
    side,
    type:            'limit',
    time_in_force:   signal.mode === 'day' ? 'day' : 'gtc',
    limit_price:     entryPrice.toFixed(2),
    order_class:     'bracket',
    stop_loss:       { stop_price:    stopPrice.toFixed(2) },
    take_profit:     { limit_price:   target1.toFixed(2) },
    client_order_id: clientOrderId,
  };

  console.log('[EXECUTE] Order body=', JSON.stringify(orderBody));
  pushLog('EXEC_ORDER: ' + signal.symbol + ' ' + side + ' ' + qty + ' @ $' + entryPrice.toFixed(2) + ' stop=$' + stopPrice.toFixed(2) + ' target=$' + target1.toFixed(2) + ' tif=' + orderBody.time_in_force, 'info');

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let orderResp;
    try {
      orderResp = await fetch(`${ALPACA_BASE}/v2/orders`, {
        method:  'POST',
        headers: alpacaHeaders,
        body:    JSON.stringify(orderBody),
        signal:  ctrl.signal,
      });
    } finally { clearTimeout(timer); }

    const orderData = await orderResp.json().catch(() => ({}));

    console.log('[EXECUTE] Alpaca response status=', orderResp.status);
    console.log('[EXECUTE] Alpaca response=', JSON.stringify(orderData));
    pushLog('EXEC_RESPONSE: ' + signal.symbol + ' status=' + orderResp.status + ' id=' + (orderData.id || 'none') + ' msg=' + (orderData.message || 'ok'), orderResp.status <= 201 ? 'pass' : 'warn');

    // 5. Handle success
    if (orderResp.status === 200 || orderResp.status === 201) {
      const orderId = orderData.id ?? 'unknown';
      pushLog(
        `ORDER_PLACED: ${signal.symbol} ${signal.direction} ${qty} shares @ ${entryPrice.toFixed(2)}` +
        ` stop=${stopPrice.toFixed(2)} target=${target1.toFixed(2)} id=${orderId}`,
        'pass'
      );
      // Write to journal with full error logging
      try {
        const journalPayload = {
          symbol: signal.symbol,
          entry_price: parseFloat(entryPrice) || 0,
          exit_price: null,
          pnl_pct: null,
          trade_date: new Date().toISOString().split('T')[0],
          notes: 'Bot: COMBINED | NZR=' + (signal.nrzScore || 0) +
                 ' | Dir=' + (signal.direction || 'long').toUpperCase() +
                 ' | RSI=' + (signal.rsi ? Number(signal.rsi).toFixed(1) : 'n/a') +
                 ' | MACD=' + (signal.macdHist ? Number(signal.macdHist).toFixed(3) : 'n/a') +
                 ' | EMA=' + (signal.emaTrend || 'n/a') +
                 ' | Stop=$' + (stopPrice ? stopPrice.toFixed(2) : '0') +
                 ' | Target=$' + (target1 ? target1.toFixed(2) : '0') +
                 ' | Qty=' + (qty || 0) +
                 ' | OrderID=' + (orderData.id || 'unknown')
        };

        console.log('[JOURNAL] Attempting insert:', JSON.stringify(journalPayload));

        const { data: journalData, error: journalError } = await supabase
          .from('journal')
          .insert(journalPayload)
          .select();

        if (journalError) {
          console.error('[JOURNAL] Insert error:', JSON.stringify(journalError));
          pushLog('JOURNAL_ERROR: ' + signal.symbol + ' — code=' + journalError.code + ' msg=' + journalError.message, 'warn');
        } else {
          console.log('[JOURNAL] Insert success:', JSON.stringify(journalData));
          pushLog('JOURNAL_SUCCESS: ' + signal.symbol + ' trade logged id=' + (journalData?.[0]?.id || 'unknown'), 'pass');
        }
      } catch(je) {
        console.error('[JOURNAL] Exception:', je.message);
        pushLog('JOURNAL_EXCEPTION: ' + je.message, 'warn');
      }

      return { executed: true, orderId, qty };
    }

    // 6. Handle failure — log, no retry
    const errMsg = orderData?.message || orderData?.code || `HTTP ${orderResp.status}`;
    pushLog(`ORDER_FAILED: ${signal.symbol} — ${errMsg}`, 'block');
    return { executed: false, reason: 'order_rejected', detail: errMsg };

  } catch (err) {
    pushLog(`ORDER_FAILED: ${signal.symbol} — ${err.message}`, 'block');
    return { executed: false, reason: 'request_error', detail: err.message };
  }

  } catch(err) {
    pushLog('EXEC_ERROR: ' + (signal?.symbol || 'unknown') + ' — ' + err.message, 'warn');
    return { executed: false, reason: 'exec_crash', detail: err.message };
  }
}

// ─── BOT PERFORMANCE ATTRIBUTION ─────────────────────────────────────────────

async function trackBotPerformance() {
  try {
    const posRes = await Promise.race([
      fetch(`${ALPACA_BASE}/v2/positions`, {
        headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY }
      }).then(r => r.ok ? r.json() : []),
      new Promise(resolve => setTimeout(() => resolve([]), 3000))
    ]);
    const positions = Array.isArray(posRes) ? posRes : [];
    if (!positions.length) return;

    const unrealizedPnl = positions.reduce((sum, p) => sum + (parseFloat(p.unrealized_pl) || 0), 0);
    const avgPnlPct = positions.reduce((sum, p) => sum + (parseFloat(p.unrealized_plpc) || 0), 0) / positions.length * 100;

    // Total exposure check
    const cap = getEffectiveCapital();
    const totalExposure = positions.reduce((sum, p) => sum + Math.abs(parseFloat(p.market_value) || 0), 0);
    const exposurePct = cap > 0 ? (totalExposure / cap) * 100 : 0;

    if (supabase) {
      try {
        await supabase.from('bot_state').upsert({ key: 'daily_pnl', value: unrealizedPnl.toFixed(2) });
        await supabase.from('bot_state').upsert({ key: 'daily_pnl_pct', value: avgPnlPct.toFixed(2) });
        await supabase.from('bot_state').upsert({ key: 'portfolio_exposure', value: JSON.stringify({ exposure: +exposurePct.toFixed(1), positions: positions.length, timestamp: new Date().toISOString() }) });

        // Drawdown pause: if losing more than 3% today
        if (avgPnlPct < -3) {
          await supabase.from('bot_state').upsert({ key: 'drawdown_pause', value: 'true' });
          pushLog('DRAWDOWN_PAUSE_SET: portfolio down ' + avgPnlPct.toFixed(2) + '% — pausing new entries', 'warn');
        } else {
          await supabase.from('bot_state').upsert({ key: 'drawdown_pause', value: 'false' });
        }
      } catch {}
    }

    if (exposurePct > 150) {
      pushLog('OVEREXPOSED: portfolio exposure at ' + exposurePct.toFixed(1) + '% of capital ($' + totalExposure.toFixed(0) + '/$' + cap + ') — flagged', 'warn');
    }

    pushLog('PERFORMANCE: ' + positions.length + ' positions, unrealized=$' + unrealizedPnl.toFixed(2) + ' (' + avgPnlPct.toFixed(2) + '%), exposure=' + exposurePct.toFixed(1) + '%', unrealizedPnl >= 0 ? 'pass' : 'warn');
  } catch(e) {
    pushLog('PERFORMANCE_ERROR: ' + e.message, 'warn');
  }
}

// ─── AUTO-CLOSE DAY TRADES ────────────────────────────────────────────────────

/**
 * Closes all NZR day-trade positions at market.  Called by the cron handler
 * when ET time is 3:40–3:50 PM.
 *
 * Strategy: cross-reference open Alpaca positions against the in-memory
 * trailingStops tracker (keyed "day:{symbol}") AND any open NZR-DAY- orders,
 * then market-sell/buy-to-cover each one.
 */
async function closeExpiredDayTrades() {
  if (!BOT_LIVE_TRADING) return;

  const alpacaKey    = process.env.ALPACA_API_KEY;
  const alpacaSecret = process.env.ALPACA_SECRET_KEY;
  if (!alpacaKey || !alpacaSecret) return;

  const headers = {
    'APCA-API-KEY-ID':     alpacaKey,
    'APCA-API-SECRET-KEY': alpacaSecret,
    'Content-Type':        'application/json',
    'Accept':              'application/json',
  };

  // Fetch all open Alpaca positions
  let positions = [];
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let resp;
    try { resp = await fetch(`${ALPACA_BASE}/v2/positions`, { headers, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (!resp.ok) { console.warn('[bot] closeExpiredDayTrades: positions fetch failed', resp.status); return; }
    positions = await resp.json().catch(() => []);
    if (!Array.isArray(positions)) positions = [];
  } catch (err) {
    console.warn('[bot] closeExpiredDayTrades: fetch error', err.message);
    return;
  }

  // Build set of day-trade symbols from our in-memory tracker
  const trackedDaySymbols = new Set(
    [...trailingStops.keys()].filter(k => k.startsWith('day:')).map(k => k.slice(4))
  );

  // Also find symbols from any still-open NZR-DAY- orders (best-effort)
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let resp;
    try { resp = await fetch(`${ALPACA_BASE}/v2/orders?status=open&limit=200`, { headers, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (resp.ok) {
      const orders = await resp.json().catch(() => []);
      if (Array.isArray(orders)) {
        orders
          .filter(o => (o.client_order_id || '').startsWith('NZR-DAY-'))
          .forEach(o => trackedDaySymbols.add(o.symbol));
      }
    }
  } catch {}

  for (const pos of positions) {
    if (!trackedDaySymbols.has(pos.symbol)) continue;

    const closeSide = pos.side === 'long' ? 'sell' : 'buy';
    const closeBody = {
      symbol:          pos.symbol,
      qty:             pos.qty,
      side:            closeSide,
      type:            'market',
      time_in_force:   'day',
      client_order_id: `NZR-AUTOCLOSE-${pos.symbol}-${Math.floor(Date.now() / 1000)}`.slice(0, 48),
    };

    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      let resp;
      try {
        resp = await fetch(`${ALPACA_BASE}/v2/orders`, {
          method: 'POST', headers, body: JSON.stringify(closeBody), signal: ctrl.signal,
        });
      } finally { clearTimeout(timer); }

      if (resp.ok) {
        pushLog(`AUTO_CLOSE: ${pos.symbol} day trade closed at market`, 'pass');
        trailingStops.delete(`day:${pos.symbol}`);
      } else {
        const errData = await resp.json().catch(() => ({}));
        pushLog(`AUTO_CLOSE_FAIL: ${pos.symbol} — ${errData.message || resp.status}`, 'warn');
      }
    } catch (err) {
      pushLog(`AUTO_CLOSE_FAIL: ${pos.symbol} — ${err.message}`, 'warn');
    }
  }
}

// ─── PRE-MARKET GAP PROTECTION ────────────────────────────────────────────────
/**
 * Scans all open NZR swing positions and submits market sells for any that have
 * gapped down past their trailing stop in pre-market.
 * Called at 9:23–9:27 AM ET window in the cron handler.
 *
 * Logic:
 *  1. Fetch open Alpaca positions — filter to those tracked in trailingStops as "swing:*"
 *  2. For each, fetch Polygon snapshot preMarketPrice
 *  3. If preMarketPrice < stopPrice × 0.97 → submit market sell (or buy-to-cover for shorts)
 */
async function runPreMarketGapProtection() {
  if (!BOT_LIVE_TRADING) return;

  const alpacaKey    = process.env.ALPACA_API_KEY;
  const alpacaSecret = process.env.ALPACA_SECRET_KEY;
  const polygonKey   = process.env.POLYGON_API_KEY;
  if (!alpacaKey || !alpacaSecret || !polygonKey) return;

  const headers = {
    'APCA-API-KEY-ID':     alpacaKey,
    'APCA-API-SECRET-KEY': alpacaSecret,
    'Content-Type':        'application/json',
    'Accept':              'application/json',
  };

  // 1. Fetch all open Alpaca positions
  let positions = [];
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let resp;
    try { resp = await fetch(`${ALPACA_BASE}/v2/positions`, { headers, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (!resp.ok) { console.warn('[bot] gapProtection: positions fetch failed', resp.status); return; }
    positions = await resp.json().catch(() => []);
    if (!Array.isArray(positions)) positions = [];
  } catch (err) {
    console.warn('[bot] gapProtection: fetch error', err.message);
    return;
  }

  // 2. Filter to swing positions tracked by our trailing stop state
  const swingKeys = [...trailingStops.keys()].filter(k => k.startsWith('swing:'));
  const trackedSymbols = new Set(swingKeys.map(k => k.slice(6)));
  const swingPositions = positions.filter(p => trackedSymbols.has(p.symbol));

  if (swingPositions.length === 0) return;

  let protected_ = 0;
  for (const pos of swingPositions) {
    const sym    = pos.symbol;
    const tsKey  = `swing:${sym}`;
    const ts     = trailingStops.get(tsKey);
    if (!ts) continue;

    // 3. Fetch Polygon snapshot for pre-market price
    let preMarketPrice = null;
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let resp;
      try {
        resp = await fetch(
          `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}?apiKey=${polygonKey}`,
          { signal: ctrl.signal }
        );
      } finally { clearTimeout(timer); }
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}));
        preMarketPrice = data?.ticker?.prevDay?.c    // fallback to prev-day close
          ?? data?.ticker?.lastTrade?.p
          ?? null;
        // Prefer day open or pre-market if available
        const snap = data?.ticker;
        if (snap?.day?.open)         preMarketPrice = snap.day.open;
        if (snap?.lastQuote?.P)      preMarketPrice = snap.lastQuote.P;
      }
    } catch (err) {
      console.warn(`[bot] gapProtection: snapshot fetch error for ${sym}:`, err.message);
      continue;
    }

    if (preMarketPrice == null) continue;

    const stopPrice  = ts.stopPrice;
    const threshold  = stopPrice * 0.97;

    if (preMarketPrice >= threshold) continue; // gap not severe enough

    pushLog(`GAP_PROTECTION: ${sym} preMarket $${preMarketPrice.toFixed(2)} < stop×0.97 $${threshold.toFixed(2)} — submitting market ${ts.direction === 'SHORT' ? 'buy' : 'sell'}`, 'warn');

    // 4. Submit market order to exit
    const closeSide = ts.direction === 'SHORT' ? 'buy' : 'sell';
    const closeBody = {
      symbol:          sym,
      qty:             pos.qty,
      side:            closeSide,
      type:            'market',
      time_in_force:   'day',
      client_order_id: `NZR-GAPPROT-${sym}-${Math.floor(Date.now() / 1000)}`.slice(0, 48),
    };
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      let resp;
      try {
        resp = await fetch(`${ALPACA_BASE}/v2/orders`, {
          method: 'POST', headers, body: JSON.stringify(closeBody), signal: ctrl.signal,
        });
      } finally { clearTimeout(timer); }

      if (resp.ok) {
        protected_++;
        pushLog(`GAP_PROTECTION_FILL: ${sym} market ${closeSide} submitted`, 'pass');
        trailingStops.delete(tsKey);
        writeBotState('trailing_stops', JSON.stringify(Object.fromEntries(trailingStops)));
      } else {
        const errData = await resp.json().catch(() => ({}));
        pushLog(`GAP_PROTECTION_FAIL: ${sym} — ${errData.message || resp.status}`, 'warn');
      }
    } catch (err) {
      pushLog(`GAP_PROTECTION_FAIL: ${sym} — ${err.message}`, 'warn');
    }
  }

  if (protected_ > 0)
    console.log(`[bot] gapProtection: protected ${protected_} swing positions from overnight gap`);
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  console.log('[BOT] File loaded successfully');
  console.log('[BOT] Handler called, method=' + req.method + ' type=' + (req.query?.type || 'none') + ' action=' + (req.query?.action || 'none'));
  const SCAN_START_TIME = Date.now(); // soft timeout sentinel — checked inside scan loop

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'Rate limit reached' });

  const type   = (req.query.type || '').toLowerCase();
  const action = (req.query.action || req.body?.action || '').toLowerCase();
  console.log('[BOT] type=' + (type || 'none') + ' action=' + (action || 'none'));

  // ── TEST JOURNAL INSERT ─────────────────────────────────────────────────────
  if (type === 'testjournal') {
    if (!supabase) return res.json({ data: null, error: { message: 'Supabase not configured — check SUPABASE_URL and SUPABASE_ANON_KEY env vars' } });
    const { data, error } = await supabase.from('journal').insert({
      symbol: 'TEST',
      entry_price: 100,
      trade_date: new Date().toISOString().split('T')[0],
      notes: 'Test entry from bot'
    });
    return res.json({ data, error });
  }

  // ── TEST JOURNAL INSERT v2 (diagnostic) ────────────────────────────────────
  if (type === 'testjournal2') {
    const testPayload = {
      symbol: 'TEST',
      entry_price: 100.00,
      trade_date: new Date().toISOString().split('T')[0],
      notes: 'Diagnostic test entry'
    };
    const { data, error } = await supabase.from('journal').insert(testPayload).select();
    return res.json({
      success: !error,
      data,
      error: error ? { code: error.code, message: error.message, details: error.details } : null,
      supabaseConnected: !!supabase,
      envVars: { url: !!process.env.SUPABASE_URL, key: !!process.env.SUPABASE_ANON_KEY }
    });
  }

  // ── INIT DB (create bot_logs table) ────────────────────────────────────────
  if (type === 'initdb') {
    try {
      const { data, error } = await supabase.rpc('exec_sql', {
        query: `CREATE TABLE IF NOT EXISTS bot_logs (
          id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
          timestamp timestamptz DEFAULT now(),
          message text,
          type text DEFAULT 'info',
          created_at timestamptz DEFAULT now()
        );`
      });
      return res.json({ success: !error, data, error });
    } catch(e) {
      return res.json({ success: false, error: e.message, hint: 'Run this SQL manually in Supabase SQL Editor if rpc exec_sql is not available.' });
    }
  }

  // ── BACKFILL HISTORICAL TRADES FROM ALPACA ─────────────────────────────────
  if (req.query.type === 'backfill') {
    try {
      pushLog('BACKFILL: starting historical trade import', 'info');

      // Fetch all closed orders from Alpaca
      const ordersRes = await fetch('https://paper-api.alpaca.markets/v2/orders?status=closed&limit=500&direction=desc', {
        headers: {
          'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
          'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY
        }
      });
      const orders = await ordersRes.json();

      if (!Array.isArray(orders)) {
        return res.json({ error: 'Failed to fetch orders', raw: orders });
      }

      pushLog('BACKFILL: found ' + orders.length + ' closed orders', 'info');

      // Get filled buy orders only
      const buyOrders = orders.filter(o =>
        o.side === 'buy' &&
        o.status === 'filled' &&
        o.filled_avg_price &&
        parseFloat(o.filled_avg_price) > 0
      );

      pushLog('BACKFILL: ' + buyOrders.length + ' filled buy orders to import', 'info');

      let imported = 0;
      let skipped = 0;

      for (const order of buyOrders) {
        try {
          // Check if already in journal
          const { data: existing } = await supabase
            .from('journal')
            .select('id')
            .eq('symbol', order.symbol)
            .eq('trade_date', order.filled_at ? order.filled_at.split('T')[0] : order.submitted_at.split('T')[0])
            .limit(1);

          if (existing && existing.length > 0) {
            skipped++;
            continue;
          }

          // Find matching sell order for this symbol after this buy
          const matchingSell = orders.find(o =>
            o.side === 'sell' &&
            o.status === 'filled' &&
            o.symbol === order.symbol &&
            o.filled_at > order.filled_at &&
            o.filled_avg_price
          );

          const entryPrice = parseFloat(order.filled_avg_price);
          const exitPrice = matchingSell ? parseFloat(matchingSell.filled_avg_price) : null;
          const pnlPct = exitPrice ? ((exitPrice - entryPrice) / entryPrice * 100) : null;
          const tradeDate = (order.filled_at || order.submitted_at).split('T')[0];

          const { error } = await supabase.from('journal').insert({
            symbol: order.symbol,
            entry_price: entryPrice,
            exit_price: exitPrice,
            pnl_pct: pnlPct ? parseFloat(pnlPct.toFixed(2)) : null,
            trade_date: tradeDate,
            notes: 'Backfilled: qty=' + order.filled_qty +
                   ' | OrderID=' + order.id +
                   (matchingSell ? ' | Closed=' + exitPrice + ' | PnL=' + (pnlPct ? pnlPct.toFixed(2) + '%' : 'n/a') : ' | Status=Open')
          });

          if (!error) {
            imported++;
            pushLog('BACKFILL_IMPORTED: ' + order.symbol + ' @ $' + entryPrice + (pnlPct ? ' pnl=' + pnlPct.toFixed(2) + '%' : ' open'), 'pass');
          } else {
            pushLog('BACKFILL_ERROR: ' + order.symbol + ' — ' + error.message, 'warn');
          }
        } catch(e) {
          pushLog('BACKFILL_SKIP: ' + order.symbol + ' — ' + e.message, 'warn');
        }
      }

      pushLog('BACKFILL_DONE: imported=' + imported + ' skipped=' + skipped, 'info');

      return res.json({
        success: true,
        totalOrders: orders.length,
        buyOrders: buyOrders.length,
        imported,
        skipped,
        message: 'Backfill complete — ' + imported + ' trades imported to journal'
      });

    } catch(e) {
      pushLog('BACKFILL_FATAL: ' + e.message, 'warn');
      return res.json({ error: e.message });
    }
  }

  // ── MANUAL P&L UPDATE ──────────────────────────────────────────────────────
  if (req.query.type === 'updatepnl') {
    pushLog('MANUAL_PNL_UPDATE: starting', 'info');
    await updateClosedTrades();
    return res.json({ success: true, message: 'P&L update complete — check journal' });
  }

  // ── BENCHMARK COMPARISON ──────────────────────────────────────────────────
  if (req.query.type === 'benchmark') {
    try {
      // Read SPY benchmark from bot_state
      const sbUrl  = process.env.SUPABASE_URL;
      const sbHdrs = _sbHeaders();
      let spyReturn = 0, startDate = null;
      if (sbUrl && sbHdrs) {
        const spyResp = await fetch(`${sbUrl}/rest/v1/bot_state?key=eq.spy_benchmark&select=value`, { headers: sbHdrs });
        const spyRows = await spyResp.json().catch(() => []);
        if (Array.isArray(spyRows) && spyRows.length) {
          const spyData = JSON.parse(spyRows[0].value);
          spyReturn = spyData.totalReturn || 0;
          startDate = spyData.date || null;
        }
      }

      // Calculate NZR return from journal
      const { data: closedTrades } = await supabase
        .from('journal')
        .select('pnl_pct, entry_price, trade_date')
        .not('pnl_pct', 'is', null)
        .order('trade_date', { ascending: true });

      const trades = closedTrades || [];
      const totalTrades = trades.length;
      const wins = trades.filter(t => parseFloat(t.pnl_pct) > 0);
      const losses = trades.filter(t => parseFloat(t.pnl_pct) < 0);
      const winRate = totalTrades > 0 ? parseFloat((wins.length / totalTrades * 100).toFixed(1)) : 0;
      const avgWin = wins.length > 0 ? parseFloat((wins.reduce((s, t) => s + parseFloat(t.pnl_pct), 0) / wins.length).toFixed(2)) : 0;
      const avgLoss = losses.length > 0 ? parseFloat((losses.reduce((s, t) => s + parseFloat(t.pnl_pct), 0) / losses.length).toFixed(2)) : 0;
      const profitFactor = avgLoss !== 0 ? parseFloat((avgWin / Math.abs(avgLoss)).toFixed(2)) : 0;

      // NZR return = sum of all pnl_pct weighted by entry_price / starting capital
      const cap = capitalAmount || await getCapital() || 10000;
      let totalPnlDollars = 0;
      for (const t of trades) {
        const ep = parseFloat(t.entry_price) || 0;
        const pnl = parseFloat(t.pnl_pct) || 0;
        totalPnlDollars += ep * (pnl / 100);
      }
      const nzrReturn = parseFloat((totalPnlDollars / cap * 100).toFixed(2));
      const alpha = parseFloat((nzrReturn - spyReturn).toFixed(2));

      // Approximate Sharpe ratio (annualized)
      const pnlArr = trades.map(t => parseFloat(t.pnl_pct) || 0);
      const meanPnl = pnlArr.length > 0 ? pnlArr.reduce((a, b) => a + b, 0) / pnlArr.length : 0;
      const variance = pnlArr.length > 1 ? pnlArr.reduce((s, p) => s + Math.pow(p - meanPnl, 2), 0) / (pnlArr.length - 1) : 0;
      const stdDev = Math.sqrt(variance);
      const sharpeRatio = stdDev > 0 ? parseFloat(((meanPnl / stdDev) * Math.sqrt(252)).toFixed(2)) : 0;

      return res.json({
        spyReturn,
        nzrReturn,
        alpha,
        outperforming: nzrReturn > spyReturn,
        startDate: startDate || (trades.length > 0 ? trades[0].trade_date : null),
        totalTrades,
        winRate,
        avgWin,
        avgLoss,
        profitFactor,
        sharpeRatio
      });
    } catch(e) {
      return res.json({ error: e.message });
    }
  }

  // ── LOAD CAPITAL FROM SUPABASE ON EVERY REQUEST ─────────────────────────────
  if (!capitalAmount || capitalAmount <= 0) {
    try {
      const cap = await getCapital();
      if (cap > 0) {
        capitalAmount = cap;
        computeAllocations();
        console.log('[BOT] Capital loaded from Supabase: $' + capitalAmount);
      }
    } catch(e) {
      console.log('[BOT] Capital load failed:', e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // TYPE-BASED ROUTES — checked FIRST, before any action or status catch-all
  // ══════════════════════════════════════════════════════════════════════════════

  // ── EMERGENCY CLEANUP — one-time fix for duplicate positions ────────────────
  if (type === 'emergency') {
    const alpacaHdrs = { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY, 'Content-Type': 'application/json' };
    const fixes = [];

    // Fix 1: Close ORCL short position (duplicate sells created a short)
    try {
      const orclRes = await fetch('https://paper-api.alpaca.markets/v2/positions/ORCL', { headers: alpacaHdrs });
      if (orclRes.ok) {
        const orclPos = await orclRes.json();
        if (parseFloat(orclPos.qty) < 0) {
          const closeRes = await fetch('https://paper-api.alpaca.markets/v2/positions/ORCL', { method: 'DELETE', headers: alpacaHdrs });
          fixes.push({ symbol: 'ORCL', action: 'closed short', status: closeRes.ok ? 'done' : 'failed' });
        } else {
          fixes.push({ symbol: 'ORCL', action: 'not short, skipped' });
        }
      } else {
        fixes.push({ symbol: 'ORCL', action: 'no position found' });
      }
    } catch(e) { fixes.push({ symbol: 'ORCL', error: e.message }); }

    // Fix 2: Close all SH (inverse ETF — not wanted)
    try {
      const shRes = await fetch('https://paper-api.alpaca.markets/v2/positions/SH', { method: 'DELETE', headers: alpacaHdrs });
      fixes.push({ symbol: 'SH', action: 'closed all', status: shRes.ok ? 'done' : 'failed' });
    } catch(e) { fixes.push({ symbol: 'SH', error: e.message }); }

    // Fix 3: Close all PSQ (inverse ETF — not wanted)
    try {
      const psqRes = await fetch('https://paper-api.alpaca.markets/v2/positions/PSQ', { method: 'DELETE', headers: alpacaHdrs });
      fixes.push({ symbol: 'PSQ', action: 'closed all', status: psqRes.ok ? 'done' : 'failed' });
    } catch(e) { fixes.push({ symbol: 'PSQ', error: e.message }); }

    // Fix 4: Sell 75 excess GOOGL shares (90 → 15)
    try {
      const googlRes = await fetch('https://paper-api.alpaca.markets/v2/orders', {
        method: 'POST', headers: alpacaHdrs,
        body: JSON.stringify({ symbol: 'GOOGL', qty: '75', side: 'sell', type: 'market', time_in_force: 'day' })
      });
      fixes.push({ symbol: 'GOOGL', action: 'sold 75 excess', status: googlRes.ok ? 'done' : 'failed' });
    } catch(e) { fixes.push({ symbol: 'GOOGL', error: e.message }); }

    // Fix 5: Sell 78 excess NVDA shares (100 → 22)
    try {
      const nvdaRes = await fetch('https://paper-api.alpaca.markets/v2/orders', {
        method: 'POST', headers: alpacaHdrs,
        body: JSON.stringify({ symbol: 'NVDA', qty: '78', side: 'sell', type: 'market', time_in_force: 'day' })
      });
      fixes.push({ symbol: 'NVDA', action: 'sold 78 excess', status: nvdaRes.ok ? 'done' : 'failed' });
    } catch(e) { fixes.push({ symbol: 'NVDA', error: e.message }); }

    // Fix 6: Sell 120 excess MRNA shares (179 → 59)
    try {
      const mrnaRes = await fetch('https://paper-api.alpaca.markets/v2/orders', {
        method: 'POST', headers: alpacaHdrs,
        body: JSON.stringify({ symbol: 'MRNA', qty: '120', side: 'sell', type: 'market', time_in_force: 'day' })
      });
      fixes.push({ symbol: 'MRNA', action: 'sold 120 excess', status: mrnaRes.ok ? 'done' : 'failed' });
    } catch(e) { fixes.push({ symbol: 'MRNA', error: e.message }); }

    pushLog('EMERGENCY_CLEANUP: ' + fixes.length + ' fixes applied', 'warn');
    return res.json({ success: true, fixes });
  }

  // ── FULL SCAN (synchronous — 20s budget, 15 symbols/cycle rotation) ────────
  if (type === 'scan') {
    if (global.scanInProgress) {
      return res.json({ success: true, message: 'Scan already in progress', skipped: true });
    }
    global.scanInProgress = true;
    console.log('[BOT] SCAN route matched');
    const startTime = Date.now();
    const capital = capitalAmount && capitalAmount > 0 ? capitalAmount : await getCapital();
    if (!capitalAmount || capitalAmount <= 0) {
      capitalAmount = capital;
      computeAllocations();
    }
    const dayAlloc = capital * 0.4;
    const swingAlloc = capital * 0.6;

    // ── Market hours check (proper ET timezone) ─────────────────────────────
    const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etHour = nowET.getHours();
    const etMinute = nowET.getMinutes();
    const etDay = nowET.getDay();
    const etTimeDecimal = etHour + etMinute / 60;
    const isWeekday = etDay >= 1 && etDay <= 5;
    const isMarketOpen = isWeekday && etTimeDecimal >= 9.5 && etTimeDecimal < 15.75;

    if (!isMarketOpen) {
      pushLog('MARKET_CLOSED: ' + etHour + ':' + String(etMinute).padStart(2,'0') + ' ET', 'info');
      global.scanInProgress = false;
      return res.status(200).json({ success: true, message: 'Market closed', symbolsScanned: 0, signalsPassed: 0, tradesPlaced: 0, duration: '0ms' });
    }

    pushLog('SCAN_UNIVERSE_SIZE: ' + SCAN_UNIVERSE.length + ' symbols', 'info');
    pushLog('SCAN_STARTED: capital=$' + capital + ' day=$' + dayAlloc + ' swing=$' + swingAlloc + ' universe=' + SCAN_UNIVERSE.length + ' ET=' + etHour + ':' + String(etMinute).padStart(2,'0'), 'info');

    // ── Dynamic position management — runs FIRST every cycle (8s hard limit) ──
    let posMgmt = { positionsManaged: 0, closed: 0, held: 0, trailUpdated: 0, staleOrdersCancelled: 0, openCount: 0, totalUnrealizedPct: 0, newEntriesAllowed: true };
    try {
      let mgmtTimedOut = false;
      const mgmtResult = await Promise.race([
        manageOpenPositions(),
        new Promise(resolve => {
          setTimeout(() => {
            mgmtTimedOut = true;
            pushLog('MGMT_TIMEOUT: position management cut short at 8s, proceeding to scan', 'warn');
            resolve(null);
          }, 8000);
        })
      ]);
      if (mgmtResult) posMgmt = mgmtResult;
    } catch(e) {
      pushLog('POS_MGMT_ERROR: ' + e.message, 'warn');
    }

    // Update P&L for any closed trades before scanning
    try { await updateClosedTrades(); } catch(e) { pushLog('CLOSED_TRADES_ERR: ' + e.message, 'warn'); }

    // ── Fetch fresh position list AFTER management (for accurate buy gating) ──
    let openPositions = [];
    try {
      const posResp = await Promise.race([
        fetch(`${ALPACA_BASE}/v2/positions`, {
          headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY }
        }).then(r => r.ok ? r.json() : []),
        new Promise(resolve => setTimeout(() => resolve([]), 3000))
      ]);
      openPositions = Array.isArray(posResp) ? posResp : [];
    } catch { openPositions = []; }
    const currentOpenCount = openPositions.length;
    const ownedSymbols = new Set(openPositions.map(p => p.symbol));
    pushLog('POST_MGMT_POSITIONS: ' + currentOpenCount + ' open (' + [...ownedSymbols].slice(0, 10).join(',') + (currentOpenCount > 10 ? '...' : '') + ')', 'info');

    // ── Drawdown pause check from Supabase ──────────────────────────────────
    let drawdownPaused = false;
    if (supabase) {
      try {
        const { data: pauseState } = await supabase.from('bot_state').select('value').eq('key', 'drawdown_pause').single();
        if (pauseState?.value === 'true') {
          pushLog('DRAWDOWN_PAUSE_ACTIVE: skipping new entries this cycle (set by previous performance check)', 'warn');
          drawdownPaused = true;
        }
      } catch {}
    }

    // ── Total exposure check — block new entries if over 150% ────────────────
    let overexposed = false;
    const cap = getEffectiveCapital();
    const totalExposure = openPositions.reduce((sum, p) => sum + Math.abs(parseFloat(p.market_value) || 0), 0);
    const exposurePct = cap > 0 ? (totalExposure / cap) * 100 : 0;
    if (exposurePct > 150) {
      pushLog('OVEREXPOSED: portfolio exposure at ' + exposurePct.toFixed(1) + '% — blocking new entries', 'warn');
      overexposed = true;
    }

    let symbolsScanned = 0;
    let signalsFound = 0;
    let tradesPlaced = 0;
    let signalResults = [];
    let candidateSignals = []; // Collect candidates, execute top 5 after scan

    const apiKey = process.env.POLYGON_API_KEY;
    const raceFetch = (url) => Promise.race([
      fetch(url).then(r => r.json()),
      new Promise(resolve => setTimeout(() => resolve(null), 1500))
    ]).catch(() => null);

    // ── SPY benchmark tracking (#1, #2) ────────────────────────────────────────
    let spyDayChangePct = 0;
    try {
      const spySnap = await raceFetch('https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/SPY?apiKey=' + apiKey);
      const spyPrice = spySnap?.ticker?.day?.c || spySnap?.ticker?.lastTrade?.p || 0;
      const spyPrevClose = spySnap?.ticker?.prevDay?.c || 0;
      if (spyPrice > 0 && spyPrevClose > 0) {
        spyDayChangePct = ((spyPrice - spyPrevClose) / spyPrevClose) * 100;
      }

      if (spyPrice > 0) {
        // Read existing benchmark to preserve startPrice
        const sbUrl  = process.env.SUPABASE_URL;
        const sbHdrs = _sbHeaders();
        let startPrice = spyPrice;
        if (sbUrl && sbHdrs) {
          const existResp = await fetch(`${sbUrl}/rest/v1/bot_state?key=eq.spy_benchmark&select=value`, { headers: sbHdrs });
          const existRows = await existResp.json().catch(() => []);
          if (Array.isArray(existRows) && existRows.length) {
            const prev = JSON.parse(existRows[0].value);
            if (prev.startPrice > 0) startPrice = prev.startPrice;
          }
        }
        const totalReturn = parseFloat(((spyPrice - startPrice) / startPrice * 100).toFixed(2));
        writeBotState('spy_benchmark', JSON.stringify({
          price: spyPrice, date: new Date().toISOString().split('T')[0],
          startPrice, totalReturn
        }));

        // Alpha tracking (#2)
        const cap = capital || 10000;
        const { data: closedForAlpha } = await supabase
          .from('journal').select('entry_price, pnl_pct').not('pnl_pct', 'is', null);
        let nzrPnlDollars = 0;
        for (const t of (closedForAlpha || [])) {
          nzrPnlDollars += (parseFloat(t.entry_price) || 0) * ((parseFloat(t.pnl_pct) || 0) / 100);
        }
        const nzrReturn = parseFloat((nzrPnlDollars / cap * 100).toFixed(2));
        writeBotState('nzr_alpha', JSON.stringify({
          nzrReturn, spyReturn: totalReturn,
          alpha: parseFloat((nzrReturn - totalReturn).toFixed(2)),
          date: new Date().toISOString().split('T')[0]
        }));

        pushLog('SPY_BENCHMARK: price=$' + spyPrice.toFixed(2) + ' dayChg=' + spyDayChangePct.toFixed(2) + '% totalReturn=' + totalReturn + '% alpha=' + (nzrReturn - totalReturn).toFixed(2) + '%', 'info');
      }
    } catch(spyErr) {
      pushLog('SPY_BENCHMARK_ERROR: ' + spyErr.message, 'warn');
    }

    // ── Weekly P&L reset tracker (#8) ──────────────────────────────────────────
    try {
      const mondayDate = (() => {
        const d = new Date(nowET);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setDate(diff);
        return d.toISOString().split('T')[0];
      })();
      const weeklyKey = 'weekly_pnl';
      const sbUrl  = process.env.SUPABASE_URL;
      const sbHdrs = _sbHeaders();
      let weeklyData = { weekStart: mondayDate, weekPnl: 0, weekTrades: 0, weekWins: 0 };
      if (sbUrl && sbHdrs) {
        const wResp = await fetch(`${sbUrl}/rest/v1/bot_state?key=eq.${weeklyKey}&select=value`, { headers: sbHdrs });
        const wRows = await wResp.json().catch(() => []);
        if (Array.isArray(wRows) && wRows.length) {
          const prev = JSON.parse(wRows[0].value);
          if (prev.weekStart === mondayDate) {
            weeklyData = prev;
          } else {
            pushLog('WEEKLY_RESET: new week starting ' + mondayDate + ' (prev=' + prev.weekStart + ' pnl=' + prev.weekPnl + '% trades=' + prev.weekTrades + ')', 'info');
          }
        }
      }
      // Recalculate from journal for this week
      const { data: weekTrades } = await supabase.from('journal')
        .select('pnl_pct').gte('trade_date', mondayDate).not('pnl_pct', 'is', null);
      if (weekTrades && weekTrades.length > 0) {
        const wPnl = weekTrades.reduce((s, t) => s + (parseFloat(t.pnl_pct) || 0), 0);
        const wWins = weekTrades.filter(t => parseFloat(t.pnl_pct) > 0).length;
        weeklyData = {
          weekStart: mondayDate,
          weekPnl: parseFloat(wPnl.toFixed(2)),
          weekTrades: weekTrades.length,
          weekWinRate: weekTrades.length > 0 ? parseFloat((wWins / weekTrades.length * 100).toFixed(1)) : 0
        };
      }
      writeBotState(weeklyKey, JSON.stringify(weeklyData));
    } catch(weekErr) {
      pushLog('WEEKLY_PNL_ERROR: ' + weekErr.message, 'warn');
    }

    // ── Pre-fetch sector ETF snapshots for sector momentum filter (#4) ────────
    const sectorEtfCache = {};
    try {
      const etfs = ['QQQ', 'XLF', 'XLY', 'XLK', 'XLV', 'XLE', 'XLI'];
      const etfSnaps = await Promise.all(etfs.map(etf =>
        raceFetch('https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/' + etf + '?apiKey=' + apiKey)
      ));
      etfs.forEach((etf, i) => {
        const snap = etfSnaps[i];
        const cur = snap?.ticker?.day?.c || snap?.ticker?.lastTrade?.p || 0;
        const prev = snap?.ticker?.prevDay?.c || 0;
        sectorEtfCache[etf] = (cur > 0 && prev > 0) ? ((cur - prev) / prev * 100) : 0;
      });
      pushLog('SECTOR_ETFS: ' + etfs.map(e => e + '=' + (sectorEtfCache[e] || 0).toFixed(2) + '%').join(' '), 'info');
    } catch(sectorErr) {
      pushLog('SECTOR_ETF_ERROR: ' + sectorErr.message, 'warn');
    }

    // ── evaluateSymbol — two-phase: RSI pre-filter then full analysis ─────────
    let preFilterSkipped = 0;

    async function evaluateSymbol(symbol) {
      try {
        symbolsScanned++;
        const sector = sectorMap[symbol] || 'OTHER';

        // ── PHASE 1: Quick RSI pre-filter (saves API calls on 75-symbol universe) ──
        const [snapRes, rsiData] = await Promise.all([
          raceFetch('https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/' + symbol + '?apiKey=' + apiKey),
          raceFetch('https://api.polygon.io/v1/indicators/rsi/' + symbol + '?timespan=hour&adjusted=true&window=14&series_type=close&order=desc&limit=3&apiKey=' + apiKey),
        ]);

        const price = snapRes?.ticker?.day?.c || snapRes?.ticker?.lastTrade?.p || snapRes?.ticker?.prevDay?.c || null;
        if (!price) { pushLog('SKIP ' + symbol + ': no price', 'warn'); return; }

        const rsiValue = rsiData?.results?.values?.[0]?.value || 50;

        // Quick filter: skip full analysis if RSI is clearly out of range
        if (rsiValue < 40 || rsiValue > 75) {
          preFilterSkipped++;
          signalResults.push({ symbol, price, nrzScore: 0, direction: 'N/A', rsi: rsiValue, macdHist: 0, emaTrend: 'N/A', sector, status: 'PRE_FILTERED' });
          return;
        }

        // ── PHASE 2: Full indicator fetch for symbols that pass pre-filter ──────
        const [macdData, ema50Data, ema200Data, ema60Data, volData] = await Promise.all([
          raceFetch('https://api.polygon.io/v1/indicators/macd/' + symbol + '?timespan=hour&adjusted=true&short_window=12&long_window=26&signal_window=9&series_type=close&order=desc&limit=3&apiKey=' + apiKey),
          raceFetch('https://api.polygon.io/v1/indicators/ema/' + symbol + '?timespan=day&adjusted=true&window=50&series_type=close&order=desc&limit=1&apiKey=' + apiKey),
          raceFetch('https://api.polygon.io/v1/indicators/ema/' + symbol + '?timespan=day&adjusted=true&window=200&series_type=close&order=desc&limit=1&apiKey=' + apiKey),
          raceFetch('https://api.polygon.io/v1/indicators/ema/' + symbol + '?timespan=day&adjusted=true&window=60&series_type=close&order=desc&limit=1&apiKey=' + apiKey),
          raceFetch('https://api.polygon.io/v2/aggs/ticker/' + symbol + '/range/1/day/' +
            new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0] + '/' +
            new Date().toISOString().split('T')[0] + '?adjusted=true&sort=desc&limit=20&apiKey=' + apiKey),
        ]);

        // Extract indicator values
        const macdValue    = macdData?.results?.values?.[0]?.value || 0;
        const macdSig      = macdData?.results?.values?.[0]?.signal || 0;
        const macdHist     = macdData?.results?.values?.[0]?.histogram || 0;
        const macdHistPrev = macdData?.results?.values?.[1]?.histogram || 0;
        const ema50        = ema50Data?.results?.values?.[0]?.value || 0;
        const ema200       = ema200Data?.results?.values?.[0]?.value || 0;
        const ema60        = ema60Data?.results?.values?.[0]?.value || 0;

        // Volume: current vs 20-day average
        const volBars = volData?.results || [];
        const currentVol = volBars.length > 0 ? (volBars[0].v || 0) : 0;
        const avgVol = volBars.length > 1 ? volBars.slice(1).reduce((s, b) => s + (b.v || 0), 0) / Math.max(1, volBars.length - 1) : 0;
        const volAboveAvg = avgVol > 0 ? currentVol > avgVol : true;

        // Calculate NZR score
        let nrzScore = 40;

        // RSI scoring
        if (rsiValue > 50 && rsiValue < 70) nrzScore += 15;
        if (rsiValue < 50 && rsiValue > 30) nrzScore -= 10;
        if (rsiValue >= 70) nrzScore -= 20;
        if (rsiValue <= 30) nrzScore += 10;

        // MACD scoring
        if (macdHist > 0 && macdHist > macdHistPrev) nrzScore += 20;
        if (macdValue > macdSig) nrzScore += 15;
        if (macdHist < 0) nrzScore -= 15;

        // EMA trend scoring
        if (ema50 > 0 && ema200 > 0) {
          if (ema50 > ema200) nrzScore += 15;
          if (ema50 < ema200) nrzScore -= 10;
        }

        // Price vs EMA200
        if (ema200 > 0 && price > ema200) nrzScore += 10;
        if (ema200 > 0 && price < ema200) nrzScore -= 5;

        // Cap score 0–100
        nrzScore = Math.max(0, Math.min(100, nrzScore));

        // Determine direction
        const direction = (macdValue > macdSig && rsiValue > 45) ? 'LONG' : 'SHORT';

        pushLog(symbol + ' [' + sector + '] RSI=' + rsiValue.toFixed(1) + ' MACD_HIST=' + macdHist.toFixed(3) + ' EMA_TREND=' + (ema50 > ema200 ? 'BULL' : 'BEAR') + ' EMA60/200=' + (ema60 > ema200 ? 'GOLDEN' : 'DEATH') + ' VOL=' + (volAboveAvg ? 'ABOVE' : 'BELOW') + ' SCORE=' + nrzScore, nrzScore >= 75 ? 'pass' : 'info');

        signalResults.push({ symbol, price, nrzScore, direction, rsi: rsiValue, macdHist, emaTrend: ema50 > ema200 ? 'BULL' : 'BEAR', ema60, ema200, volAboveAvg, sector, status: nrzScore >= 75 ? 'SIGNAL' : 'FILTERED' });

        // ── Signal quality gate — filters reduce score or hard-reject ─────────
        if (nrzScore >= 75) {
          signalsFound++;
          const isHighConviction = nrzScore >= 90;
          let filtered = false;
          let filterReasons = [];

          // RSI between 45 and 68 (avoid overbought) — hard reject for standard, score penalty for high conviction
          if (rsiValue < 45 || rsiValue > 68) {
            if (isHighConviction) {
              nrzScore = Math.max(0, nrzScore - 10);
              filterReasons.push('RSI=' + rsiValue.toFixed(1) + '(penalty -10)');
            } else {
              pushLog('FILTER_RSI: ' + symbol + ' RSI=' + rsiValue.toFixed(1) + ' outside 45-68 range', 'info');
              filtered = true;
            }
          }
          // MACD histogram must be positive — hard reject for standard, score penalty for high conviction
          if (!filtered && macdHist <= 0) {
            if (isHighConviction) {
              nrzScore = Math.max(0, nrzScore - 10);
              filterReasons.push('MACD=' + macdHist.toFixed(3) + '(penalty -10)');
            } else {
              pushLog('FILTER_MACD: ' + symbol + ' MACD_HIST=' + macdHist.toFixed(3) + ' not positive', 'info');
              filtered = true;
            }
          }
          // EMA60 > EMA200 (golden cross) — score penalty only, never hard reject
          if (!filtered && ema60 > 0 && ema200 > 0 && ema60 <= ema200) {
            nrzScore = Math.max(0, nrzScore - 20);
            pushLog('FILTER_EMA: ' + symbol + ' EMA60=' + ema60.toFixed(2) + ' <= EMA200=' + ema200.toFixed(2) + ' no golden cross (score -20, now=' + nrzScore + ')', 'info');
            filterReasons.push('EMA_DEATH(penalty -20)');
          }
          // Volume above 20-day average — hard reject for standard, ignore for high conviction
          if (!filtered && !volAboveAvg) {
            if (isHighConviction) {
              filterReasons.push('LOW_VOL(bypassed)');
            } else {
              pushLog('FILTER_VOL: ' + symbol + ' volume below 20-day avg (cur=' + currentVol + ' avg=' + Math.round(avgVol) + ')', 'info');
              filtered = true;
            }
          }
          // SPY not down more than 1.5% today — hard block for all
          if (!filtered && spyDayChangePct < -1.5) {
            pushLog('FILTER_SPY: ' + symbol + ' skipped — SPY down ' + spyDayChangePct.toFixed(2) + '% (limit -1.5%)', 'warn');
            filtered = true;
          }

          if (filtered) {
            // Re-check score after penalties — might still be >= 75
            // (filtered = true means hard-rejected by a non-bypassable filter)
            return;
          }

          // Re-cap after penalties
          nrzScore = Math.max(0, Math.min(100, nrzScore));

          // After penalties, still need >= 75 to be a candidate
          if (nrzScore < 75) {
            pushLog('FILTER_SCORE_DROP: ' + symbol + ' score dropped to ' + nrzScore + ' after penalties (' + filterReasons.join(', ') + ') — below 75 threshold', 'info');
            return;
          }

          pushLog('SIGNAL: ' + symbol + ' [' + sector + '] ' + direction + ' score=' + nrzScore + (filterReasons.length ? ' (adjustments: ' + filterReasons.join(', ') + ')' : ' (passed all quality filters)'), 'pass');

          // Sector momentum filter — check sector ETF
          const sectorEtf = sectorMap[symbol] || null;
          let sectorSizeMultiplier = 1.0;
          if (sectorEtf && sectorEtfCache[sectorEtf] !== undefined) {
            if (sectorEtfCache[sectorEtf] < 0) {
              sectorSizeMultiplier = 0.5;
              pushLog('SECTOR_FILTER: ' + symbol + ' sector ' + sectorEtf + ' negative (' + sectorEtfCache[sectorEtf].toFixed(2) + '%) — reducing size 50%', 'warn');
            }
          }

          // Collect as candidate for top-5 ranking
          candidateSignals.push({
            symbol, direction, nrzScore, price, rsiValue, macdHist,
            emaTrend: ema50 > ema200 ? 'BULL' : 'BEAR',
            sector, sectorSizeMultiplier
          });
          pushLog('CANDIDATE_ADDED: ' + symbol + ' score=' + nrzScore + ' (total candidates=' + candidateSignals.length + ')', 'info');
        }

      } catch(err) {
        pushLog('ERROR ' + symbol + ': ' + err.message, 'warn');
      }
    }

    // ── Scan rotation: scan 25 symbols per cycle, rotating through universe ──
    const SYMBOLS_PER_CYCLE = 15;
    let scanStartIndex = 0;
    try {
      const sbUrl  = process.env.SUPABASE_URL;
      const sbHdrs = _sbHeaders();
      if (sbUrl && sbHdrs) {
        const idxResp = await fetch(`${sbUrl}/rest/v1/bot_state?key=eq.scan_batch_index&select=value`, { headers: sbHdrs });
        const idxRows = await idxResp.json().catch(() => []);
        if (Array.isArray(idxRows) && idxRows.length) {
          scanStartIndex = parseInt(idxRows[0].value, 10) || 0;
          if (scanStartIndex >= SCAN_UNIVERSE.length) scanStartIndex = 0;
        }
      }
    } catch(_) {}

    const scanEndIndex = Math.min(scanStartIndex + SYMBOLS_PER_CYCLE, SCAN_UNIVERSE.length);
    const scanSlice = SCAN_UNIVERSE.slice(scanStartIndex, scanEndIndex);
    pushLog('BATCH_SCAN: symbols ' + scanStartIndex + '-' + (scanEndIndex - 1) + ' of ' + SCAN_UNIVERSE.length, 'info');

    // Save next scan index for next cycle
    const nextIndex = scanEndIndex >= SCAN_UNIVERSE.length ? 0 : scanEndIndex;
    writeBotState('scan_batch_index', String(nextIndex));

    // ── Process symbols in parallel batches of 5 ─────────────────────────────
    const BATCH_SIZE = 5;
    for (let i = 0; i < scanSlice.length; i += BATCH_SIZE) {
      if (Date.now() - startTime > 20000) {
        pushLog('TIME_BUDGET: stopping early at batch starting ' + scanSlice[i] + ' (' + (Date.now() - startTime) + 'ms elapsed)', 'warn');
        break;
      }
      const batch = scanSlice.slice(i, i + BATCH_SIZE);
      pushLog('BATCH ' + (Math.floor(i / BATCH_SIZE) + 1) + ': ' + batch.join(','), 'info');
      await Promise.all(batch.map(symbol => evaluateSymbol(symbol)));
    }
    pushLog('PRE_FILTER: ' + preFilterSkipped + '/' + symbolsScanned + ' symbols skipped by RSI pre-filter (saved ~' + (preFilterSkipped * 5) + ' API calls)', 'info');

    // ── Execute signals — score-sorted, buy-gated by live position count ─────
    pushLog('EXECUTION_PHASE: ' + candidateSignals.length + ' candidates collected, ' + signalsFound + ' signals found, entering execution', 'info');
    candidateSignals.sort((a, b) => b.nrzScore - a.nrzScore);
    if (candidateSignals.length > 0) {
      pushLog('TOP_CANDIDATES: ' + candidateSignals.map(s => s.symbol + '(' + s.nrzScore + ')').join(', '), 'pass');
    }
    const topSignals = candidateSignals.slice(0, 5);
    if (candidateSignals.length > 5) {
      pushLog('RANK_FILTER: ' + candidateSignals.length + ' candidates, trading top 5: ' + topSignals.map(s => s.symbol + '(' + s.nrzScore + ')').join(', '), 'info');
    }

    let liveOpenCount = currentOpenCount; // track as we buy

    for (const sig of topSignals) {
      // Check 1: already own this symbol?
      if (ownedSymbols.has(sig.symbol)) {
        pushLog('ALREADY_OWNED: ' + sig.symbol + ' skipping', 'info');
        continue;
      }

      // Check 2: drawdown / exposure gates — hard block, no override
      if (drawdownPaused) {
        pushLog('SIGNAL_BLOCKED: ' + sig.symbol + ' — drawdown pause active', 'warn');
        continue;
      }
      if (overexposed) {
        pushLog('SIGNAL_BLOCKED: ' + sig.symbol + ' — portfolio overexposed (' + exposurePct.toFixed(1) + '%)', 'warn');
        continue;
      }
      if (posMgmt.totalUnrealizedPct < -5) {
        pushLog('SIGNAL_BLOCKED: ' + sig.symbol + ' — drawdown ' + posMgmt.totalUnrealizedPct + '% too deep', 'warn');
        continue;
      }

      // Check 3: position count gate — scored AFTER scan, not before
      if (sig.nrzScore >= 90 && liveOpenCount < 30) {
        // High conviction: buy up to hard cap 30
        pushLog('HIGH_CONVICTION_OVERRIDE: ' + sig.symbol + ' score=' + sig.nrzScore + ' positions=' + liveOpenCount + '/30 — forcing entry', 'pass');
      } else if (sig.nrzScore >= 75 && liveOpenCount < 25) {
        // Standard signal: buy under soft cap 25
        pushLog('SIGNAL_ENTRY: ' + sig.symbol + ' score=' + sig.nrzScore + ' positions=' + liveOpenCount + '/25', 'info');
      } else {
        pushLog('SIGNAL_BLOCKED: ' + sig.symbol + ' score=' + sig.nrzScore + ' — positions=' + liveOpenCount + ' (need <' + (sig.nrzScore >= 90 ? '30' : '25') + ')', 'warn');
        continue;
      }

      try {
        const posSize = dayAlloc * 0.10 * sig.sectorSizeMultiplier;
        const execResult = await executeSignal({
          symbol: sig.symbol, direction: sig.direction, mode: 'day', strategy: 'COMBINED',
          nrzScore: sig.nrzScore, entryPrice: sig.price, price: sig.price, atr: sig.price * 0.015,
          positionSize: posSize,
          rsi: sig.rsiValue,
          macdHist: sig.macdHist,
          emaTrend: sig.emaTrend,
        });
        if (execResult.executed) {
          tradesPlaced++;
          liveOpenCount++;
          ownedSymbols.add(sig.symbol);
          pushLog('TRADE_EXECUTED: ' + sig.symbol + ' ' + sig.direction + ' @ $' + sig.price + ' (rank #' + (topSignals.indexOf(sig) + 1) + '/' + candidateSignals.length + ' sectorMult=' + sig.sectorSizeMultiplier + ' positions=' + liveOpenCount + ')', 'pass');
        } else {
          pushLog('TRADE_SKIPPED: ' + sig.symbol + ' — ' + (execResult.reason || 'no reason'), 'info');
        }
      } catch(execErr) {
        pushLog('EXEC_ERROR: ' + sig.symbol + ' — ' + execErr.message, 'warn');
      }
    }

    const duration = Date.now() - startTime;
    pushLog('SCAN_DONE: ' + symbolsScanned + '/' + scanSlice.length + ' scanned (rotation ' + scanStartIndex + '-' + (scanEndIndex - 1) + ' of ' + SCAN_UNIVERSE.length + '), ' + signalsFound + ' signals, ' + tradesPlaced + ' trades, ' + duration + 'ms', 'info');

    // ── Performance attribution — track P&L and set drawdown pauses ─────────
    try { await trackBotPerformance(); } catch(e) { pushLog('PERF_TRACK_ERR: ' + e.message, 'warn'); }

    // Save result to Supabase for scanresult poll
    try {
      writeBotState('last_scan_result', JSON.stringify({
        success: true, symbolsScanned, signalsPassed: signalsFound, tradesPlaced,
        duration, results: signalResults.sort((a, b) => b.nrzScore - a.nrzScore),
        timestamp: new Date().toISOString()
      }));
    } catch(_) {}

    // Self-schedule: write next scan time so client-side trigger knows when to fire
    try {
      writeBotState('next_scan', new Date(Date.now() + 15 * 60 * 1000).toISOString());
    } catch(_) {}

    global.scanInProgress = false;
    return res.status(200).json({
      success: true,
      symbolsScanned,
      signalsPassed: signalsFound,
      tradesPlaced,
      duration: duration + 'ms',
      positionManagement: posMgmt,
      results: signalResults.sort((a, b) => b.nrzScore - a.nrzScore)
    });
  }

  // ── SCAN RESULT POLL ─────────────────────────────────────────────────────
  if (type === 'scanresult') {
    console.log('[BOT] SCANRESULT route matched');
    try {
      const sbUrl  = process.env.SUPABASE_URL;
      const sbHdrs = _sbHeaders();
      if (!sbUrl || !sbHdrs) return res.status(200).json({ symbolsScanned: 0, signalsFound: 0, tradesPlaced: 0, message: 'Supabase not configured' });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      let sr;
      try {
        sr = await fetch(`${sbUrl}/rest/v1/bot_state?key=eq.last_scan_result&select=value`, {
          headers: sbHdrs, signal: ctrl.signal,
        });
      } finally { clearTimeout(t); }
      if (!sr.ok) return res.status(200).json({ symbolsScanned: 0, signalsFound: 0, tradesPlaced: 0, message: 'State read failed' });
      const rows = await sr.json().catch(() => []);
      if (!Array.isArray(rows) || !rows.length) return res.status(200).json({ symbolsScanned: 0, signalsFound: 0, tradesPlaced: 0, message: 'No scan run yet' });
      const result = JSON.parse(rows[0].value);
      return res.status(200).json(result);
    } catch(e) {
      return res.status(200).json({ error: e.message, symbolsScanned: 0 });
    }
  }

  // ── BOT LOG ──────────────────────────────────────────────────────────────────
  if (type === 'log') {
    console.log('[BOT] LOG route matched');
    try {
      const since = req.query.since;
      let query = supabase.from('bot_logs').select('*').order('created_at', { ascending: false }).limit(100);
      if (since) query = query.gt('created_at', since);
      const { data: logs, error } = await query;
      if (error) throw error;
      const combined = [...botLogBuffer, ...(logs || [])].slice(0, 200);
      return res.json({ logs: combined, count: combined.length });
    } catch(e) {
      return res.json({ logs: botLogBuffer, count: botLogBuffer.length });
    }
  }

  // ── CRON SETUP INSTRUCTIONS ────────────────────────────────────────────────
  if (type === 'cronsetup') {
    console.log('[BOT] CRONSETUP route matched');
    const host = req.headers.host || 'your-domain.vercel.app';
    return res.status(200).json({
      message: 'Set up a free cron job at cron-job.org to call this endpoint every 15 minutes during market hours.',
      steps: [
        '1. Go to https://cron-job.org and create a free account',
        '2. Create a new cron job with these settings:',
        '   URL: https://' + host + '/api/bot?type=scan',
        '   Schedule: Every 15 minutes (*/15 * * * *)',
        '   Request method: GET',
        '3. Optionally restrict to market hours: */15 14-21 * * 1-5 (UTC) or */15 9-16 * * 1-5 (ET)',
        '4. Enable the job and save'
      ],
      scanUrl: 'https://' + host + '/api/bot?type=scan',
      recommendedSchedule: '*/15 14-21 * * 1-5'
    });
  }

  // ── SET CAPITAL (GET) ──────────────────────────────────────────────────────
  if (type === 'setcapital') {
    console.log('[BOT] SETCAPITAL route matched');
    const amount = parseFloat(req.query.amount);
    if (!amount || amount <= 0) return res.json({ error: 'invalid amount' });
    capitalAmount = amount;
    computeAllocations();
    const sbUrl  = process.env.SUPABASE_URL;
    const sbHdrs = _sbHeaders();
    if (sbUrl && sbHdrs) {
      try {
        await fetch(`${sbUrl}/rest/v1/bot_state`, {
          method: 'POST',
          headers: { ...sbHdrs, 'Prefer': 'resolution=merge-duplicates' },
          body: JSON.stringify({ key: 'capital_amount', value: String(amount), updated_at: new Date().toISOString() }),
        });
      } catch(_) {}
    }
    pushLog('CAPITAL_SET: $' + amount, 'info');
    return res.json({ success: true, capital: amount });
  }

  // ── STRATEGY WEIGHTS ─────────────────────────────────────────────────────────
  if (type === 'weights') {
    console.log('[BOT] WEIGHTS route matched');
    const DEFAULT_WEIGHTS = {
      MACD: 0.2, RSI: 0.2, EMA2050: 0.2, EMA60200: 0.2, COMBINED: 0.2,
      perfStats: {}, computedAt: null, tradeCount: 0,
    };
    try {
      const weights = await Promise.race([
        getOptimizedStrategyWeights(),
        new Promise(resolve => setTimeout(() => resolve(DEFAULT_WEIGHTS), 5000)),
      ]);
      return res.status(200).json(weights);
    } catch (err) {
      console.error('[bot/weights]', err.message);
      return res.status(200).json(DEFAULT_WEIGHTS);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // ACTION-BASED ROUTES — checked after type routes
  // ══════════════════════════════════════════════════════════════════════════════

  // ── KILL SWITCH ──────────────────────────────────────────────────────────────
  if (action === 'killswitch') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    const body = req.body || {};
    if (typeof body.active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });
    killSwitch = body.active;
    if (killSwitch) {
      dayState.active   = false;
      swingState.active = false;
      // Cancel ALL open Alpaca orders before halting
      const alpacaKey    = process.env.ALPACA_API_KEY;
      const alpacaSecret = process.env.ALPACA_SECRET_KEY;
      if (alpacaKey && alpacaSecret) {
        try {
          const ctrl  = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 10000);
          let cancelResp;
          try {
            cancelResp = await fetch(`${ALPACA_BASE}/v2/orders`, {
              method:  'DELETE',
              headers: {
                'APCA-API-KEY-ID':     alpacaKey,
                'APCA-API-SECRET-KEY': alpacaSecret,
                'Accept':              'application/json',
              },
              signal: ctrl.signal,
            });
          } finally { clearTimeout(timer); }
          pushLog(`KILL_SWITCH: cancelled all open orders (HTTP ${cancelResp.status})`, 'warn');
        } catch (err) {
          pushLog(`KILL_SWITCH: order cancellation error — ${err.message}`, 'warn');
        }
      }
    } else {
      dayState.active   = true;
      swingState.active = true;
    }
    writeBotState('kill_switch', killSwitch ? 'true' : 'false');
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
    writeBotState('capital_amount', String(capitalAmount));
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
        return cid.startsWith('NZR-DAY-') || cid.startsWith('NZR-day-') || p.mode === 'day';
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

  // ── STATUS (default for GET with no type and no action) ──────────────────────
  if (action === 'status' || (req.method === 'GET' && !action && !type)) {
    console.log('[BOT] STATUS route matched (default)');
    resetDayIfNeeded();
    resetSwingIfNeeded();
    const etMin = getETMinuteOfDay();
    const CLOSE_MIN = 15 * 60 + 45;
    const minsToClose = Math.max(0, CLOSE_MIN - etMin);
    return res.status(200).json({
      killSwitch,
      weeklyHalt,
      weeklyPnl: parseFloat(weeklyPnl.toFixed(4)),
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
    const prevDayPnl   = dayState.pnl;
    const prevSwingPnl = swingState.pnl;
    if (body.dayPnl   !== undefined) { const v = safeNum(body.dayPnl);   if (v !== null) dayState.pnl   = v; }
    if (body.swingPnl !== undefined) { const v = safeNum(body.swingPnl); if (v !== null) swingState.pnl = v; }

    // Track consecutive losses: meaningful P&L decrease = loss; increase = reset
    const delta = (dayState.pnl - prevDayPnl) + (swingState.pnl - prevSwingPnl);
    if (delta < -10) {
      consecutiveLosses++;
      writeBotState('consecutive_losses', String(consecutiveLosses));
      pushLog(`SYNC_PNL: loss Δ$${delta.toFixed(2)}, consecutive losses = ${consecutiveLosses}`, 'warn');
    } else if (delta > 10) {
      consecutiveLosses = 0;
      writeBotState('consecutive_losses', '0');
    }

    // Update weekly P&L as % of total capital
    if (delta !== 0) {
      const capForPnl = getEffectiveCapital();
      weeklyPnl += (delta / capForPnl) * 100;
      if (!weeklyHalt && weeklyPnl <= -3) {
        weeklyHalt = true;
        pushLog(`WEEKLY_HALT: weekly P&L hit ${weeklyPnl.toFixed(2)}% — halting new entries this week`, 'warn');
      }
      writeBotState(getWeeklyPnlKey(), JSON.stringify({ pct: parseFloat(weeklyPnl.toFixed(4)), halt: weeklyHalt }));
    }

    writeManyBotState([
      ['day_pnl',   String(dayState.pnl)],
      ['swing_pnl', String(swingState.pnl)],
    ]);
    return res.status(200).json({ dayPnl: dayState.pnl, swingPnl: swingState.pnl, consecutiveLosses, weeklyPnl: parseFloat(weeklyPnl.toFixed(4)), weeklyHalt });
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

    // Stop-hit detection: if price has breached the stop, mark symbol stopped-out
    const stopHit = (direction === 'LONG' && currentPrice <= stopPrice) ||
                    (direction === 'SHORT' && currentPrice >= stopPrice);
    if (stopHit) {
      markStoppedOut(sym);
      trailingStops.delete(key);
      writeBotState('trailing_stops', JSON.stringify(Object.fromEntries(trailingStops)));
      return res.status(200).json({
        symbol: sym, mode: md, stopHit: true, stopPrice,
        message: `Stop breached at ${currentPrice} — symbol marked stopped-out 2h`,
      });
    }

    // Progressive trailing stop logic (#7)
    if (direction === 'LONG') {
      highestPrice = Math.max(highestPrice, currentPrice);
      const gainPct = entryPrice > 0 ? ((highestPrice - entryPrice) / entryPrice * 100) : 0;

      if (gainPct >= 15) {
        // At +15%: trail at highest - 1%
        const newStop = roundLimitPrice(highestPrice * 0.99);
        if (newStop > stopPrice) { stopPrice = newStop; moved = true; stage = 5; }
        if (moved) console.log(`[bot] TRAIL ${sym}: stage 5 (1% trail) stop=$${stopPrice} gain=${gainPct.toFixed(1)}%`);
      } else if (gainPct >= 12) {
        // At +12%: trail at highest - 1.5%
        const newStop = roundLimitPrice(highestPrice * 0.985);
        if (newStop > stopPrice) { stopPrice = newStop; moved = true; stage = 4; }
        if (moved) console.log(`[bot] TRAIL ${sym}: stage 4 (1.5% trail) stop=$${stopPrice} gain=${gainPct.toFixed(1)}%`);
      } else if (gainPct >= 8) {
        // At +8%: trail at highest - 2%
        const newStop = roundLimitPrice(highestPrice * 0.98);
        if (newStop > stopPrice) { stopPrice = newStop; moved = true; stage = 3; }
        if (moved) console.log(`[bot] TRAIL ${sym}: stage 3 (2% trail) stop=$${stopPrice} gain=${gainPct.toFixed(1)}%`);
      } else if (gainPct >= 5) {
        // At +5%: move to breakeven
        if (stage < 2) {
          stage = 2;
          stopPrice = roundLimitPrice(entryPrice);
          moved = true;
          console.log(`[bot] TRAIL ${sym}: stage 2 (breakeven) stop=$${stopPrice} gain=${gainPct.toFixed(1)}%`);
        }
      } else if (stage === 1 && highestPrice >= target1) {
        stage = 2;
        stopPrice = roundLimitPrice(entryPrice);
        moved = true;
        console.log(`[bot] TRAIL ${sym}: stage 1→2 (breakeven at target1) stop=$${stopPrice}`);
      }
    } else { // SHORT — progressive trailing
      lowestPrice = Math.min(lowestPrice, currentPrice);
      const gainPct = entryPrice > 0 ? ((entryPrice - lowestPrice) / entryPrice * 100) : 0;

      if (gainPct >= 15) {
        const newStop = roundLimitPrice(lowestPrice * 1.01);
        if (newStop < stopPrice) { stopPrice = newStop; moved = true; stage = 5; }
        if (moved) console.log(`[bot] TRAIL ${sym}: stage 5 (1% trail) stop=$${stopPrice} gain=${gainPct.toFixed(1)}%`);
      } else if (gainPct >= 12) {
        const newStop = roundLimitPrice(lowestPrice * 1.015);
        if (newStop < stopPrice) { stopPrice = newStop; moved = true; stage = 4; }
        if (moved) console.log(`[bot] TRAIL ${sym}: stage 4 (1.5% trail) stop=$${stopPrice} gain=${gainPct.toFixed(1)}%`);
      } else if (gainPct >= 8) {
        const newStop = roundLimitPrice(lowestPrice * 1.02);
        if (newStop < stopPrice) { stopPrice = newStop; moved = true; stage = 3; }
        if (moved) console.log(`[bot] TRAIL ${sym}: stage 3 (2% trail) stop=$${stopPrice} gain=${gainPct.toFixed(1)}%`);
      } else if (gainPct >= 5) {
        if (stage < 2) {
          stage = 2;
          stopPrice = roundLimitPrice(entryPrice);
          moved = true;
          console.log(`[bot] TRAIL ${sym}: stage 2 (breakeven) stop=$${stopPrice} gain=${gainPct.toFixed(1)}%`);
        }
      } else if (stage === 1 && lowestPrice <= target1) {
        stage = 2;
        stopPrice = roundLimitPrice(entryPrice);
        moved = true;
        console.log(`[bot] TRAIL ${sym}: stage 1→2 (breakeven at target1) stop=$${stopPrice}`);
      }
    }

    const updatedAt = Date.now();
    trailingStops.set(key, { ...state, stage, stopPrice, highestPrice, lowestPrice, updatedAt });
    writeBotState('trailing_stops', JSON.stringify(Object.fromEntries(trailingStops)));
    return res.status(200).json({ symbol: sym, mode: md, stage, stopPrice, target1, target2, highestPrice, lowestPrice, moved, updatedAt });
  }

  // ── CRON ─────────────────────────────────────────────────────────────────────
  // Called by a Vercel cron job or external scheduler on a regular interval.
  // Sequence:
  //   1. 9:23–9:27 AM ET — pre-market gap protection (runs before market-status gate)
  //   2. Market status check — return early if Polygon says market is not 'open'
  //   3. 3:40–3:50 PM ET — EOD day-trade auto-close
  if (action === 'cron') {
    const etMin  = getETMinuteOfDay();
    const results = { etMinute: etMin, gapProtection: false, closedTrades: false, marketOpen: null };

    // ── Step 1: pre-market gap protection (9:23–9:27 AM ET) ──────────────────
    const GAP_START = 9 * 60 + 23;
    const GAP_END   = 9 * 60 + 27;
    if (etMin >= GAP_START && etMin <= GAP_END) {
      try {
        await runPreMarketGapProtection();
        results.gapProtection = true;
        console.log('[bot/cron] pre-market gap protection ran at ET minute', etMin);
      } catch (err) {
        console.error('[bot/cron] runPreMarketGapProtection error:', err.message);
        results.gapProtectionError = err.message;
      }
    }

    // ── Step 2: Polygon market status check ───────────────────────────────────
    const polygonKey = process.env.POLYGON_API_KEY;
    if (polygonKey) {
      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        let mResp;
        try {
          mResp = await fetch(
            `https://api.polygon.io/v1/marketstatus/now?apiKey=${polygonKey}`,
            { signal: ctrl.signal }
          );
        } finally { clearTimeout(timer); }

        if (mResp.ok) {
          const mData = await mResp.json().catch(() => ({}));
          results.marketOpen = mData.market === 'open';
          if (mData.market !== 'open') {
            console.log(`[bot/cron] market is "${mData.market}" — skipping trading checks`);
            const heartbeatTs = new Date().toISOString();
            writeBotState('last_heartbeat', heartbeatTs);
            results.heartbeat = heartbeatTs;
            return res.status(200).json({ ...results, message: 'market closed' });
          }
        }
      } catch (err) {
        console.warn('[bot/cron] market status check failed:', err.message);
        // fail-open: continue if status check errors
      }
    }

    // ── Step 2b: Update journal P&L for closed trades ─────────────────────────
    try {
      await updateClosedTrades();
      results.journalUpdated = true;
    } catch (err) {
      console.warn('[bot/cron] updateClosedTrades error:', err.message);
      results.journalUpdateError = err.message;
    }

    // ── Step 3: weekly halt status sync ──────────────────────────────────────
    if (!weeklyHalt && weeklyPnl <= -3) {
      weeklyHalt = true;
      writeBotState(getWeeklyPnlKey(), JSON.stringify({ pct: parseFloat(weeklyPnl.toFixed(4)), halt: true }));
      pushLog(`WEEKLY_HALT: cron detected weekly P&L at ${weeklyPnl.toFixed(2)}% — halting new entries`, 'warn');
    }

    // ── Step 4: EOD day-trade auto-close (3:40–3:50 PM ET) ───────────────────
    const CLOSE_START = 15 * 60 + 40;
    const CLOSE_END   = 15 * 60 + 50;
    if (etMin >= CLOSE_START && etMin <= CLOSE_END) {
      try {
        await closeExpiredDayTrades();
        results.closedTrades = true;
        console.log('[bot/cron] day-trade auto-close triggered at ET minute', etMin);
      } catch (err) {
        console.error('[bot/cron] closeExpiredDayTrades error:', err.message);
        results.error = err.message;
      }
    }

    // Heartbeat: record last successful cron execution
    const heartbeatTs = new Date().toISOString();
    writeBotState('last_heartbeat', heartbeatTs);
    results.heartbeat = heartbeatTs;

    return res.status(200).json(results);
  }

  // ── GAP SCAN ─────────────────────────────────────────────────────────────────
  if (action === 'gapscan') {
    // Callable 8:00–11:30 AM ET. GET or POST.
    try {
      const scanResult = await runGapScan();
      return res.status(200).json(scanResult);
    } catch (err) {
      console.error('[bot/gapscan]', err.message);
      return res.status(500).json({ error: 'Gap scan failed', detail: err.message });
    }
  }

  // ── PING — lightweight health check for browser/cron (GET or POST) ──────────
  if (type === 'ping') {
    return res.status(200).json({ status: 'ok', killSwitch, capitalAmount, timestamp: new Date().toISOString() });
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

  if (!capitalAmount || capitalAmount <= 0) {
    pushLog('CAPITAL_WARNING: no capital set for order validation, using default $' + getEffectiveCapital(), 'warn');
    computeAllocations();
  }

  await ensureStateLoaded(); // restore state from Supabase on cold start
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

  // 1a. WEEKLY HALT CHECK
  if (weeklyHalt) {
    pushLog(`WEEKLY_HALT_BLOCK: weekly P&L at ${weeklyPnl.toFixed(2)}% — no new entries until Monday`, 'block');
    return reject(`WEEKLY_HALT: portfolio down ${weeklyPnl.toFixed(2)}% this week — new entries halted until Monday`);
  }

  // 1b. MARKET REGIME CHECK
  const regime = await getMarketRegime().catch(() => ({ regime: 'neutral', adx: null, vix: null }));
  if (regime.regime === 'crisis') {
    pushLog(`REGIME_BLOCK: crisis regime detected, VIX=${regime.vix} ADX=${regime.adx}`, 'block');
    return reject(`REGIME_BLOCK: crisis regime detected (VIX ${regime.vix}, ADX ${regime.adx}) — no new entries, manage existing positions only`);
  }

  // 1c. MACRO RISK CHECK
  const macroRisk = await getMacroRisk().catch(() => ({ hasHighImpactToday: false, events: [], nextEvent: null }));
  let macroEntryThreshold = ENTRY_CONFIDENCE_THRESHOLD; // default 70
  let macroSizeMultiplier = 1.0;

  if (macroRisk.hasHighImpactToday) {
    macroEntryThreshold = 85;
    macroSizeMultiplier = 0.5;
    const eventName = macroRisk.nextEvent?.name || 'high-impact event';
    pushLog(`MACRO_RISK: high impact event today — ${eventName}, raising threshold to 85, halving position sizes`, 'warn');
  }

  if (macroRisk.nextEvent?.date) {
    const eventMs    = new Date(macroRisk.nextEvent.date).getTime();
    const remaining  = eventMs - Date.now();
    const twoHoursMs = 2 * 60 * 60 * 1000;
    if (remaining >= 0 && remaining < twoHoursMs) {
      const eventName = macroRisk.nextEvent.name;
      pushLog(`MACRO_BLOCK: ${eventName} in <2 hours, no new entries`, 'block');
      return reject(`MACRO_BLOCK: ${eventName} in <2 hours — no new entries`);
    }
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

  // 4b. STOPPED-OUT SYMBOL CHECK
  if (isStoppedOut(symbol)) {
    pushLog(`STOPPED_OUT_BLOCK: ${symbol} hit a stop recently — 2h re-entry block`, 'block');
    return reject(`STOPPED_OUT: ${symbol} hit a stop-loss recently — 2-hour re-entry block active`);
  }

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
    pushLog(`CORRELATION_GUARD: blocked ${symbol}, already ${corrGuard.sectorCount} positions in ${corrGuard.sector}`, 'block');
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
  if (macroSizeMultiplier < 1) {
    effectiveMaxPositionSize = parseFloat((effectiveMaxPositionSize * macroSizeMultiplier).toFixed(2));
    console.log(`[bot] MACRO_RISK: halving position size → $${effectiveMaxPositionSize}`);
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
  // Hard blocks for "avoid" (9:30–10:00 AM) and "close" (3:30–4:00 PM) are strict
  // risk rules — kept outside the scorer.  sessionPrime feeds the scorer as +10/−10.
  let session     = null;
  let sessionPrime = null;
  if (mode === 'day') {
    session = getSessionQuality();
    if (session === 'avoid') {
      console.log(`[bot] SESSION_FILTER: avoid zone, skipping ${symbol}`);
      return reject('SESSION_FILTER: opening shakeout zone (9:30–10:00 AM ET) — no new day trade entries');
    }
    if (session === 'close') {
      console.log(`[bot] SESSION_FILTER: close zone, skipping ${symbol}`);
      return reject('SESSION_FILTER: closing volatility zone (3:30–4:00 PM ET) — no new day trade entries');
    }
    // prime → +10, lunch → −10 in the weighted scorer
    sessionPrime = session === 'prime' ? true : session === 'lunch' ? false : null;
    console.log(`[bot] SESSION: ${symbol} zone=${session} sessionPrime=${sessionPrime}`);
  }

  // 7b.5 REGIME LEVERAGE CAP (choppy only — applied after direction is resolved)
  if (regime.regime === 'choppy' && rec.leverage > 1) {
    console.log(`[bot] REGIME: choppy market — capping leverage at 1× for ${symbol} (was ${rec.leverage}×)`);
    rec.leverage = 1;
  }

  // 8. CONCURRENT SIGNAL FETCH
  // All async sources run in parallel. Errors resolve to null (fail-open).
  // Results are normalised into signal inputs for resolveSignalScore below.
  const currentVolume   = safeNum(body.currentVolume ?? indicators?.volume);
  const isMacdCrossover = body.isMacdCrossover === true || body.signalType === 'macd';

  const [sentFetch, rsFetch, flowFetch, gapFetch, dailyFetch, weeklyFetch, volFetch, vwapFetch, sectorFetch, week52Fetch, weightsFetch] =
    await Promise.allSettled([
      getSymbolSentiment(symbol),
      getRelativeStrength(symbol, mode),
      getSymbolOptionsFlow(symbol),
      mode === 'day' ? getPreMarketGap(symbol)      : Promise.resolve(null),
      checkDailyTrend(symbol),
      mode === 'swing' ? checkWeeklyTrend(symbol)   : Promise.resolve(null),
      currentVolume != null
        ? checkVolumeConfirmation(symbol, currentVolume, mode, isMacdCrossover)
        : Promise.resolve(null),
      mode === 'day' ? calculateVWAP(symbol)        : Promise.resolve(null),
      getSectorRotationBot(),
      getWeek52Data(symbol),
      getOptimizedStrategyWeights(),
    ]);

  const getVal = r => r.status === 'fulfilled' ? r.value : null;
  const sentimentData  = getVal(sentFetch);
  const rsData         = getVal(rsFetch);
  const flowData       = getVal(flowFetch);
  const gapData        = getVal(gapFetch);
  const dailyTrend     = getVal(dailyFetch);
  const weeklyTrend    = getVal(weeklyFetch);
  const volData        = getVal(volFetch);
  const vwapData       = getVal(vwapFetch);
  const sectorTags     = getVal(sectorFetch);
  const week52Data     = getVal(week52Fetch);
  const strategyWeightsData = getVal(weightsFetch);

  if (sentFetch.status   === 'rejected') console.warn(`[bot] signal fetch: sentiment:`,    sentFetch.reason?.message);
  if (rsFetch.status     === 'rejected') console.warn(`[bot] signal fetch: RS:`,           rsFetch.reason?.message);
  if (flowFetch.status   === 'rejected') console.warn(`[bot] signal fetch: options flow:`, flowFetch.reason?.message);
  if (gapFetch.status    === 'rejected') console.warn(`[bot] signal fetch: gap:`,          gapFetch.reason?.message);
  if (dailyFetch.status  === 'rejected') console.warn(`[bot] signal fetch: daily trend:`,  dailyFetch.reason?.message);
  if (weeklyFetch.status === 'rejected') console.warn(`[bot] signal fetch: weekly trend:`, weeklyFetch.reason?.message);
  if (volFetch.status    === 'rejected') console.warn(`[bot] signal fetch: volume:`,       volFetch.reason?.message);
  if (vwapFetch.status   === 'rejected') console.warn(`[bot] signal fetch: VWAP:`,         vwapFetch.reason?.message);

  // ── Derive signal inputs ────────────────────────────────────────────────────

  // Indicator-derived signals (sync — from body.indicators)
  const rsiVal   = safeNum(indicators?.rsi);
  const macdHist = safeNum(indicators?.macdHistogram ?? indicators?.macd_histogram ?? indicators?.histogram);
  const ema60v   = safeNum(indicators?.ema60);
  const ema200v  = safeNum(indicators?.ema200);

  // MACD cross: true if histogram confirms the trade direction
  const macdCross = macdHist != null
    ? (direction === 'LONG' ? macdHist > 0 : macdHist < 0)
    : null;

  // RSI not extreme: true if 30–70
  const rsiNotExtreme = rsiVal != null ? (rsiVal >= 30 && rsiVal <= 70) : null;

  // EMA alignment: true if EMA60/EMA200 supports direction
  const emaAlignment = (ema60v != null && ema200v != null)
    ? (direction === 'LONG' ? ema60v > ema200v : ema60v < ema200v)
    : null;

  // Volume confirmed (null = not provided → fail-open; false = hard block)
  let volumeConfirmed = null;
  if (volData) {
    volumeConfirmed = volData.confirmed === true;
    if (!volData.confirmed) {
      const thr = isMacdCrossover ? '1.5' : '1.2';
      console.log(`[bot] VOLUME_GATE: ${symbol} ratio=${volData.ratio?.toFixed(2)} (need ${thr}×, avg=${volData.avgVolume})`);
    } else {
      console.log(`[bot] VOLUME_GATE: ${symbol} passed ratio=${volData.ratio?.toFixed(2)}`);
    }
  }

  // VWAP alignment (day): true = price is on the correct side for direction
  let aboveVwap = null;
  if (mode === 'day' && vwapData) {
    aboveVwap = direction === 'LONG' ? vwapData.aboveVwap === true : vwapData.aboveVwap === false;
    if (!aboveVwap)
      console.log(`[bot] VWAP: ${symbol} not aligned for ${direction} — price=${vwapData.currentPrice} vwap=${vwapData.vwap}`);
  }

  // Daily trend alignment (false + day = hard block in scorer; swing = soft miss)
  let dailyTrendAligned = null;
  if (dailyTrend) {
    dailyTrendAligned = direction === 'LONG' ? dailyTrend.bullish === true : dailyTrend.bearish === true;
    if (!dailyTrendAligned)
      console.log(`[bot] MTF: ${symbol} daily trend not aligned for ${direction} (EMA60=${dailyTrend.ema60} EMA200=${dailyTrend.ema200})`);
  }
  // Weekly trend alignment for swing mode (now wired into the scorer as a soft signal)
  let weeklyTrendAligned = null;
  if (mode === 'swing' && weeklyTrend) {
    weeklyTrendAligned = direction === 'LONG' ? weeklyTrend.bullish === true : weeklyTrend.bearish === true;
    console.log(`[bot] MTF weekly ${symbol}: aligned=${weeklyTrendAligned} (EMA20=${weeklyTrend.ema20} EMA50=${weeklyTrend.ema50})`);
  }

  // Sentiment: raw −10..+10 score passed through directly
  const sentimentScore = sentimentData ? sentimentData.score : null;

  // Relative strength: RS ratio (symbol vs SPY)
  const relativeStrength = rsData ? rsData.rs : null;

  // Options flow score: raw −20..+20 passed through; capture smart money tag
  const optionsFlowScore = flowData ? flowData.score : null;
  const flowSmartMoney   = flowData?.smartMoney === true;

  // Gap boost: net point adjustment from getPreMarketGap (day trades, 9:30–11:30 AM ET)
  let gapBoost = null;
  let gapTag   = null;
  if (mode === 'day' && gapData) {
    const { gapPct, gapType, dayOpen, currentPrice: gapCurrent } = gapData;
    const absGap   = Math.abs(gapPct);
    const etMinNow = getETMinuteOfDay();
    const inGapWindow = etMinNow >= 9 * 60 + 30 && etMinNow < 11 * 60 + 30;
    if (inGapWindow) {
      let adj = 0;
      if      (gapType === 'gap_up'   && direction === 'LONG'  && absGap >= 4) { adj = +20; gapTag = 'STRONG_GAP_UP'; }
      else if (gapType === 'gap_up'   && direction === 'LONG'  && absGap >= 2) { adj = +15; gapTag = 'GAP_UP_PLAY'; }
      else if (gapType === 'gap_down' && direction === 'SHORT' && absGap >= 2) { adj = +15; gapTag = 'GAP_DOWN_SHORT'; }
      // Gap fade: after 10:00 AM ET, gap_up stock trading below the open
      const afterTen = etMinNow >= 10 * 60;
      if (afterTen && gapType === 'gap_up' && dayOpen != null && gapCurrent != null && gapCurrent < dayOpen) {
        adj -= 10;
        gapTag = gapTag ? `${gapTag}+FADE` : 'GAP_FADE';
        console.log(`[bot] GAP_FADE: ${symbol} gap_up fading — current $${gapCurrent} < open $${dayOpen}`);
      }
      if (adj !== 0) {
        gapBoost = adj;
        pushLog(`GAP_SCAN: ${symbol} gap=${gapPct.toFixed(2)}% type=${gapType} tag=${gapTag}`, adj > 0 ? 'pass' : 'warn');
      }
    }
  }

  // Regime ok (crisis already hard-blocked at step 1b; this is belt-and-suspenders)
  const regimeOk = regime.regime !== 'crisis';

  // Derive sector tag and 52-week data for scorer
  const symbolSectorEtf = sectorMap[symbol];
  const sectorTag       = (symbolSectorEtf && sectorTags) ? (sectorTags[symbolSectorEtf] ?? null) : null;
  const rsiValueRaw     = safeNum(indicators?.rsi?.value);

  // 9. COMPOSITE SIGNAL SCORE
  // resolveSignalScore enforces hard requirements (volume, daily trend day mode, regime)
  // and accumulates weighted points for everything else.
  // Entry threshold: composite.score >= macroEntryThreshold (default 70, 85 on macro days)
  const composite = resolveSignalScore(symbol, direction, {
    macdCross,
    rsiNotExtreme,
    emaAlignment,
    volumeConfirmed,
    aboveVwap,
    dailyTrendAligned,
    sessionPrime,
    sentimentScore,
    relativeStrength,
    optionsFlowScore,
    gapBoost,
    regimeOk,
    sectorTag,
    nearHigh:             week52Data?.nearHigh      ?? null,
    nearLow:              week52Data?.nearLow       ?? null,
    pctFrom52High:        week52Data?.pctFrom52High ?? null,
    rsiValue:             rsiValueRaw,
    weeklyTrendAligned,
    strategyWeights: strategyWeightsData
      ? { MACD: strategyWeightsData.MACD, RSI: strategyWeightsData.RSI,
          EMA2050: strategyWeightsData.EMA2050, EMA60200: strategyWeightsData.EMA60200,
          COMBINED: strategyWeightsData.COMBINED }
      : null,
  }, mode);

  if (composite.blocked) {
    return reject(composite.blockReason);
  }

  if (composite.score < macroEntryThreshold) {
    const parts = Object.entries(composite.breakdown)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}:${v > 0 ? '+' : ''}${v}`)
      .join(' ');
    return reject(`NZR score ${composite.score} below entry threshold (${macroEntryThreshold}). Breakdown: [${parts}]`);
  }

  // Collect human-readable trade tags for the approved response
  const tradeTags = [];
  if (flowSmartMoney && flowData?.volumeRatio)
    tradeTags.push(`Smart money: ${(flowData.volumeRatio * 100).toFixed(0)}% calls`);
  if (gapTag) tradeTags.push(gapTag);

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
              pushLog(`SR_ORDER: ${symbol} limit set at ${limitPrice} based on support ${srLevelUsed}`, 'info');
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
              pushLog(`SR_ORDER: ${symbol} limit set at ${limitPrice} based on resistance ${srLevelUsed}`, 'info');
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
    effectiveMaxPositionSize, composite.score, symbol
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

  // Persist cooldowns and trade counts to Supabase (fire-and-forget)
  const cooldownsSnapshot = Object.fromEntries(
    [...recentOrders.entries()].map(([k, v]) => [k, v.timestamp])
  );
  writeManyBotState([
    ['cooldowns',   JSON.stringify(cooldownsSnapshot)],
    ['day_trades',  String(dayState.trades)],
    ['swing_trades', String(swingState.trades)],
  ]);

  // ATR-based dynamic stop (falls back to fixed-pct if Polygon unavailable)
  let stopLoss, target, target2, atrValue = null;
  const atrResult = await getATRStop(symbol, mode, limitPrice, direction).catch(() => null);

  if (atrResult) {
    stopLoss  = atrResult.stopPrice;
    target    = atrResult.target1;
    target2   = atrResult.target2;
    atrValue  = atrResult.atr;
    pushLog(`ATR_STOP: ${symbol} entry=$${limitPrice} stop=$${stopLoss} atr=${atrValue}`, 'pass');

    // Register position in trailing stop tracker (stage 1) and persist
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
    writeBotState('trailing_stops', JSON.stringify(Object.fromEntries(trailingStops)));
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

  // ── Enriched order tag: NZR-{MODE}-{STRATEGY}-{SIGNAL}-{SYMBOL}-{TIMESTAMP} ──
  // STRATEGY: which indicator had the highest single positive contribution
  const bd = composite.breakdown;
  const strategyTag = (bd.macdCross > 0)     ? 'MACD'
                    : (bd.emaAlignment > 0)   ? 'EMA60200'
                    : (bd.rsiNotExtreme > 0)  ? 'RSI'
                    : 'COMBINED';

  // SIGNAL: highest-priority contextual signal (gap > options > RS > VWAP > trend)
  const signalTag = (() => {
    if (gapTag) {
      // Normalise gap tag to a short clean token (no + suffix)
      const base = gapTag.split('+')[0];
      if (base === 'STRONG_GAP_UP') return 'GAP_UP';
      if (base === 'GAP_UP_PLAY')   return 'GAP_UP';
      if (base === 'GAP_DOWN_SHORT') return 'GAP_DN';
      if (base === 'GAP_FADE')      return 'GAP_FADE';
      return base.slice(0, 8);
    }
    if (flowSmartMoney || (bd.optionsFlowScore != null && bd.optionsFlowScore >= 8))
      return direction === 'LONG' ? 'OPT_BULL' : 'OPT_BEAR';
    if (bd.relativeStrength != null && bd.relativeStrength >= 10) return 'RS_STR';
    if (bd.aboveVwap != null && bd.aboveVwap > 0)
      return direction === 'LONG' ? 'VWAP_L' : 'VWAP_S';
    if (bd.dailyTrendAligned != null && bd.dailyTrendAligned > 0) return 'TREND';
    return 'BASE';
  })();

  // Timestamp in seconds (10 digits) to keep total length within Alpaca's 48-char limit
  const tsSeconds = Math.floor(ts / 1000);
  const clientOrderId = `NZR-${mode.toUpperCase()}-${strategyTag}-${signalTag}-${symbol}-${tsSeconds}`.slice(0, 48);

  pushLog(`SIGNAL_PASS: ${mode.toUpperCase()} ${direction} ${symbol} score=${composite.score} entry=${limitPrice} stop=${stopLoss} T1=${target}`, 'pass');

  // ── Fire-and-forget: submit order to Alpaca (non-blocking, errors caught inside)
  executeSignal({
    symbol,
    direction,
    mode,
    strategy:     strategyTag,
    nrzScore:     composite.score,
    entryPrice:   limitPrice,
    stopPrice:    stopLoss,
    target1:      target,
    target2:      target2 ?? null,
    positionSize: adaptiveMax,
    atr:          atrValue,
  }).catch(err => console.error('[bot] executeSignal unexpected error:', err.message));

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
    leverage:        rec.leverage ?? 1,
    nzrScore:        composite.score,
    confidence:      composite.score,  // alias — backwards compatible
    reasoning:       rec.reasoning ?? '',
    signalBreakdown: composite.breakdown,
    tradeTags:       tradeTags.length ? tradeTags : undefined,
    clientOrderId,
    timestamp:       ts,
    riskChecks: {
      killSwitch:    'inactive',
      lossLimit:     'passed',
      tradeCount:    `passed (${mode === 'day' ? dayState.trades : swingState.trades}/${mode === 'day' ? dayState.maxTradesDay : swingState.maxTradesWeek})`,
      cooldown:      'passed',
      positionLimit: 'passed',
      exposure:      'passed',
      positionSize:  'passed',
      signalScore:   `passed (${composite.score}/70 threshold)`,
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

  // ── CATCH-ALL — ensure every code path returns a response ─────────────────
  if (!res.headersSent) {
    return res.status(200).json({ error: 'unhandled_route', type: req.query.type });
  }
};
