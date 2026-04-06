/**
 * NZR — Pharma Trading Bot
 * Pharma-specific risk engine with 8 risk rules.
 * Requires env vars: POLYGON_KEY, ALPACA_KEY_ID, ALPACA_SECRET_KEY
 * Optional:          ALPACA_BASE_URL (default: paper trading)
 */

const https = require('https');

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];
const DEFAULT_ALPACA = 'paper-api.alpaca.markets';

// ── Halal verified symbols ─────────────────────────────────────────────────────
const HALAL_VERIFIED = new Set(['MRNA','PFE','BIIB','GILD','AMGN','LLY','NVO','VRTX']);

// ── FDA hardcoded calendar (mirrors pharma.js) ─────────────────────────────────
const FDA_HARDCODED = [
  { ticker: 'BIIB', date: '2026-06-15', drug: 'Lecanemab (Leqembi)' },
  { ticker: 'LLY',  date: '2026-07-02', drug: 'Donanemab' },
  { ticker: 'JNJ',  date: '2026-06-28', drug: 'Imetelstat' },
  { ticker: 'MRNA', date: '2026-08-10', drug: 'mRNA-1283' },
];

// ── Bot state ─────────────────────────────────────────────────────────────────
let botState = {
  running: false,
  mode: 'day',           // 'day' | 'swing'
  halalOnly: false,
  positions: {},         // symbol → { entryPrice, qty, entryTime, mode, stopLoss, takeProfit, stopType }
  tradeLog: [],
  lastCheck: null,
  positionCount: 0,
  maxPositions: 3,
  stats: { wins: 0, losses: 0, totalPnl: 0 },
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
function httpsReq({ hostname, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const opts = {
      hostname, path, method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...headers,
      },
    };
    const req = https.request(opts, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: d ? JSON.parse(d) : null }); }
        catch { resolve({ status: r.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function polyGet(path) {
  const key = process.env.POLYGON_KEY;
  const sep = path.includes('?') ? '&' : '?';
  return httpsReq({ hostname: 'api.polygon.io', path: `${path}${sep}apiKey=${key}`, method: 'GET', headers: {} });
}

async function alpacaReq(method, path, body) {
  const rawBase = process.env.ALPACA_BASE_URL || DEFAULT_ALPACA;
  const hostname = rawBase.replace(/^https?:\/\//, '');
  return httpsReq({
    hostname, path, method, body,
    headers: {
      'APCA-API-KEY-ID':     process.env.ALPACA_KEY_ID,
      'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function sanitizeSymbol(s) { return String(s || '').replace(/[^A-Z0-9]/g, '').slice(0, 10).toUpperCase(); }

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

// ── Rule 1: Catalyst Blackout ─────────────────────────────────────────────────
function checkCatalystBlacklist(symbol, confidence = 0) {
  const hours = hoursUntilFDA(symbol);
  if (hours === null) return { blocked: false };

  if (hours <= 12) {
    // Within 12h: must close position unless confidence >85% and reduced size
    return { blocked: true, reason: 'FDA catalyst <12h — close position', forceClose: true };
  }
  if (hours <= 24) {
    if (confidence >= 0.85) {
      return { blocked: false, reason: 'FDA <24h but high confidence — cap at 25% size', capSize: 0.25 };
    }
    return { blocked: true, reason: 'FDA catalyst <24h — no entry' };
  }
  return { blocked: false };
}

// ── Rule 2: Post-Catalyst rules ───────────────────────────────────────────────
// After FDA decision: if approved → hold max 3 days, then sell into strength
// If rejected → exit immediately if held, avoid for 5 days
function postCatalystCheck(symbol) {
  // Simplified: if we have a position and FDA date just passed (<24h ago)
  const ev = FDA_HARDCODED.find(e => e.ticker === symbol);
  if (!ev) return { status: 'none' };
  const hoursAgo = (new Date() - new Date(ev.date)) / 3600000;
  if (hoursAgo >= 0 && hoursAgo <= 72) {
    return { status: 'post_catalyst', hoursAgo: +hoursAgo.toFixed(1), drug: ev.drug };
  }
  return { status: 'none' };
}

// ── Rule 3: Pharma position sizing ───────────────────────────────────────────
function calcPharmaPositionSize(accountEquity, mode, confidence, isShortSqueeze) {
  let pct;
  if (isShortSqueeze) pct = 0.03;
  else if (confidence >= 0.85) pct = 0.08;
  else pct = 0.05;

  const maxPositions = botState.maxPositions;
  const openPositions = Object.keys(botState.positions).length;
  if (openPositions >= maxPositions) return 0;

  return accountEquity * pct;
}

// ── Rule 4: Stop losses ───────────────────────────────────────────────────────
function calcPharmaStop(entryPrice, mode, isFDA, isShortSqueeze) {
  let stopPct;
  if (isFDA) stopPct = 0.12;
  else if (isShortSqueeze) stopPct = 0.05;
  else if (mode === 'swing') stopPct = 0.08;
  else stopPct = 0.03;
  return +(entryPrice * (1 - stopPct)).toFixed(2);
}

// ── Rule 5: Take profits ──────────────────────────────────────────────────────
function calcPharmaTakeProfit(entryPrice, mode, isFDA, isShortSqueeze, isApproval) {
  let tpPct;
  if (isFDA && isApproval) tpPct = Math.random() * 0.15 + 0.25; // 25–40%
  else if (isFDA) tpPct = 0.20;
  else if (isShortSqueeze) tpPct = 0.15;
  else if (mode === 'swing') tpPct = 0.15;
  else tpPct = 0.04;
  return +(entryPrice * (1 + tpPct)).toFixed(2);
}

// ── Rule 6: Halal filter ──────────────────────────────────────────────────────
function checkHalal(symbol, halalOnly) {
  const verified = HALAL_VERIFIED.has(symbol);
  if (halalOnly && !verified) {
    return { allowed: false, reason: `${symbol} not in HALAL VERIFIED list`, halalStatus: 'UNVERIFIED' };
  }
  return { allowed: true, halalStatus: verified ? 'HALAL VERIFIED' : 'UNVERIFIED' };
}

// ── Rule 7: Short squeeze rules ───────────────────────────────────────────────
function evalShortSqueeze(changePct, relVol, rsi) {
  if (relVol >= 3 && changePct >= 8 && rsi < 80) {
    return {
      isSqueezeCandidate: true,
      trailingStopPct: 0.04,
      maxHoldHours: 2,
      reason: `Rel vol ${relVol}x, +${changePct.toFixed(1)}%, RSI ${rsi?.toFixed(0)}`,
    };
  }
  return { isSqueezeCandidate: false };
}

// ── Rule 8: Earnings surprise rules ──────────────────────────────────────────
function evalEarningsSurprise(surprisePct) {
  if (surprisePct >= 10) {
    return { action: 'long', waitMinutes: 0, reason: `Beat by ${surprisePct.toFixed(1)}% — long on first pullback` };
  }
  if (surprisePct <= -10) {
    return { action: 'short', waitMinutes: 30, reason: `Miss by ${Math.abs(surprisePct).toFixed(1)}% — short after 30min` };
  }
  return { action: 'hold', reason: 'Earnings within normal range' };
}

// ── Position management ───────────────────────────────────────────────────────
async function checkAndClosePositions(currentPrices) {
  const closedSymbols = [];
  for (const [sym, pos] of Object.entries(botState.positions)) {
    const price = currentPrices[sym];
    if (!price) continue;

    let shouldClose = false, closeReason = '';

    // Catalyst blackout force-close
    const catalystCheck = checkCatalystBlacklist(sym, 0);
    if (catalystCheck.forceClose) {
      shouldClose = true;
      closeReason = catalystCheck.reason;
    }

    // Stop loss hit
    if (!shouldClose && price <= pos.stopLoss) {
      shouldClose = true;
      closeReason = 'Stop Loss';
    }

    // Take profit hit
    if (!shouldClose && price >= pos.takeProfit) {
      shouldClose = true;
      closeReason = 'Take Profit';
    }

    // Short squeeze max hold (2h)
    if (!shouldClose && pos.isShortSqueeze) {
      const holdMs = Date.now() - pos.entryTime;
      if (holdMs >= 2 * 3600000) {
        shouldClose = true;
        closeReason = 'Short Squeeze Max Hold (2h)';
      }
      // Trailing stop for squeeze
      if (!shouldClose && pos.trailingStopPct) {
        const trailStop = price * (1 - pos.trailingStopPct);
        if (trailStop > pos.stopLoss) pos.stopLoss = +trailStop.toFixed(2);
      }
    }

    if (shouldClose) {
      try {
        const r = await alpacaReq('DELETE', `/v2/positions/${sym}`, null);
        const exitPrice = price;
        const pnl = (exitPrice - pos.entryPrice) * pos.qty;
        const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

        botState.tradeLog.unshift({
          symbol: sym,
          action: 'EXIT',
          qty: pos.qty,
          entryPrice: pos.entryPrice,
          exitPrice,
          pnl: +pnl.toFixed(2),
          pnlPct: +pnlPct.toFixed(2),
          reason: closeReason,
          time: new Date().toISOString(),
          result: pnl >= 0 ? 'WIN' : 'LOSS',
        });

        if (pnl >= 0) botState.stats.wins++;
        else botState.stats.losses++;
        botState.stats.totalPnl += pnl;
        botState.tradeLog = botState.tradeLog.slice(0, 100);

        delete botState.positions[sym];
        botState.positionCount = Object.keys(botState.positions).length;
        closedSymbols.push(sym);
      } catch (err) {
        console.error(`[pharmabot] Failed to close ${sym}:`, err.message);
      }
    }
  }
  return closedSymbols;
}

// ── Signal evaluation ─────────────────────────────────────────────────────────
async function evalEntrySignal(symbol, accountEquity) {
  const sym = sanitizeSymbol(symbol);

  // Halal check
  const halalCheck = checkHalal(sym, botState.halalOnly);
  if (!halalCheck.allowed) return { skip: true, reason: halalCheck.reason };

  // Max positions check
  if (Object.keys(botState.positions).length >= botState.maxPositions) {
    return { skip: true, reason: `Max ${botState.maxPositions} positions reached` };
  }

  // Already in this position
  if (botState.positions[sym]) {
    return { skip: true, reason: `Already holding ${sym}` };
  }

  // Catalyst blackout check
  const catalystCheck = checkCatalystBlacklist(sym, 0);
  if (catalystCheck.blocked) return { skip: true, reason: catalystCheck.reason };

  // Fetch live data
  let prevDay;
  try {
    const r = await polyGet(`/v2/aggs/ticker/${sym}/prev`);
    prevDay = r.body?.results?.[0];
  } catch { return { skip: true, reason: 'Failed to fetch price data' }; }

  if (!prevDay) return { skip: true, reason: 'No price data' };

  const price = prevDay.c;
  const changePct = prevDay.o > 0 ? ((prevDay.c - prevDay.o) / prevDay.o) * 100 : 0;

  // Get 30d bars for RSI and rel vol
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
  let bars = [];
  try {
    const r = await polyGet(`/v2/aggs/ticker/${sym}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=40`);
    bars = r.body?.results || [];
  } catch { /* no bars */ }

  const closes = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);

  // Simple RSI
  let rsi = null;
  if (closes.length >= 15) {
    let gains = 0, losses = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gains += d; else losses += Math.abs(d);
    }
    const avgGain = gains / 14, avgLoss = losses / 14;
    rsi = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
  }

  // Relative volume
  const avgVol = volumes.length >= 20 ? volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 : 0;
  const relVol = avgVol > 0 ? +(prevDay.v / avgVol).toFixed(2) : 1;

  // Short squeeze check
  const squeezeEval = evalShortSqueeze(changePct, relVol, rsi);

  // Basic signal criteria: oversold or trend reversal candidate
  const isBullish = (rsi !== null && rsi < 40) || (changePct > 0 && relVol > 1.5);
  if (!isBullish && !squeezeEval.isSqueezeCandidate) {
    return { skip: true, reason: `No signal — RSI ${rsi?.toFixed(0)}, change ${changePct.toFixed(1)}%` };
  }

  const isFDA = daysUntilFDA(sym) !== null && daysUntilFDA(sym) <= 30;
  const confidence = Math.min(0.9, 0.5 + (rsi !== null ? (50 - rsi) / 100 : 0) + (relVol > 2 ? 0.1 : 0));
  const positionValue = calcPharmaPositionSize(accountEquity, botState.mode, confidence, squeezeEval.isSqueezeCandidate);

  if (positionValue <= 0) return { skip: true, reason: 'Position size is zero' };

  const qty = Math.floor(positionValue / price);
  if (qty < 1) return { skip: true, reason: 'Insufficient buying power for 1 share' };

  const stopLoss    = calcPharmaStop(price, botState.mode, isFDA, squeezeEval.isSqueezeCandidate);
  const takeProfit  = calcPharmaTakeProfit(price, botState.mode, isFDA, squeezeEval.isSqueezeCandidate, false);

  return {
    skip: false,
    symbol: sym,
    price,
    qty,
    positionValue: +(qty * price).toFixed(2),
    stopLoss,
    takeProfit,
    confidence: +confidence.toFixed(2),
    isShortSqueeze: squeezeEval.isSqueezeCandidate,
    isFDA,
    rsi: rsi !== null ? +rsi.toFixed(2) : null,
    relVol,
    changePct: +changePct.toFixed(2),
    halalStatus: halalCheck.halalStatus,
    trailingStopPct: squeezeEval.trailingStopPct || null,
    signalReason: squeezeEval.isSqueezeCandidate ? squeezeEval.reason : `RSI ${rsi?.toFixed(0)}, rel vol ${relVol}x`,
  };
}

// ── Action handlers ───────────────────────────────────────────────────────────

async function handleStatus() {
  return {
    running: botState.running,
    mode: botState.mode,
    halalOnly: botState.halalOnly,
    positionCount: Object.keys(botState.positions).length,
    maxPositions: botState.maxPositions,
    positions: Object.entries(botState.positions).map(([sym, p]) => ({
      symbol: sym,
      qty: p.qty,
      entryPrice: p.entryPrice,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      isShortSqueeze: p.isShortSqueeze || false,
      entryTime: p.entryTime ? new Date(p.entryTime).toISOString() : null,
    })),
    stats: botState.stats,
    lastCheck: botState.lastCheck,
    tradeLog: botState.tradeLog.slice(0, 20),
  };
}

async function handleStart(body) {
  if (botState.running) return { ok: false, error: 'Bot already running' };

  botState.mode     = ['day','swing'].includes(body.mode) ? body.mode : 'day';
  botState.halalOnly = body.halalOnly === true || body.halalOnly === 'true';
  botState.running  = true;
  botState.lastCheck = new Date().toISOString();

  console.log(`[pharmabot] Started — mode=${botState.mode} halalOnly=${botState.halalOnly}`);
  return { ok: true, mode: botState.mode, halalOnly: botState.halalOnly };
}

async function handleStop() {
  botState.running = false;
  return { ok: true, message: 'Bot stopped' };
}

async function handleRules(symbol) {
  if (!symbol) return { error: 'symbol required' };
  const sym = sanitizeSymbol(symbol);
  const fdaDays = daysUntilFDA(sym);
  const fdaHours = hoursUntilFDA(sym);
  const catalystCheck = checkCatalystBlacklist(sym, 0.6);
  const halalCheck = checkHalal(sym, false);
  const postCatalyst = postCatalystCheck(sym);

  return {
    symbol: sym,
    halalStatus: halalCheck.halalStatus,
    catalystBlacklist: catalystCheck,
    fdaDaysAway: fdaDays,
    fdaHoursAway: fdaHours,
    postCatalyst,
    stopLossRules: {
      day:   '3% from entry',
      swing: '8% from entry',
      fda:   '12% from entry',
      squeeze: '5% + 4% trailing',
    },
    takeProfitRules: {
      day:     '4% from entry',
      swing:   '15% from entry (max 30 days)',
      fdaApproval: '25–40% from entry',
      squeeze: '15% from entry (max 2 hours)',
    },
    positionSizeRules: {
      normal:       '5% of equity',
      highConfidence: '8% of equity (confidence ≥ 85%)',
      shortSqueeze: '3% of equity',
      maxPositions: 3,
    },
    shortSqueezeRules: {
      entryConditions: 'relVol ≥ 3×, change ≥ 8%, RSI < 80',
      trailingStop: '4%',
      maxHold: '2 hours',
    },
    earningsSurpriseRules: {
      beat: 'Long on first pullback (beat > 10%)',
      miss: 'Short after 30 min wait (miss > 10%)',
    },
  };
}

async function handleTrade(body) {
  if (!botState.running) return { ok: false, error: 'Bot not running' };

  const sym = sanitizeSymbol(body.symbol);
  if (!sym) return { ok: false, error: 'symbol required' };

  // Check credentials
  if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) {
    return { ok: false, error: 'Alpaca not configured' };
  }

  // Get account equity
  let equity = 100000;
  try {
    const acct = await alpacaReq('GET', '/v2/account', null);
    equity = safeNum(acct.body?.equity) || equity;
  } catch { /* use default */ }

  const signal = await evalEntrySignal(sym, equity);
  if (signal.skip) return { ok: false, skipped: true, reason: signal.reason };

  // Place market order
  try {
    const orderBody = {
      symbol: sym,
      qty: signal.qty,
      side: 'buy',
      type: 'market',
      time_in_force: botState.mode === 'day' ? 'day' : 'gtc',
    };
    const r = await alpacaReq('POST', '/v2/orders', orderBody);
    if (r.status !== 200 && r.status !== 201) {
      return { ok: false, error: `Alpaca order failed: ${JSON.stringify(r.body)}` };
    }

    // Track position
    botState.positions[sym] = {
      qty: signal.qty,
      entryPrice: signal.price,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      entryTime: Date.now(),
      isShortSqueeze: signal.isShortSqueeze,
      trailingStopPct: signal.trailingStopPct,
      isFDA: signal.isFDA,
      mode: botState.mode,
    };
    botState.positionCount = Object.keys(botState.positions).length;

    botState.tradeLog.unshift({
      symbol: sym,
      action: 'ENTER',
      qty: signal.qty,
      entryPrice: signal.price,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      positionValue: signal.positionValue,
      reason: signal.signalReason,
      halalStatus: signal.halalStatus,
      time: new Date().toISOString(),
    });
    botState.tradeLog = botState.tradeLog.slice(0, 100);

    return {
      ok: true,
      symbol: sym,
      qty: signal.qty,
      entryPrice: signal.price,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      positionValue: signal.positionValue,
      halalStatus: signal.halalStatus,
      isShortSqueeze: signal.isShortSqueeze,
      orderId: r.body?.id,
    };
  } catch (err) {
    console.error('[pharmabot] trade error:', err.message);
    return { ok: false, error: err.message };
  }
}

async function handleCheck() {
  // Check all open positions against current prices
  if (Object.keys(botState.positions).length === 0) {
    return { checked: 0, closed: [], message: 'No open positions' };
  }

  const symbols = Object.keys(botState.positions);
  const currentPrices = {};

  await Promise.all(symbols.map(async sym => {
    try {
      const r = await polyGet(`/v2/aggs/ticker/${sym}/prev`);
      const bar = r.body?.results?.[0];
      if (bar) currentPrices[sym] = bar.c;
    } catch { /* skip */ }
  }));

  const closed = await checkAndClosePositions(currentPrices);
  botState.lastCheck = new Date().toISOString();

  return {
    checked: symbols.length,
    closed,
    currentPrices,
    remainingPositions: Object.keys(botState.positions).length,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'Rate limit reached' });

  const action = String(req.query.action || '').toLowerCase();

  try {
    if (action === 'status' && req.method === 'GET') {
      return res.status(200).json(await handleStatus());
    }

    if (action === 'start' && req.method === 'POST') {
      return res.status(200).json(await handleStart(req.body || {}));
    }

    if (action === 'stop' && req.method === 'POST') {
      return res.status(200).json(await handleStop());
    }

    if (action === 'rules' && req.method === 'GET') {
      const symbol = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
      return res.status(200).json(await handleRules(symbol));
    }

    if (action === 'trade' && req.method === 'POST') {
      return res.status(200).json(await handleTrade(req.body || {}));
    }

    if (action === 'check' && req.method === 'POST') {
      return res.status(200).json(await handleCheck());
    }

    return res.status(400).json({ error: `Unknown action: ${action}. Valid: status, start, stop, rules, trade, check` });

  } catch (err) {
    console.error('[pharmabot]', action, err.message);
    return res.status(500).json({ error: 'Pharma bot error', detail: err.message });
  }
};
