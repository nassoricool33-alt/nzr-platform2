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

  // 8. LIMIT PRICE
  const lastPrice  = safeNum(body.lastPrice ?? body.price ?? indicators?.price);
  let   limitPrice = safeNum(body.limitPrice);
  let   autoSet    = false;

  if (limitPrice != null) {
    limitPrice = roundLimitPrice(limitPrice);
  } else if (lastPrice != null) {
    limitPrice = calcLimitPrice(lastPrice, direction);
    autoSet = true;
  } else {
    return reject('limitPrice or lastPrice required — market orders not permitted');
  }

  if (!limitPrice || !isFinite(limitPrice) || limitPrice <= 0) {
    return reject('Could not calculate a valid limit price');
  }

  // 9. POSITION SIZE
  const quantity      = safeNum(body.quantity) ?? 1;
  const positionValue = limitPrice * quantity;
  if (positionValue > bucket.maxPositionSize) {
    return reject(`Position size $${positionValue.toFixed(2)} exceeds max $${bucket.maxPositionSize.toFixed(2)} for ${mode} mode`);
  }

  // ── APPROVED ──────────────────────────────────────────────────────────────────
  recentOrders.set(`${mode}:${symbol}`, { timestamp: ts });
  if (mode === 'day') dayState.trades++;
  else swingState.trades++;

  const stopLoss   = direction === 'LONG'
    ? roundLimitPrice(limitPrice * (1 - bucket.stopLossPct))
    : roundLimitPrice(limitPrice * (1 + bucket.stopLossPct));
  const riskPerShare = Math.abs(limitPrice - stopLoss);
  const target       = direction === 'LONG'
    ? roundLimitPrice(limitPrice + riskPerShare * bucket.minRR)
    : roundLimitPrice(limitPrice - riskPerShare * bucket.minRR);

  const clientOrderId = `NZR-${mode}-${symbol}-${ts}`;

  console.log(`[bot] ${mode.toUpperCase()} order approved: ${direction} ${quantity}x ${symbol} @ $${limitPrice} | stop $${stopLoss} | target $${target}`);

  return res.status(200).json({
    approved: true,
    symbol,
    mode,
    direction,
    type:           'limit',
    limitPrice,
    stopLoss,
    target,
    riskReward:     `${bucket.minRR}:1`,
    quantity,
    positionValue:  parseFloat(positionValue.toFixed(2)),
    autoLimitSet:   autoSet,
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
    },
  });
};
