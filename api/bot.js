/**
 * NZR Trading Bot — Risk Management Engine
 * All order validation, safety rules, and position sizing live here.
 * Module-level state persists across requests within the same serverless instance.
 */

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

// ─── MODULE-LEVEL STATE ──────────────────────────────────────────────────────
let killSwitch = false;

let riskRules = {
  maxPositionSize:  1000,   // max $ per trade
  maxTotalExposure: 5000,   // max total portfolio $ exposure
  maxDailyLoss:     -500,   // halt if daily P&L drops below this
  maxTradesPerDay:  10,     // max trades per calendar day (ET)
  cooldownMinutes:  15,     // minutes between trades on same symbol
  slippagePct:      0.001,  // 0.10% slippage on auto limit price
};

let dailyTrades = 0;
let dailyPnl    = 0;
let dailyResetDateET = '';  // YYYY-MM-DD in ET timezone

// symbol → { timestamp: ms }
const recentOrders = new Map();

// ─── RATE LIMITING ───────────────────────────────────────────────────────────
const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 30;
  const entry = rateLimit.get(ip);
  if (!entry || now - entry.start > w) {
    rateLimit.set(ip, { count: 1, start: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function todayET() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}

function resetDailyCountersIfNeeded() {
  const today = todayET();
  if (today !== dailyResetDateET) {
    dailyTrades        = 0;
    dailyPnl           = 0;
    dailyResetDateET   = today;
  }
}

function sanitizeSymbol(raw) {
  return String(raw || '').replace(/[^A-Z0-9.\-]/g, '').slice(0, 10).toUpperCase();
}

function safeNum(v, fallback = null) {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
}

// Round limit price per exchange convention
function roundLimitPrice(price) {
  if (price == null) return null;
  if (price > 100) {
    // Nearest $0.05
    return Math.round(price / 0.05) * 0.05;
  }
  // Nearest $0.01
  return Math.round(price * 100) / 100;
}

// Auto-set limit price with slippage
function calcLimitPrice(lastPrice, direction, slippagePct) {
  if (lastPrice == null) return null;
  const slip = slippagePct ?? riskRules.slippagePct;
  let raw;
  if (direction === 'LONG') {
    raw = lastPrice * (1 + slip);    // pay slightly above — ensures fill
  } else {
    raw = lastPrice * (1 - slip);    // sell slightly below — ensures fill
  }
  return roundLimitPrice(raw);
}

// ─── DUPLICATE / COOLDOWN CHECK ──────────────────────────────────────────────
function checkCooldown(symbol, cooldownMs) {
  const entry = recentOrders.get(symbol);
  if (!entry) return { ok: true };
  const elapsed = Date.now() - entry.timestamp;
  if (elapsed < cooldownMs) {
    const remaining = Math.ceil((cooldownMs - elapsed) / 1000);
    return { ok: false, remaining };
  }
  return { ok: true };
}

// ─── DIRECTION RECOMMENDATION ─────────────────────────────────────────────────
function recommendDirection(ind) {
  if (!ind) return { direction: 'NEUTRAL — no trade', leverage: 1, confidence: 0, reasoning: 'No indicators provided.' };

  const rsi            = safeNum(ind.rsi);
  const macdHistogram  = safeNum(ind.macdHistogram ?? ind.macd_histogram ?? ind.histogram);
  const ema60          = safeNum(ind.ema60);
  const ema200         = safeNum(ind.ema200);
  const goldenCross    = ind.goldenCross ?? ind.golden_cross ?? null;

  // Resolve goldenCross — accept string signal or object
  const gcSignal = typeof goldenCross === 'string'
    ? goldenCross
    : goldenCross?.signal ?? null;
  const isFreshGolden  = gcSignal === 'Fresh Golden Cross';
  const isGolden       = gcSignal === 'Golden Cross' || isFreshGolden;
  const isFreshDeath   = gcSignal === 'Fresh Death Cross';
  const isDeath        = gcSignal === 'Death Cross'  || isFreshDeath;

  // Bullish signal count: ema60 > ema200, rsi < 70 (not overbought), macdHistogram > 0
  let bullish = 0;
  const reasons = { bullish: [], bearish: [] };

  if (ema60 !== null && ema200 !== null && ema60 > ema200) {
    bullish++;
    reasons.bullish.push(`EMA60 ($${ema60.toFixed(2)}) above EMA200 ($${ema200.toFixed(2)})`);
  }
  if (rsi !== null && rsi < 70) {
    bullish++;
    reasons.bullish.push(`RSI ${rsi.toFixed(1)} — not overbought`);
  }
  if (macdHistogram !== null && macdHistogram > 0) {
    bullish++;
    reasons.bullish.push(`MACD histogram positive (${macdHistogram.toFixed(4)})`);
  }

  // Bearish signal count: ema60 < ema200, rsi > 30 (not oversold — room to fall), macdHistogram < 0
  let bearish = 0;
  if (ema60 !== null && ema200 !== null && ema60 < ema200) {
    bearish++;
    reasons.bearish.push(`EMA60 ($${ema60.toFixed(2)}) below EMA200 ($${ema200.toFixed(2)})`);
  }
  if (rsi !== null && rsi > 30) {
    bearish++;
    reasons.bearish.push(`RSI ${rsi.toFixed(1)} — not oversold (room to fall)`);
  }
  if (macdHistogram !== null && macdHistogram < 0) {
    bearish++;
    reasons.bearish.push(`MACD histogram negative (${macdHistogram.toFixed(4)})`);
  }

  let direction, confidence, reasoning;
  if (bullish >= 3) {
    direction  = 'LONG';
    confidence = Math.round((bullish / 3) * 70 + (isFreshGolden ? 25 : isGolden ? 15 : 0));
    reasoning  = `${bullish}/3 bullish signals: ${reasons.bullish.join('; ')}.${isFreshGolden ? ' ⚡ Fresh Golden Cross adds high conviction.' : isGolden ? ' Golden Cross supports uptrend.' : ''}`;
  } else if (bearish >= 3) {
    direction  = 'SHORT';
    confidence = Math.round((bearish / 3) * 70 + (isFreshDeath ? 25 : isDeath ? 15 : 0));
    reasoning  = `${bearish}/3 bearish signals: ${reasons.bearish.join('; ')}.${isFreshDeath ? ' ⚡ Fresh Death Cross adds high conviction.' : isDeath ? ' Death Cross supports downtrend.' : ''}`;
  } else {
    direction  = 'NEUTRAL — no trade';
    confidence = 0;
    reasoning  = `Mixed signals — ${bullish} bullish, ${bearish} bearish. Need 3+ aligned signals to trade.`;
    return { direction, leverage: 1, confidence, reasoning };
  }

  // Leverage calculation
  let leverage = 1;
  let leverageReason = '';
  // Hard block: RSI overextended
  if (rsi !== null && (rsi > 75 || rsi < 25)) {
    leverage = 1;
    leverageReason = `No leverage — RSI ${rsi.toFixed(1)} is overextended (>${75} or <${25})`;
  } else if (isFreshGolden && rsi !== null && rsi >= 40 && rsi <= 60 && macdHistogram !== null && macdHistogram > 0) {
    leverage = 3;
    leverageReason = 'Max 3x — Fresh Golden Cross + RSI in neutral zone (40-60) + positive MACD histogram';
  } else if ((isGolden || isDeath) && !isFreshGolden && !isFreshDeath) {
    leverage = 2;
    leverageReason = 'Max 2x — established trend confirmed by EMA cross';
  } else {
    leverage = 1;
    leverageReason = 'Max 1x — mixed or incomplete signals, no leverage';
  }
  leverage = Math.min(leverage, 3);

  confidence = Math.min(100, confidence);

  return { direction, leverage, confidence, reasoning: reasoning + ' ' + leverageReason };
}

// ─── STALE ORDER DETECTION ───────────────────────────────────────────────────
function findStaleOrders(orders) {
  if (!Array.isArray(orders)) return [];
  const staleThresholdMs = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();
  return orders
    .filter(o => {
      if (!o || o.status !== 'pending') return false;
      const ts = o.timestamp ? new Date(o.timestamp).getTime() : 0;
      return (now - ts) > staleThresholdMs;
    })
    .map(o => o.id ?? o.orderId ?? o.symbol);
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) {
    return res.status(429).json({ rejected: true, reason: 'Rate limit reached. Please wait.' });
  }

  const action = req.query.action || '';

  // ── KILL SWITCH TOGGLE ──────────────────────────────────────────────────────
  if (action === 'killswitch') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    const body = req.body || {};
    if (typeof body.active !== 'boolean') {
      return res.status(400).json({ error: 'active (boolean) required in body' });
    }
    killSwitch = body.active;
    console.log(`[bot] Kill switch ${killSwitch ? 'ACTIVATED' : 'deactivated'}`);
    return res.status(200).json({ killSwitch, message: `Kill switch ${killSwitch ? 'activated — all trading halted' : 'deactivated — trading resumed'}` });
  }

  // ── SET RULES ───────────────────────────────────────────────────────────────
  if (action === 'setrules') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
    const body = req.body || {};
    const allowed = ['maxPositionSize','maxTotalExposure','maxDailyLoss','maxTradesPerDay','cooldownMinutes','slippagePct'];
    const updated = {};
    for (const key of allowed) {
      if (body[key] !== undefined) {
        const val = safeNum(body[key]);
        if (val === null) return res.status(400).json({ error: `${key} must be a number` });
        riskRules[key] = val;
        updated[key]   = val;
      }
    }
    console.log('[bot] Risk rules updated:', updated);
    return res.status(200).json({ message: 'Risk rules updated', riskRules });
  }

  // ── GET CURRENT STATE ───────────────────────────────────────────────────────
  if (action === 'status' || (req.method === 'GET' && !action)) {
    resetDailyCountersIfNeeded();
    return res.status(200).json({
      killSwitch,
      riskRules,
      dailyTrades,
      dailyPnl,
      dailyDate: dailyResetDateET,
    });
  }

  // ── ORDER VALIDATION ─────────────────────────────────────────────────────────
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const body = req.body || {};

  // ── Input validation ────────────────────────────────────────────────────────
  const rawSymbol = body.symbol;
  if (!rawSymbol) return res.status(400).json({ rejected: true, reason: 'symbol is required', timestamp: Date.now() });

  const symbol = sanitizeSymbol(rawSymbol);
  if (!symbol) return res.status(400).json({ rejected: true, reason: 'Invalid symbol', symbol: rawSymbol, timestamp: Date.now() });

  const timestamp = Date.now();

  function reject(reason) {
    return res.status(200).json({ approved: false, rejected: true, reason, symbol, timestamp });
  }

  // Parse configurable params, falling back to module-level rules
  const cooldownMs      = (safeNum(body.cooldownMinutes) ?? riskRules.cooldownMinutes) * 60 * 1000;
  const slippagePct     = safeNum(body.slippagePct)      ?? riskRules.slippagePct;
  const maxPositionSize = safeNum(body.maxPositionSize)  ?? riskRules.maxPositionSize;
  const maxTotalExposure= safeNum(body.maxTotalExposure) ?? riskRules.maxTotalExposure;
  const maxDailyLoss    = safeNum(body.maxDailyLoss)     ?? riskRules.maxDailyLoss;
  const maxTradesPerDay = safeNum(body.maxTradesPerDay)  ?? riskRules.maxTradesPerDay;

  // Reset daily counters if needed
  resetDailyCountersIfNeeded();

  // Sync external daily P&L if provided (e.g. from broker feed)
  if (body.dailyPnl !== undefined) {
    const ext = safeNum(body.dailyPnl);
    if (ext !== null) dailyPnl = ext;
  }

  // ── 1. KILL SWITCH ──────────────────────────────────────────────────────────
  // Also honour per-request killSwitch flag
  const reqKillSwitch = typeof body.killSwitch === 'boolean' ? body.killSwitch : false;
  if (killSwitch || reqKillSwitch) {
    if (reqKillSwitch && !killSwitch) killSwitch = true; // persist it
    return reject('Kill switch active — all trading halted');
  }

  // ── 2. DAILY LOSS CHECK ─────────────────────────────────────────────────────
  if (dailyPnl <= maxDailyLoss) {
    return reject(`Max daily loss reached ($${dailyPnl.toFixed(2)}) — trading halted for today`);
  }

  // ── 3. DAILY TRADE COUNT ────────────────────────────────────────────────────
  if (dailyTrades >= maxTradesPerDay) {
    return reject(`Max trades per day reached (${dailyTrades}/${maxTradesPerDay}) — trading halted until midnight ET`);
  }

  // ── 4. DUPLICATE / COOLDOWN ─────────────────────────────────────────────────
  const cooldownResult = checkCooldown(symbol, cooldownMs);
  if (!cooldownResult.ok) {
    return reject(`Duplicate order — cooldown active for ${symbol} (${cooldownResult.remaining}s remaining)`);
  }

  // ── 5. MAX 1 POSITION PER SYMBOL ────────────────────────────────────────────
  const openPositions = Array.isArray(body.openPositions) ? body.openPositions : [];
  const hasPosition = openPositions.some(p => {
    const s = sanitizeSymbol(p?.symbol ?? p?.ticker ?? '');
    return s === symbol;
  });
  if (hasPosition) {
    return reject(`Position already open for ${symbol} — close existing position before re-entering`);
  }

  // ── 6. TOTAL EXPOSURE CHECK ──────────────────────────────────────────────────
  const currentExposure = safeNum(body.totalExposure) ?? 0;
  if (currentExposure >= maxTotalExposure) {
    return reject(`Max total exposure reached ($${currentExposure.toFixed(2)}/$${maxTotalExposure}) — reduce positions first`);
  }

  // ── 7. STALE ORDER DETECTION ─────────────────────────────────────────────────
  const staleOrders = findStaleOrders(body.orders);

  // ── 8. INDICATORS → DIRECTION RECOMMENDATION ─────────────────────────────────
  const indicators = body.indicators || null;
  const recommendation = recommendDirection(indicators);

  // Override direction if explicitly provided and valid
  const rawDirection = String(body.direction || '').toUpperCase();
  const direction = (rawDirection === 'LONG' || rawDirection === 'SHORT')
    ? rawDirection
    : recommendation.direction;

  // If direction is NEUTRAL, reject unless caller forced a direction
  if (direction === 'NEUTRAL — no trade' || direction === 'NEUTRAL') {
    return reject('Neutral signal — insufficient directional conviction to trade');
  }
  if (direction !== 'LONG' && direction !== 'SHORT') {
    return reject(`Invalid direction: ${direction}. Use LONG or SHORT.`);
  }

  // ── 9. LIMIT PRICE — NEVER MARKET ORDERS ─────────────────────────────────────
  const lastPrice = safeNum(body.lastPrice ?? body.price ?? indicators?.price);
  let limitPrice  = safeNum(body.limitPrice);
  let autoLimitSet = false;

  if (limitPrice != null) {
    // Caller provided a limit price — validate and round it
    limitPrice   = roundLimitPrice(limitPrice);
    autoLimitSet = false;
  } else if (lastPrice != null) {
    // Auto-calculate limit price from last trade / bid price
    limitPrice   = calcLimitPrice(lastPrice, direction, slippagePct);
    autoLimitSet = true;
    console.log(`[bot] Auto limit set: ${symbol} @ $${limitPrice} (${direction}, ${(slippagePct * 100).toFixed(2)}% slippage)`);
  } else {
    return reject('limitPrice or lastPrice required to set a limit order — market orders are not permitted');
  }

  if (limitPrice == null || !isFinite(limitPrice) || limitPrice <= 0) {
    return reject('Could not calculate a valid limit price — order rejected');
  }

  // ── 10. POSITION SIZE CHECK ───────────────────────────────────────────────────
  const quantity      = safeNum(body.quantity) ?? 1;
  const positionValue = limitPrice * quantity;
  if (positionValue > maxPositionSize) {
    return reject(`Position size $${positionValue.toFixed(2)} exceeds max allowed $${maxPositionSize} — reduce quantity`);
  }

  // ── ALL CHECKS PASSED ─────────────────────────────────────────────────────────
  // Record this order in the cooldown map
  recentOrders.set(symbol, { timestamp });

  // Increment daily trade counter
  dailyTrades++;

  const leverage   = recommendation.leverage   ?? 1;
  const confidence = recommendation.confidence ?? 0;
  const reasoning  = recommendation.reasoning  ?? '';

  const approved = {
    approved:      true,
    symbol,
    direction,
    type:          'limit',
    limitPrice,
    quantity,
    positionValue: parseFloat(positionValue.toFixed(2)),
    slippagePct,
    autoLimitSet,
    leverage,
    confidence,
    reasoning,
    timestamp,
    staleOrders:   staleOrders.length ? staleOrders : undefined,
    riskChecks: {
      duplicatePrevention: 'passed',
      positionLimit:       'passed',
      cooldown:            'passed',
      killSwitch:          'inactive',
      positionSize:        'passed',
      exposure:            'passed',
      dailyLoss:           'passed',
      dailyTrades:         `passed (${dailyTrades}/${maxTradesPerDay} today)`,
    },
  };

  console.log(`[bot] Order approved: ${direction} ${quantity}x ${symbol} @ $${limitPrice} | leverage ${leverage}x | confidence ${confidence}%`);
  return res.status(200).json(approved);
};
