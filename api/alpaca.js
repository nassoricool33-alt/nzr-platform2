/**
 * NZR — Alpaca Broker Proxy
 * All Alpaca API calls go through here so credentials never touch the browser.
 * Requires env vars: ALPACA_API_KEY, ALPACA_SECRET_KEY
 * Optional:          ALPACA_BASE_URL (default: paper trading)
 */

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];
const DEFAULT_BASE    = 'https://paper-api.alpaca.markets'; // swap to 'https://api.alpaca.markets' for live

// ── Attribution cache — 10 minute TTL ────────────────────────────────────────
let _attributionCache = null;
const ATTRIBUTION_CACHE_TTL = 10 * 60 * 1000;

const ATTRIBUTION_EMPTY = {
  error: null, trades: [], byStrategy: [], bySignal: [],
  byTimeOfDay: [], byDayOfWeek: [], totalTrades: 0, overallWinRate: 0,
};

const rateLimit = new Map();
function checkRate(ip) {
  const now = Date.now(), w = 60000, max = 30;
  const e = rateLimit.get(ip);
  if (!e || now - e.start > w) { rateLimit.set(ip, { count: 1, start: now }); return true; }
  if (e.count >= max) return false;
  e.count++; return true;
}

async function alpacaRequest({ baseUrl, method, path, body, keyId, secretKey }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
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
    let responseBody = null;
    try { responseBody = await response.json(); } catch { /* empty body */ }
    return { status: response.status, body: responseBody };
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  if (!checkRate(ip)) return res.status(429).json({ error: 'Rate limit reached' });

  const keyId     = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  console.log('[alpaca] API key present:', !!keyId);
  console.log('[alpaca] Secret key present:', !!secretKey);
  if (!keyId || !secretKey) {
    return res.status(503).json({ error: 'Alpaca keys not configured', connected: false });
  }

  const rawBase = process.env.ALPACA_BASE_URL || DEFAULT_BASE;
  const baseUrl = rawBase.startsWith('http') ? rawBase.replace(/\/$/, '') : `https://${rawBase}`;
  const action  = req.query.action || '';
  const ctx     = { baseUrl, keyId, secretKey };

  try {
    // ── GET positions ───────────────────────────────────────────────────────
    if (action === 'positions' && req.method === 'GET') {
      const r = await alpacaRequest({ ...ctx, method: 'GET', path: '/v2/positions' });
      return res.status(r.status).json(r.body);
    }

    // ── GET orders ──────────────────────────────────────────────────────────
    if (action === 'orders' && req.method === 'GET') {
      const status = req.query.status || 'open';
      const after  = req.query.after  || '';
      const limit  = req.query.limit  || '500';
      let path = `/v2/orders?status=${encodeURIComponent(status)}&limit=${limit}`;
      if (after) path += `&after=${encodeURIComponent(after)}`;
      const r = await alpacaRequest({ ...ctx, method: 'GET', path });
      return res.status(r.status).json(r.body);
    }

    // ── DELETE cancel single order ──────────────────────────────────────────
    if (action === 'cancel' && req.method === 'DELETE') {
      const orderId = String(req.query.orderId || '').replace(/[^a-zA-Z0-9\-]/g, '');
      if (!orderId) return res.status(400).json({ error: 'orderId required' });
      const r = await alpacaRequest({ ...ctx, method: 'DELETE', path: `/v2/orders/${orderId}` });
      return res.status(r.status).json(r.body ?? { cancelled: true });
    }

    // ── DELETE cancel all open orders ───────────────────────────────────────
    if (action === 'cancelall' && req.method === 'DELETE') {
      const r = await alpacaRequest({ ...ctx, method: 'DELETE', path: '/v2/orders' });
      return res.status(r.status).json(r.body ?? { cancelled: true });
    }

    // ── POST place order ────────────────────────────────────────────────────
    if (action === 'order' && req.method === 'POST') {
      const b = req.body || {};
      // Validate required fields
      const symbol = String(b.symbol || '').replace(/[^A-Z0-9.\-]/g, '').slice(0, 10).toUpperCase();
      const qty    = Number(b.qty);
      const side   = String(b.side || '').toLowerCase();
      const type   = String(b.type || 'market').toLowerCase();
      const tif    = String(b.time_in_force || 'day').toLowerCase();

      if (!symbol || !qty || !['buy','sell'].includes(side)) {
        return res.status(400).json({ error: 'symbol, qty, and side (buy/sell) are required' });
      }
      // Only allow market orders for kill switch emergency exit
      const allowedTypes = ['limit', 'market'];
      if (!allowedTypes.includes(type)) {
        return res.status(400).json({ error: `Order type '${type}' not allowed` });
      }

      const orderBody = {
        symbol,
        qty,
        side,
        type,
        time_in_force: tif,
        ...(type === 'limit' && b.limit_price != null ? { limit_price: String(b.limit_price) } : {}),
        ...(b.client_order_id ? { client_order_id: String(b.client_order_id).slice(0, 48) } : {}),
      };
      console.log(`[alpaca] Placing ${type} ${side} order: ${qty}x ${symbol}`);
      const r = await alpacaRequest({ ...ctx, method: 'POST', path: '/v2/orders', body: orderBody });
      return res.status(r.status).json(r.body);
    }

    // ── GET portfolio history ────────────────────────────────────────────────
    if (action === 'history' && req.method === 'GET') {
      const period    = String(req.query.period    || '1M').replace(/[^0-9A-Za-z]/g, '').slice(0, 4);
      const timeframe = String(req.query.timeframe || '1D').replace(/[^0-9A-Za-z]/g, '').slice(0, 4);
      const path = `/v2/account/portfolio/history?period=${encodeURIComponent(period)}&timeframe=${encodeURIComponent(timeframe)}&extended_hours=false`;
      const r = await alpacaRequest({ ...ctx, method: 'GET', path });
      return res.status(r.status).json(r.body);
    }

    // ── GET account (connection check) ──────────────────────────────────────
    if (action === 'account' || (req.method === 'GET' && !action)) {
      const r = await alpacaRequest({ ...ctx, method: 'GET', path: '/v2/account' });
      if (r.status === 200 && r.body?.status) {
        return res.status(200).json({
          connected: true,
          balance: r.body.portfolio_value,
          buyingPower: r.body.buying_power,
          cash: r.body.cash,
          status: r.body.status,
        });
      }
      return res.status(r.status).json({ connected: false, error: 'Alpaca auth failed' });
    }

    // ── GET P&L attribution ─────────────────────────────────────────────────
    if (action === 'attribution' && req.method === 'GET') {
      // Return cached result if fresh (< 10 min)
      if (_attributionCache && (Date.now() - _attributionCache.ts) < ATTRIBUTION_CACHE_TTL) {
        return res.status(200).json(_attributionCache.data);
      }

      // Hard 8 s timeout — return empty attribution rather than 504
      const attributionWork = (async () => {
        const after7 = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

        // Give Alpaca orders fetch 4 s; if it misses, return empty gracefully
        const ordersFetch = Promise.race([
          alpacaRequest({
            ...ctx, method: 'GET',
            path: `/v2/orders?status=closed&limit=50&after=${encodeURIComponent(after7)}`,
          }),
          new Promise(resolve => setTimeout(() => resolve({ status: 408, body: [] }), 4000)),
        ]);

        const r = await ordersFetch;
        if (r.status !== 200) return { ...ATTRIBUTION_EMPTY };

        const orders = Array.isArray(r.body) ? r.body : [];
        // Keep only filled NZR-tagged orders
        const nzr = orders.filter(o =>
          o.client_order_id?.startsWith('NZR-') && parseFloat(o.filled_qty || 0) > 0
        );

      const orders = Array.isArray(r.body) ? r.body : [];
      // Keep only filled NZR-tagged orders
      const nzr = orders.filter(o =>
        o.client_order_id?.startsWith('NZR-') && parseFloat(o.filled_qty || 0) > 0
      );

      // Parse tag: NZR-{MODE}-{STRATEGY}-{SIGNAL}-{SYMBOL}-{TS}  (new, 6 parts)
      //            NZR-{mode}-{symbol}-{ts}                       (old, 4 parts)
      function parseTag(cid) {
        const p = cid.split('-');
        if (p.length >= 6) {
          return { mode: p[1], strategy: p[2], signal: p[3] };
        }
        // Old format: derive mode from part[1], strategy/signal unknown
        return { mode: (p[1] || 'UNKNOWN').toUpperCase(), strategy: 'UNKNOWN', signal: 'UNKNOWN' };
      }

      // ET minute-of-day helper (DST-aware)
      function etMinOfDay(isoStr) {
        if (!isoStr) return -1;
        const d = new Date(isoStr);
        const yr = d.getUTCFullYear();
        const mar1 = new Date(Date.UTC(yr, 2, 1));
        const dstStart = new Date(Date.UTC(yr, 2, 8 + (7 - mar1.getUTCDay()) % 7, 7));
        const nov1 = new Date(Date.UTC(yr, 10, 1));
        const dstEnd   = new Date(Date.UTC(yr, 10, 1 + (7 - nov1.getUTCDay())  % 7, 6));
        const offsetH  = (d >= dstStart && d < dstEnd) ? 4 : 5;
        return ((d.getUTCHours() - offsetH + 24) % 24) * 60 + d.getUTCMinutes();
      }

      function sessionLabel(isoStr) {
        const m = etMinOfDay(isoStr);
        if (m >= 570 && m < 690) return 'Morning 9:30–11:30';   // 9:30–11:30
        if (m >= 690 && m < 810) return 'Midday 11:30–1:30';    // 11:30–13:30
        if (m >= 810 && m < 930) return 'Afternoon 1:30–3:30';  // 13:30–15:30
        return 'Other';
      }

      const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

      // Match sell orders to prior buy orders by symbol to estimate P&L
      const tagged = nzr.map(o => ({
        ...parseTag(o.client_order_id),
        orderId:     o.id,
        symbol:      o.symbol,
        side:        o.side,
        qty:         parseFloat(o.filled_qty        || 0),
        fillPrice:   parseFloat(o.filled_avg_price  || 0),
        submittedAt: o.submitted_at || o.created_at || '',
        filledAt:    o.filled_at    || o.submitted_at || '',
      }));

      const buys  = tagged.filter(o => o.side === 'buy'  && o.fillPrice > 0);
      const sells = tagged.filter(o => o.side === 'sell' && o.fillPrice > 0);

      const trades = [];
      for (const sell of sells) {
        // Find the most recent prior buy for the same symbol
        const buy = buys
          .filter(b => b.symbol === sell.symbol && b.submittedAt <= sell.submittedAt)
          .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
        if (!buy) continue;

        const pnlPct    = ((sell.fillPrice - buy.fillPrice) / buy.fillPrice) * 100;
        const pnl       = (sell.fillPrice - buy.fillPrice) * Math.min(sell.qty, buy.qty);
        const filledAt  = sell.filledAt;
        const mode      = sell.mode     !== 'UNKNOWN' ? sell.mode     : buy.mode;
        const strategy  = sell.strategy !== 'UNKNOWN' ? sell.strategy : buy.strategy;
        const signal    = sell.signal   !== 'UNKNOWN' ? sell.signal   : buy.signal;

        trades.push({
          symbol, pnl: parseFloat(pnl.toFixed(2)), pnlPct: parseFloat(pnlPct.toFixed(2)),
          win: pnl > 0, mode, strategy, signal,
          session: sessionLabel(filledAt),
          dow:     DOW[new Date(filledAt).getUTCDay()],
        });
      }

      // Group-by helper: aggregates trades by a string key field
      function groupBy(field) {
        const map = {};
        for (const t of trades) {
          const k = t[field] || 'UNKNOWN';
          if (!map[k]) map[k] = [];
          map[k].push(t);
        }
        return Object.entries(map).map(([label, ts]) => {
          const wins     = ts.filter(t => t.win).length;
          const totalPnl = ts.reduce((s, t) => s + t.pnl, 0);
          return {
            label,
            trades:   ts.length,
            wins,
            losses:   ts.length - wins,
            winRate:  parseFloat((wins / ts.length * 100).toFixed(1)),
            totalPnl: parseFloat(totalPnl.toFixed(2)),
            avgPnl:   parseFloat((totalPnl / ts.length).toFixed(2)),
          };
        }).sort((a, b) => b.totalPnl - a.totalPnl);
      }

        const totalWins = trades.filter(t => t.win).length;
        return {
          totalTrades:    trades.length,
          overallWinRate: trades.length ? parseFloat((totalWins / trades.length * 100).toFixed(1)) : 0,
          byStrategy:     groupBy('strategy'),
          bySignal:       groupBy('signal'),
          byTimeOfDay:    groupBy('session'),
          byDayOfWeek:    groupBy('dow'),
        };
      })(); // end attributionWork IIFE

      // Race attribution work against hard 8 s wall
      const data = await Promise.race([
        attributionWork,
        new Promise(resolve => setTimeout(() => resolve({ ...ATTRIBUTION_EMPTY, error: 'timeout' }), 8000)),
      ]);

      // Cache successful result
      if (!data.error) _attributionCache = { ts: Date.now(), data };

      return res.status(200).json(data);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });

  } catch (err) {
    console.error('[alpaca]', action, err.message);
    return res.status(500).json({ error: 'Alpaca connection failed', connected: false });
  }
};
