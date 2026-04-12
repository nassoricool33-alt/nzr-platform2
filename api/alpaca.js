/**
 * NZR — Alpaca Broker Proxy
 * All Alpaca API calls go through here so credentials never touch the browser.
 * Requires env vars: ALPACA_API_KEY, ALPACA_SECRET_KEY
 */

const ALLOWED_ORIGINS = ['https://nzr-platform2.vercel.app', 'http://localhost:3000'];

// Paper-trading base URL — never include /v2 here
const ALPACA_BASE_URL = 'https://paper-api.alpaca.markets';

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

/**
 * Core Alpaca fetch helper.
 * - Always uses the correct paper-trading base URL
 * - Always injects APCA-API-KEY-ID / APCA-API-SECRET-KEY headers
 * - Hard 6 s abort timeout
 * - Throws on non-2xx responses with the response body included in the message
 */
async function alpacaFetch(path, options = {}) {
  const url        = `${ALPACA_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
        'Content-Type':        'application/json',
        ...options.headers,
      },
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const errText = await res.text().catch(() => res.status);
      throw new Error(`Alpaca ${res.status}: ${errText}`);
    }
    // 204 No Content (cancel order) returns no body
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (e) {
    clearTimeout(timeout);
    throw e;
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

  const action = String(req.query.action || req.query.type || '').toLowerCase();

  // ── ?action=ping or ?type=ping — simplest possible health check ──────────
  // Also handles plain GET /api/alpaca with no params as the default response
  if (action === 'ping' || action === 'account' || (req.method === 'GET' && !action)) {
    if (!keyId || !secretKey) {
      return res.status(200).json({
        connected: false,
        error:     'Alpaca API keys not configured in environment',
        keyFound:    false,
        secretFound: false,
      });
    }
    try {
      const data = await alpacaFetch('/v2/account');
      return res.status(200).json({
        connected:      true,
        accountStatus:  data.status,
        buyingPower:    data.buying_power,
        portfolioValue: data.portfolio_value,
        // legacy fields kept for existing frontend code
        balance:        data.portfolio_value,
        cash:           data.cash,
        status:         data.status,
      });
    } catch (err) {
      console.error('[alpaca/ping]', err.message);
      return res.status(200).json({
        connected:   false,
        error:       err.message,
        keyFound:    !!keyId,
        secretFound: !!secretKey,
      });
    }
  }

  // All remaining routes require keys
  if (!keyId || !secretKey) {
    return res.status(503).json({ error: 'Alpaca keys not configured', connected: false });
  }

  try {
    // ── GET positions ─────────────────────────────────────────────────────────
    if (action === 'positions' && req.method === 'GET') {
      const data = await alpacaFetch('/v2/positions');
      return res.status(200).json(data);
    }

    // ── GET orders ────────────────────────────────────────────────────────────
    if (action === 'orders' && req.method === 'GET') {
      const status = String(req.query.status || 'open').replace(/[^a-z]/g, '');
      const after  = req.query.after || '';
      const limit  = Math.min(parseInt(req.query.limit || '500', 10), 500);
      let path = `/v2/orders?status=${encodeURIComponent(status)}&limit=${limit}`;
      if (after) path += `&after=${encodeURIComponent(after)}`;
      const data = await alpacaFetch(path);
      return res.status(200).json(data);
    }

    // ── DELETE cancel single order ────────────────────────────────────────────
    if (action === 'cancel' && req.method === 'DELETE') {
      const orderId = String(req.query.orderId || '').replace(/[^a-zA-Z0-9\-]/g, '');
      if (!orderId) return res.status(400).json({ error: 'orderId required' });
      try {
        await alpacaFetch(`/v2/orders/${orderId}`, { method: 'DELETE' });
      } catch (e) {
        // 404 = already cancelled/filled — treat as success
        if (!e.message.includes('404')) throw e;
      }
      return res.status(200).json({ cancelled: true });
    }

    // ── DELETE cancel all open orders ─────────────────────────────────────────
    if (action === 'cancelall' && req.method === 'DELETE') {
      try {
        await alpacaFetch('/v2/orders', { method: 'DELETE' });
      } catch (e) {
        if (!e.message.includes('404')) throw e;
      }
      return res.status(200).json({ cancelled: true });
    }

    // ── POST place order ──────────────────────────────────────────────────────
    if (action === 'order' && req.method === 'POST') {
      const b = req.body || {};
      const symbol = String(b.symbol || '').replace(/[^A-Z0-9.\-]/g, '').slice(0, 10).toUpperCase();
      const qty    = Number(b.qty);
      const side   = String(b.side || '').toLowerCase();
      const type   = String(b.type || 'market').toLowerCase();
      const tif    = String(b.time_in_force || 'day').toLowerCase();

      if (!symbol || !qty || !['buy', 'sell'].includes(side)) {
        return res.status(400).json({ error: 'symbol, qty, and side (buy/sell) are required' });
      }
      if (!['limit', 'market'].includes(type)) {
        return res.status(400).json({ error: `Order type '${type}' not allowed` });
      }

      const orderBody = {
        symbol, qty, side, type, time_in_force: tif,
        ...(type === 'limit' && b.limit_price != null ? { limit_price: String(b.limit_price) } : {}),
        ...(b.client_order_id ? { client_order_id: String(b.client_order_id).slice(0, 48) } : {}),
      };
      console.log(`[alpaca] Placing ${type} ${side} order: ${qty}x ${symbol}`);
      const data = await alpacaFetch('/v2/orders', { method: 'POST', body: JSON.stringify(orderBody) });
      return res.status(200).json(data);
    }

    // ── GET portfolio history ─────────────────────────────────────────────────
    if (action === 'history' && req.method === 'GET') {
      const period    = String(req.query.period    || '1M').replace(/[^0-9A-Za-z]/g, '').slice(0, 4);
      const timeframe = String(req.query.timeframe || '1D').replace(/[^0-9A-Za-z]/g, '').slice(0, 4);
      const data = await alpacaFetch(
        `/v2/account/portfolio/history?period=${encodeURIComponent(period)}&timeframe=${encodeURIComponent(timeframe)}&extended_hours=false`
      );
      return res.status(200).json(data);
    }

    // ── GET P&L attribution ───────────────────────────────────────────────────
    if (action === 'attribution' && req.method === 'GET') {
      // Return cached result if fresh
      if (_attributionCache && (Date.now() - _attributionCache.ts) < ATTRIBUTION_CACHE_TTL) {
        return res.status(200).json(_attributionCache.data);
      }

      // Race entire attribution work against 8 s hard timeout
      const attributionWork = (async () => {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        // Fetch both closed and all orders (to catch filled), 6s timeout each
        let orders = [];
        try {
          const [closedRaw, allRaw] = await Promise.all([
            Promise.race([
              alpacaFetch(`/v2/orders?status=closed&limit=100&after=${encodeURIComponent(thirtyDaysAgo)}`),
              new Promise((_, reject) => setTimeout(() => reject(new Error('closed_timeout')), 6000)),
            ]).catch(() => []),
            Promise.race([
              alpacaFetch(`/v2/orders?status=all&limit=100&after=${encodeURIComponent(thirtyDaysAgo)}`),
              new Promise((_, reject) => setTimeout(() => reject(new Error('all_timeout')), 6000)),
            ]).catch(() => []),
          ]);
          const closedOrders = Array.isArray(closedRaw) ? closedRaw : [];
          const allOrders = Array.isArray(allRaw) ? allRaw : [];
          // Merge and deduplicate by order id
          const seen = new Set();
          for (const o of [...closedOrders, ...allOrders]) {
            if (o && o.id && !seen.has(o.id)) {
              seen.add(o.id);
              orders.push(o);
            }
          }
        } catch {
          return { ...ATTRIBUTION_EMPTY };
        }

        // Keep only NZR-tagged orders with fills
        const nzr = orders.filter(o =>
          o.client_order_id?.startsWith('NZR-') && parseFloat(o.filled_qty || 0) > 0
        );
        console.log('[ATTRIBUTION] Found', orders.length, 'total orders,', nzr.length, 'NZR-tagged');

        // Parse tag: NZR-{MODE}-{STRATEGY}-{SIGNAL}-{SYMBOL}-{TS}  (new, 6 parts)
        //            NZR-{mode}-{symbol}-{ts}                       (old, 4 parts)
        function parseTag(cid) {
          const p = cid.split('-');
          if (p.length >= 6) return { mode: p[1], strategy: p[2], signal: p[3] };
          return { mode: (p[1] || 'UNKNOWN').toUpperCase(), strategy: 'UNKNOWN', signal: 'UNKNOWN' };
        }

        // DST-aware ET minute-of-day
        function etMinOfDay(isoStr) {
          if (!isoStr) return -1;
          const d = new Date(isoStr);
          const yr = d.getUTCFullYear();
          const mar1   = new Date(Date.UTC(yr, 2, 1));
          const dstStart = new Date(Date.UTC(yr, 2, 8 + (7 - mar1.getUTCDay()) % 7, 7));
          const nov1   = new Date(Date.UTC(yr, 10, 1));
          const dstEnd = new Date(Date.UTC(yr, 10, 1 + (7 - nov1.getUTCDay()) % 7, 6));
          const offsetH = (d >= dstStart && d < dstEnd) ? 4 : 5;
          return ((d.getUTCHours() - offsetH + 24) % 24) * 60 + d.getUTCMinutes();
        }

        function sessionLabel(isoStr) {
          const m = etMinOfDay(isoStr);
          if (m >= 570 && m < 690) return 'Morning 9:30–11:30';
          if (m >= 690 && m < 810) return 'Midday 11:30–1:30';
          if (m >= 810 && m < 930) return 'Afternoon 1:30–3:30';
          return 'Other';
        }

        const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

        const tagged = nzr.map(o => ({
          ...parseTag(o.client_order_id),
          orderId:     o.id,
          symbol:      o.symbol,
          side:        o.side,
          qty:         parseFloat(o.filled_qty       || 0),
          fillPrice:   parseFloat(o.filled_avg_price || 0),
          submittedAt: o.submitted_at || o.created_at || '',
          filledAt:    o.filled_at    || o.submitted_at || '',
        }));

        const buys  = tagged.filter(o => o.side === 'buy'  && o.fillPrice > 0);
        const sells = tagged.filter(o => o.side === 'sell' && o.fillPrice > 0);

        const trades = [];
        const matchedBuyIds = new Set();

        // Match sell orders to their corresponding buy orders
        for (const sell of sells) {
          const buy = buys
            .filter(b => b.symbol === sell.symbol && b.submittedAt <= sell.submittedAt)
            .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
          if (!buy) continue;

          matchedBuyIds.add(buy.orderId);
          const pnl    = (sell.fillPrice - buy.fillPrice) * Math.min(sell.qty, buy.qty);
          const pnlPct = ((sell.fillPrice - buy.fillPrice) / buy.fillPrice) * 100;
          trades.push({
            symbol:   sell.symbol,
            pnl:      parseFloat(pnl.toFixed(2)),
            pnlPct:   parseFloat(pnlPct.toFixed(2)),
            win:      pnl > 0,
            mode:     sell.mode     !== 'UNKNOWN' ? sell.mode     : buy.mode,
            strategy: sell.strategy !== 'UNKNOWN' ? sell.strategy : buy.strategy,
            signal:   sell.signal   !== 'UNKNOWN' ? sell.signal   : buy.signal,
            session:  sessionLabel(sell.filledAt),
            dow:      DOW[new Date(sell.filledAt).getUTCDay()],
          });
        }

        // Include unmatched buy orders as open positions (pnl = 0)
        for (const buy of buys) {
          if (matchedBuyIds.has(buy.orderId)) continue;
          trades.push({
            symbol:   buy.symbol,
            pnl:      0,
            pnlPct:   0,
            win:      false,
            mode:     buy.mode,
            strategy: buy.strategy,
            signal:   buy.signal,
            session:  sessionLabel(buy.filledAt),
            dow:      DOW[new Date(buy.filledAt).getUTCDay()],
            status:   'open',
          });
        }

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
      })();

      const data = await Promise.race([
        attributionWork,
        new Promise(resolve => setTimeout(() => resolve({ ...ATTRIBUTION_EMPTY, error: 'timeout' }), 8000)),
      ]);

      if (!data.error) _attributionCache = { ts: Date.now(), data };
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: `Unknown action: "${action}"` });

  } catch (err) {
    console.error('[alpaca]', action, err.message);
    return res.status(500).json({ error: 'Alpaca request failed', detail: err.message, connected: false });
  }
};
